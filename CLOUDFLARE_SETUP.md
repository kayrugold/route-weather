# Route Weather — Cloudflare R2 Offline Map Distribution Setup

This document describes the Cloudflare R2 setup for distributing Route Weather's downloadable offline map packages without modifying existing Cloudflare Pages deployments, Workers, or TomTom bindings.

> **Important:** Do **not** proxy multi-hundred-megabyte map downloads through Cloudflare Workers (`cloud/index.mjs`). Android downloads map packages directly from R2's public custom domain (or `r2.dev`) using HTTP `Range` requests for pause/resume and zero egress fees.

## 1. Bucket Name & Verification
Proposed R2 Standard bucket:
- **Bucket name:** `routeweather-offline-maps`
- **Free tier (R2 Standard):** 10 GB-month storage, 1M Class A ops/mo, 10M Class B ops/mo, **$0 egress**.
- A complete Lower 48 package (~3.5–4.5 GB) fits comfortably inside R2's **10 GB free storage tier**.

Verify whether the bucket already exists before creating anything:
```bash
npx wrangler r2 bucket list
```

Create the bucket only after owner approval:
```bash
npx wrangler r2 bucket create routeweather-offline-maps
```

## 2. Proposed Object Layout in R2
```text
routeweather-offline-maps/
  offline-maps/
    manifest.json
    licenses/
      ODbL-1.0.txt
      BROUTER-MIT.txt
    releases/
      2026.11/
        manifest.json
        north-america/
          usa/
            us-overview.pmtiles
            california-norcal/
              norcal.pmtiles
              norcal-search.db
              W125_N35.rd5
              W125_N40.rd5
            california/
            oregon/
            washington/
            ...
          canada/
```

## 3. Public Access & HTTP Range Support
1. Attach a custom domain to `routeweather-offline-maps` in the Cloudflare Dashboard (e.g., `https://maps.routeweather.pages.dev` or `https://maps.andysdevstudio.com`).
2. R2 natively supports:
   - **HTTP `Range: bytes=N-`** (returns `206 Partial Content`, required by `OfflinePackageManager.java` for pause/resume and interrupted download recovery).
   - **ETag / `Cache-Control: public, max-age=31536000, immutable`** on versioned release files under `releases/<VERSION>/`.
   - Short cache (`Cache-Control: public, max-age=300`) on top-level `offline-maps/manifest.json`.

## 4. Uploading a Generated Release Package
After running `tools/offline-maps/build-norcal.ps1`:
```bash
npx wrangler r2 object put routeweather-offline-maps/offline-maps/releases/2026.11-norcal-proto/north-america/usa/california-norcal/norcal.pmtiles \
  --file dist/offline-build/norcal-package/norcal.pmtiles \
  --content-type application/vnd.pmtiles

npx wrangler r2 object put routeweather-offline-maps/offline-maps/releases/2026.11-norcal-proto/north-america/usa/california-norcal/norcal-search.db \
  --file dist/offline-build/norcal-package/norcal-search.db \
  --content-type application/vnd.sqlite3

npx wrangler r2 object put routeweather-offline-maps/offline-maps/releases/2026.11-norcal-proto/north-america/usa/california-norcal/W125_N35.rd5 \
  --file dist/offline-build/norcal-package/W125_N35.rd5 \
  --content-type application/octet-stream

npx wrangler r2 object put routeweather-offline-maps/offline-maps/releases/2026.11-norcal-proto/north-america/usa/california-norcal/W125_N40.rd5 \
  --file dist/offline-build/norcal-package/W125_N40.rd5 \
  --content-type application/octet-stream

npx wrangler r2 object put routeweather-offline-maps/offline-maps/manifest.json \
  --file dist/offline-build/norcal-package/manifest.json \
  --content-type application/json
```

## 5. Existing Worker Preservation
No changes were made to `cloudflare.config.ts`, `cloud/index.mjs`, `cloud/tomtom.mjs`, `cloud/quota.mjs`, or `cloud/road-reports.mjs`. All existing TomTom, Quota, and Road Reports Durable Object bindings remain untouched.
