#!/usr/bin/env node
/**
 * Generates a Cloudflare R2 offline map package manifest.json with SHA-256 checksums,
 * compressed & installed byte sizes, bounding coordinates, and license metadata.
 *
 * Usage:
 *   node tools/offline-maps/generate-manifest.mjs <releaseVersion> <r2BaseUrl> <packageDir> <outputManifestJson>
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [,, version, baseUrl, pkgDir, outPath] = process.argv;
if (!version || !baseUrl || !pkgDir || !outPath) {
  console.error('Usage: node generate-manifest.mjs <version> <r2BaseUrl> <packageDir> <outputManifestJson>');
  process.exit(1);
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(65536);
  let bytesRead;
  try {
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

const files = [];
let totalBytes = 0;

for (const entry of fs.readdirSync(pkgDir)) {
  const full = path.join(pkgDir, entry);
  if (!fs.statSync(full).isFile()) continue;
  let kind = null;
  if (entry.endsWith('.pmtiles')) kind = 'tiles';
  else if (entry.endsWith('.rd5')) kind = 'routing';
  else if (entry.endsWith('-search.db')) kind = 'search';
  if (!kind) continue;
  const sizeBytes = fs.statSync(full).size;
  totalBytes += sizeBytes;
  files.push({
    kind,
    filename: entry,
    url: `${baseUrl.replace(/\/$/, '')}/releases/${version}/north-america/usa/california-norcal/${entry}`,
    sizeBytes,
    sha256: sha256(full),
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
    attribution: '© OpenStreetMap contributors',
  },
  packages: [
    {
      id: 'us-ca-norcal',
      name: 'Northern California (Prototype)',
      region: 'north-america/usa/california',
      version,
      bbox: [-124.5, 36.8, -119.5, 42.1],
      downloadSizeBytes: totalBytes,
      installedSizeBytes: totalBytes,
      dependencies: [],
      files,
    },
  ],
};

fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`Manifest written to ${outPath} (${files.length} files, ${(totalBytes / 1048576).toFixed(2)} MB total)`);
