#!/usr/bin/env bash
set -euo pipefail
export PATH="/home/kayrugold/.nvm/versions/node/v22.20.0/bin:$PATH"

BUCKET="routeweather-offline-maps"
VERSION="2026.11-usa"
R2_BASE="https://pub-4389a2be46a544d1a2a9390b67835338.r2.dev/offline-maps"
ROOT="/mnt/c/Users/kayru_tolw96q/Desktop/route-weather"
STATES="$ROOT/dist/offline-build/states"

echo "=== 1. Setting CORS policy on $BUCKET ==="
CORS_FILE=$(mktemp)
cat > "$CORS_FILE" << 'EOF'
{
  "rules": [
    {
      "allowed": {
        "origins": ["*"],
        "methods": ["GET", "HEAD"],
        "headers": ["*"]
      },
      "exposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"],
      "maxAgeSeconds": 86400
    }
  ]
}
EOF
npx wrangler r2 bucket cors set "$BUCKET" --file "$CORS_FILE" -y
rm -f "$CORS_FILE"

echo "=== 2. Generating manifest.json for $R2_BASE ==="
node "$ROOT/tools/offline-maps/generate-multi-manifest.mjs" "$VERSION" "$R2_BASE" "$STATES" "$STATES/manifest.json"

echo "=== 3. Uploading state vector maps & search DBs to R2 (--remote) ==="
declare -A UPLOADED_RD5=()
for state_dir in "$STATES"/*/; do
  slug=$(basename "$state_dir")
  for f in "$state_dir"*.pmtiles "$state_dir"*-search.db; do
    [ -f "$f" ] || continue
    fname=$(basename "$f")
    ctype="application/octet-stream"
    [[ "$fname" == *.pmtiles ]] && ctype="application/vnd.pmtiles"
    [[ "$fname" == *.db ]] && ctype="application/vnd.sqlite3"
    key="offline-maps/releases/$VERSION/north-america/usa/$slug/$fname"
    echo "Uploading $key ..."
    npx wrangler r2 object put "$BUCKET/$key" --file "$f" --content-type "$ctype" --cache-control "public, max-age=31536000, immutable" --remote
  done
  for f in "$state_dir"*.rd5; do
    [ -f "$f" ] || continue
    fname=$(basename "$f")
    if [ -n "${UPLOADED_RD5[$fname]:-}" ]; then continue; fi
    UPLOADED_RD5[$fname]=1
    key="offline-maps/releases/$VERSION/north-america/usa/routing/$fname"
    echo "Uploading $key ..."
    npx wrangler r2 object put "$BUCKET/$key" --file "$f" --content-type "application/octet-stream" --cache-control "public, max-age=31536000, immutable" --remote
  done
done

echo "=== 4. Uploading manifest.json ==="
npx wrangler r2 object put "$BUCKET/offline-maps/manifest.json" --file "$STATES/manifest.json" --content-type "application/json" --cache-control "public, max-age=300" --remote

echo "=== DONE! Verify live manifest: $R2_BASE/manifest.json ==="
curl -sS "$R2_BASE/manifest.json" | head -n 25
