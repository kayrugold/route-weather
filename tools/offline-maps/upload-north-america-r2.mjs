#!/usr/bin/env node
/**
 * Zero-dependency S3 Multipart uploader for Cloudflare R2 (handles files up to 5 TB).
 * Reads R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY from dist/.env.r2 (never logged or committed).
 * Automatically skips already-uploaded objects with matching byte size (idempotent/resumable).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ACCOUNT_ID = '59651ac82206f6ab6493e0e39f40162d';
const BUCKET = 'routeweather-offline-maps';
const ENDPOINT = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;
const R2_PUBLIC_BASE = 'https://pub-4389a2be46a544d1a2a9390b67835338.r2.dev/offline-maps';
const VERSION = '2026.11-north-america';
const PART_SIZE = 32 * 1024 * 1024; // 32 MiB parts

const root = path.resolve(import.meta.dirname, '..', '..');
const envPath = path.join(root, 'dist', '.env.r2');
const regionsDir = path.join(root, 'dist', 'offline-build', 'regions');

function loadEnv(file) {
  const vars = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

const env = loadEnv(envPath);
const ACCESS_KEY = env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || '';
const SECRET_KEY = env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || '';
if (!ACCESS_KEY || !SECRET_KEY) {
  console.error('Missing R2_ACCESS_KEY_ID or R2_SECRET_ACCESS_KEY in dist/.env.r2');
  process.exit(1);
}

const sha256Hex = buf => crypto.createHash('sha256').update(buf).digest('hex');
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();

function signRequest(method, keyPath, queryObj, headers, payloadHash) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = `${ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const canonicalUri = '/' + BUCKET + '/' + keyPath.split('/').map(encodeURIComponent).join('/');
  const sortedQuery = Object.keys(queryObj || {}).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryObj[k])}`).join('&');

  const hdrs = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...headers,
  };
  const lowerKeys = Object.keys(hdrs).map(k => k.toLowerCase()).sort();
  const canonicalHeaders = lowerKeys.map(k => `${k}:${String(hdrs[Object.keys(hdrs).find(x => x.toLowerCase() === k)]).trim()}\n`).join('');
  const signedHeaders = lowerKeys.join(';');
  const canonicalRequest = [method, canonicalUri, sortedQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + SECRET_KEY, dateStamp);
  const kRegion = hmac(kDate, 'auto');
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const url = `${ENDPOINT}${canonicalUri}${sortedQuery ? '?' + sortedQuery : ''}`;
  const finalHeaders = {
    ...headers,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  return { url, headers: finalHeaders };
}

async function s3Fetch(method, keyPath, queryObj, headers, bodyBuf) {
  const body = bodyBuf ?? Buffer.alloc(0);
  const payloadHash = body.length > 0 ? sha256Hex(body) : 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const req = signRequest(method, keyPath, queryObj, headers || {}, payloadHash);
  const res = await fetch(req.url, { method, headers: req.headers, body: method === 'GET' || method === 'HEAD' ? undefined : body });
  return res;
}

async function existsWithSize(keyPath, expectedSize) {
  const res = await s3Fetch('HEAD', keyPath);
  if (!res.ok) return false;
  return Number(res.headers.get('content-length')) === expectedSize;
}

async function uploadFile(filePath, keyPath, contentType, cacheControl) {
  const size = fs.statSync(filePath).size;
  if (await existsWithSize(keyPath, size)) {
    console.log(`  [skip] ${keyPath} (${(size / 1048576).toFixed(1)} MB already uploaded)`);
    return;
  }
  const extraHeaders = { 'content-type': contentType, 'cache-control': cacheControl };
  if (size <= PART_SIZE) {
    const buf = fs.readFileSync(filePath);
    const res = await s3Fetch('PUT', keyPath, null, extraHeaders, buf);
    if (!res.ok) throw Error(`PUT ${keyPath} failed: HTTP ${res.status} ${await res.text()}`);
    console.log(`  [done] ${keyPath} (${(size / 1048576).toFixed(1)} MB)`);
    return;
  }

  // S3 Multipart Upload for large files (> 32 MiB)
  const initRes = await s3Fetch('POST', keyPath, { uploads: '' }, extraHeaders);
  if (!initRes.ok) throw Error(`InitiateMultipart ${keyPath} failed: HTTP ${initRes.status} ${await initRes.text()}`);
  const initXml = await initRes.text();
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(initXml)?.[1];
  if (!uploadId) throw Error(`No UploadId returned for ${keyPath}`);

  const totalParts = Math.ceil(size / PART_SIZE);
  const fd = fs.openSync(filePath, 'r');
  const etags = [];
  try {
    for (let partNum = 1; partNum <= totalParts; partNum++) {
      const offset = (partNum - 1) * PART_SIZE;
      const len = Math.min(PART_SIZE, size - offset);
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, offset);
      let ok = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const res = await s3Fetch('PUT', keyPath, { partNumber: String(partNum), uploadId }, {}, buf);
        if (res.ok) {
          const etag = res.headers.get('etag');
          etags.push({ partNum, etag });
          ok = true;
          break;
        }
        if (attempt === 3) throw Error(`Part ${partNum}/${totalParts} of ${keyPath} failed: HTTP ${res.status}`);
      }
      if (partNum % 4 === 0 || partNum === totalParts) {
        process.stdout.write(`  [part] ${keyPath}: ${partNum}/${totalParts} (${((offset + len) / 1048576).toFixed(0)}/${(size / 1048576).toFixed(0)} MB)\n`);
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  const completeXml = '<CompleteMultipartUpload>' +
    etags.map(p => `<Part><PartNumber>${p.partNum}</PartNumber><ETag>${p.etag}</ETag></Part>`).join('') +
    '</CompleteMultipartUpload>';
  const compRes = await s3Fetch('POST', keyPath, { uploadId }, { 'content-type': 'application/xml' }, Buffer.from(completeXml, 'utf8'));
  if (!compRes.ok) throw Error(`CompleteMultipart ${keyPath} failed: HTTP ${compRes.status} ${await compRes.text()}`);
  console.log(`  [done] ${keyPath} (${(size / 1048576).toFixed(1)} MB)`);
}

// Collect deduplicated upload list from regions/manifest.json
const manifestPath = path.join(regionsDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
// Rename combined bundle cleanly to "All North America (USA + Canada + Mexico)"
for (const pkg of manifest.packages) {
  if (pkg.id === 'us-all-available') {
    pkg.id = 'north-america-all';
    pkg.name = 'All North America (USA 48 + Canada + Mexico)';
  }
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

const seenKeys = new Set();
const uploads = [];
for (const regionSlug of fs.readdirSync(regionsDir).sort()) {
  const dir = path.join(regionsDir, regionSlug);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const fname of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, fname);
    if (!fs.statSync(full).isFile()) continue;
    let key = null, ctype = 'application/octet-stream';
    if (fname.endsWith('.pmtiles')) {
      key = `offline-maps/releases/${VERSION}/north-america/usa/${regionSlug}/${fname}`;
      ctype = 'application/vnd.pmtiles';
    } else if (fname.endsWith('-search.db')) {
      key = `offline-maps/releases/${VERSION}/north-america/usa/${regionSlug}/${fname}`;
      ctype = 'application/vnd.sqlite3';
    } else if (fname.endsWith('.rd5')) {
      key = `offline-maps/releases/${VERSION}/north-america/usa/routing/${fname}`;
    }
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    uploads.push({ full, key, ctype, size: fs.statSync(full).size });
  }
}

const totalGb = uploads.reduce((s, u) => s + u.size, 0) / (1024 ** 3);
console.log(`Uploading ${uploads.length} North America files (${totalGb.toFixed(2)} GB) to R2 bucket ${BUCKET}...`);
for (const item of uploads) {
  await uploadFile(item.full, item.key, item.ctype, 'public, max-age=31536000, immutable');
}
await uploadFile(manifestPath, 'offline-maps/manifest.json', 'application/json', 'public, max-age=300');
console.log(`\nALL DONE! Live North America manifest: ${R2_PUBLIC_BASE}/manifest.json`);
