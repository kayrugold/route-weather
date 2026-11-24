$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$build = Join-Path $root "dist\offline-build"
$outPkg = Join-Path $build "norcal-package"
New-Item -ItemType Directory -Force -Path $outPkg | Out-Null

$pbf = Join-Path $build "norcal-latest.osm.pbf"
$planetiler = Join-Path $build "planetiler.jar"
$brouterJar = Join-Path $root "android\app\libs\brouter-1.7.10-ro.jar"

if (!(Test-Path $pbf)) { throw "Missing $pbf" }
if (!(Test-Path $planetiler)) { throw "Missing $planetiler" }

Write-Host "=== Step 1: Generating driving-optimized norcal.pmtiles with Planetiler ==="
$pmtilesOut = Join-Path $outPkg "norcal.pmtiles"
$plData = Join-Path $build "planetiler-data"
New-Item -ItemType Directory -Force -Path $plData | Out-Null

Push-Location $plData
& java -Xmx8g -jar $planetiler `
  --osm-path=$pbf `
  --output=$pmtilesOut `
  --download `
  --download_threads=8 `
  --only_layers=transportation,transportation_name,place,boundary,park,waterway `
  --force
Pop-Location

Write-Host "norcal.pmtiles:" ([math]::Round((Get-Item $pmtilesOut).Length / 1MB, 2)) "MB"

Write-Host "`n=== Step 2: Extracting offline driving search index (norcal-search.db) ==="
$classesDir = Join-Path $build "classes"
New-Item -ItemType Directory -Force -Path $classesDir | Out-Null
& javac -cp $planetiler -d $classesDir (Join-Path $PSScriptRoot "OsmSearchExtractor.java")
$tsvOut = Join-Path $build "norcal-search.tsv"
& java -Xmx6g -cp "$classesDir;$planetiler" OsmSearchExtractor $pbf $tsvOut CA

$searchDb = Join-Path $outPkg "norcal-search.db"
& node --experimental-sqlite (Join-Path $PSScriptRoot "build-search-db.mjs") $tsvOut $searchDb

Write-Host "`n=== Step 3: Staging NorCal BRouter .rd5 segments (W125_N35, W125_N40) ==="
foreach ($seg in @("W125_N35.rd5", "W125_N40.rd5")) {
  $dest = Join-Path $outPkg $seg
  if (!(Test-Path $dest) -or (Get-Item $dest).Length -lt 100000) {
    Write-Host "Downloading $seg..."
    & curl.exe -L -sS -o $dest "https://brouter.de/brouter/segments4/$seg"
  }
  Write-Host "  $seg :" ([math]::Round((Get-Item $dest).Length / 1MB, 2)) "MB"
}

Write-Host "`n=== Step 4: Compiling & running VerifyOfflineEngine (Anderson, CA -> Stockton, CA) ==="
& javac -cp $brouterJar -d $classesDir `
  (Join-Path $root "android\app\src\main\com\andysdevstudio\routeweather\offline\PMTilesReader.java") `
  (Join-Path $PSScriptRoot "VerifyOfflineEngine.java")

& java -Xmx2g -cp "$classesDir;$brouterJar" VerifyOfflineEngine `
  $pmtilesOut $outPkg (Join-Path $root "assets\offline-profiles")

Write-Host "`n=== Step 5: Generating R2 manifest.json with SHA-256 checksums ==="
& node (Join-Path $PSScriptRoot "generate-manifest.mjs") `
  "2026.11-norcal-proto" `
  "https://maps.routeweather.pages.dev" `
  $outPkg `
  (Join-Path $outPkg "manifest.json")

Write-Host "`n=== MEASURED PACKAGE SIZES (Northern California) ==="
Get-ChildItem $outPkg | Select-Object Name,@{N='MB';E={[math]::Round($_.Length/1MB,2)}} | Format-Table -AutoSize
