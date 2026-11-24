$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$build = Join-Path $root "dist\offline-build"
$outPkg = Join-Path $build "california-package"
$plData = Join-Path $build "planetiler-data"
$classesDir = Join-Path $build "classes"
New-Item -ItemType Directory -Force -Path $outPkg,$plData,$classesDir | Out-Null

$pbf = Join-Path $build "california-latest.osm.pbf"
$planetiler = Join-Path $build "planetiler.jar"
$caScales = Join-Path $root "assets\ca-weigh-stations.json"

if (!(Test-Path $pbf)) { throw "Missing $pbf" }

Write-Host "=== Step 1: Generating driving-optimized california.pmtiles (z0..z14) ==="
$pmtilesOut = Join-Path $outPkg "california.pmtiles"
Push-Location $plData
& java -Xmx10g -jar $planetiler `
  --osm-path=$pbf `
  --output=$pmtilesOut `
  --download `
  --download_threads=8 `
  --only_layers=transportation,transportation_name,place,boundary,park,waterway `
  --force
Pop-Location
Write-Host "california.pmtiles:" ([math]::Round((Get-Item $pmtilesOut).Length / 1MB, 2)) "MB"

Write-Host "`n=== Step 2: Building All-of-California FTS4 search & POI database ==="
& javac -cp $planetiler -d $classesDir (Join-Path $PSScriptRoot "OsmSearchExtractor.java")
$tsvOut = Join-Path $build "california-search.tsv"
& java -Xmx8g -cp "$classesDir;$planetiler" OsmSearchExtractor $pbf $tsvOut CA

$searchDb = Join-Path $outPkg "california-search.db"
& node --experimental-sqlite (Join-Path $PSScriptRoot "build-search-db.mjs") `
  $tsvOut $searchDb --compact "--ca-scales=$caScales"

Write-Host "`n=== Step 3: Generating manifest.json with SHA-256 ==="
& node (Join-Path $PSScriptRoot "generate-manifest.mjs") `
  "2026.11-california" `
  "https://maps.routeweather.pages.dev" `
  $outPkg `
  (Join-Path $outPkg "manifest.json")

Write-Host "`n=== MEASURED ALL-OF-CALIFORNIA PACKAGE SIZES ==="
Get-ChildItem $outPkg | Select-Object Name,@{N='MB';E={[math]::Round($_.Length/1MB,2)}} | Format-Table -AutoSize
