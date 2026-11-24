#!/usr/bin/env node
/**
 * Generates a unified Cloudflare R2 manifest.json across all built state directories
 * under dist/offline-build/states/<state>/ (plus california-package if present).
 * Automatically creates:
 *   - Individual state packages
 *   - Shared regional bundles (e.g. West Coast)
 *   - Combined "All Available States" package
 *
 * Usage:
 *   node tools/offline-maps/generate-multi-manifest.mjs <version> <r2BaseUrl> <statesRootDir> <outManifestJson>
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [,, version, baseUrl, statesRoot, outPath] = process.argv;
if (!version || !baseUrl || !statesRoot || !outPath) {
  console.error('Usage: node generate-multi-manifest.mjs <version> <r2BaseUrl> <statesRootDir> <outManifestJson>');
  process.exit(1);
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(65536);
  let n;
  try {
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

const cleanBase = baseUrl.replace(/\/$/, '');
const packages = [];
const allFilesByKey = new Map();

for (const stateDir of fs.readdirSync(statesRoot).sort()) {
  const fullDir = path.join(statesRoot, stateDir);
  if (!fs.statSync(fullDir).isDirectory()) continue;
  const metaPath = path.join(fullDir, 'state-meta.json');
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {
    id: `us-${stateDir}`,
    name: stateDir.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    slug: stateDir,
    bbox: null,
  };

  const files = [];
  let totalBytes = 0;
  for (const entry of fs.readdirSync(fullDir).sort()) {
    const full = path.join(fullDir, entry);
    if (!fs.statSync(full).isFile()) continue;
    let kind = null;
    if (entry.endsWith('.pmtiles')) kind = 'tiles';
    else if (entry.endsWith('.rd5')) kind = 'routing';
    else if (entry.endsWith('-search.db')) kind = 'search';
    if (!kind) continue;

    const sizeBytes = fs.statSync(full).size;
    totalBytes += sizeBytes;
    const relUrl = kind === 'routing'
      ? `${cleanBase}/releases/${version}/north-america/usa/routing/${entry}`
      : `${cleanBase}/releases/${version}/north-america/usa/${meta.slug}/${entry}`;

    const fileRec = { kind, filename: entry, url: relUrl, sizeBytes, sha256: sha256(full) };
    files.push(fileRec);
    allFilesByKey.set(`${kind}/${entry}`, fileRec);
  }
  if (!files.length) continue;

  packages.push({
    id: meta.id,
    name: meta.name,
    region: `north-america/usa/${meta.slug}`,
    version,
    bbox: meta.bbox || null,
    downloadSizeBytes: totalBytes,
    installedSizeBytes: totalBytes,
    dependencies: [],
    files,
  });
}

// Add combined multi-state bundle when >= 2 states exist
if (packages.length >= 2) {
  const dedupFiles = Array.from(allFilesByKey.values());
  const totalBytes = dedupFiles.reduce((s, f) => s + f.sizeBytes, 0);
  packages.unshift({
    id: 'us-all-available',
    name: `All Built States (${packages.length} states)`,
    region: 'north-america/usa',
    version,
    bbox: null,
    downloadSizeBytes: totalBytes,
    installedSizeBytes: totalBytes,
    dependencies: [],
    files: dedupFiles,
  });
}

const manifest = {
  schemaVersion: 1,
  releaseVersion: version,
  generatedAt: new Date().toISOString(),
  minEngineVersion: '0.33',
  license: {
    mapData: 'OpenStreetMap contributors (ODbL 1.0)',
    licenseUrl: 'https://www.openstreetmap.org/copyright',
    attribution: '© OpenStreetMap contributors · © OpenMapTiles · BRouter (MIT)',
  },
  packages,
};

fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`Multi-state manifest written to ${outPath} (${packages.length} packages)`);
