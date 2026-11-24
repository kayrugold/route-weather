param(
  [string[]]$States = @("oregon", "nevada"),
  [int]$MaxZoom = 13,
  [string]$ReleaseVersion = "2026.11-usa",
  [string]$R2BaseUrl = "https://maps.routeweather.pages.dev/offline-maps"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$build = Join-Path $root "dist\offline-build"
$statesRoot = Join-Path $build "states"
$pbfDir = Join-Path $build "pbf"
$rd5Cache = Join-Path $build "rd5-cache"
$plData = Join-Path $build "planetiler-data"
$classesDir = Join-Path $build "classes"
$planetiler = Join-Path $build "planetiler.jar"
$caScales = Join-Path $root "assets\ca-weigh-stations.json"

New-Item -ItemType Directory -Force -Path $statesRoot,$pbfDir,$rd5Cache,$plData,$classesDir | Out-Null
if (!(Test-Path $planetiler)) { throw "Missing $planetiler" }

# State metadata: [GeofabrikSlug, StateCode, DisplayName, MinLon, MinLat, MaxLon, MaxLat]
$stateTable = @{
  "oregon"     = @("oregon",     "OR", "Oregon",     -124.6, 41.9, -116.4, 46.3)
  "nevada"     = @("nevada",     "NV", "Nevada",     -120.1, 35.0, -114.0, 42.1)
  "washington" = @("washington", "WA", "Washington", -124.8, 45.5, -116.9, 49.1)
  "arizona"    = @("arizona",    "AZ", "Arizona",    -114.9, 31.3, -109.0, 37.1)
  "idaho"      = @("idaho",      "ID", "Idaho",      -117.3, 41.9, -111.0, 49.1)
  "utah"       = @("utah",       "UT", "Utah",       -114.1, 36.9, -109.0, 42.1)
  "california" = @("california", "CA", "California", -124.5, 32.5, -114.1, 42.1)
  "texas"      = @("texas",      "TX", "Texas",      -106.7, 25.8,  -93.5, 36.6)
  "colorado"   = @("colorado",   "CO", "Colorado",   -109.1, 36.9, -102.0, 41.1)
  "montana"    = @("montana",    "MT", "Montana",    -116.1, 44.3, -104.0, 49.1)
  "wyoming"    = @("wyoming",    "WY", "Wyoming",    -111.1, 40.9, -104.0, 45.1)
  "new-mexico" = @("new-mexico", "NM", "New Mexico", -109.1, 31.3, -103.0, 37.1)
}

function Get-Rd5TilesForBbox([double]$minLon, [double]$minLat, [double]$maxLon, [double]$maxLat) {
  $tiles = @()
  $x0 = [math]::Floor($minLon / 5.0) * 5
  $x1 = [math]::Floor($maxLon / 5.0) * 5
  $y0 = [math]::Floor($minLat / 5.0) * 5
  $y1 = [math]::Floor($maxLat / 5.0) * 5
  for ($x = $x0; $x -le $x1; $x += 5) {
    for ($y = $y0; $y -le $y1; $y += 5) {
      $ew = if ($x -lt 0) { "W" + [math]::Abs($x) } else { "E" + $x }
      $ns = if ($y -lt 0) { "S" + [math]::Abs($y) } else { "N" + $y }
      $tiles += "${ew}_${ns}.rd5"
    }
  }
  return $tiles
}

# Compile OsmSearchExtractor once
& javac -cp $planetiler -d $classesDir (Join-Path $PSScriptRoot "OsmSearchExtractor.java")

$stateList = $States | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ }
foreach ($slug in $stateList) {
  if (!$stateTable.ContainsKey($slug)) {
    throw "State '$slug' not in stateTable yet. Add its Geofabrik slug and bbox in build-states.ps1."
  }
  $info = $stateTable[$slug]
  $gfSlug = $info[0]; $code = $info[1]; $displayName = $info[2]
  $minLon = $info[3]; $minLat = $info[4]; $maxLon = $info[5]; $maxLat = $info[6]

  $outDir = Join-Path $statesRoot $slug
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null

  Write-Host "`n============================================================"
  Write-Host "Building $displayName ($code) | maxzoom=$MaxZoom"
  Write-Host "============================================================"

  # 1. Download Geofabrik PBF
  $pbf = Join-Path $pbfDir "$gfSlug-latest.osm.pbf"
  if (!(Test-Path $pbf) -or (Get-Item $pbf).Length -lt 1000000) {
    Write-Host "Downloading $gfSlug-latest.osm.pbf..."
    & curl.exe -L -C - -A "RouteWeatherMapBuilder/1.0" --connect-timeout 20 -sS -o $pbf `
      "https://download.geofabrik.de/north-america/us/$gfSlug-latest.osm.pbf"
  }
  Write-Host "PBF size:" ([math]::Round((Get-Item $pbf).Length / 1MB, 1)) "MB"

  # 2. Build driving-optimized PMTiles
  $pmtilesOut = Join-Path $outDir "$slug.pmtiles"
  Push-Location $plData
  & java -Xmx10g -jar $planetiler `
    --osm-path=$pbf `
    --output=$pmtilesOut `
    --maxzoom=$MaxZoom `
    --download `
    --download_threads=8 `
    --only_layers=transportation,transportation_name,place,boundary,park,waterway `
    --force
  Pop-Location
  Write-Host "$slug.pmtiles:" ([math]::Round((Get-Item $pmtilesOut).Length / 1MB, 2)) "MB"

  # 3. Build FTS4 Search & POI DB
  $tsvOut = Join-Path $build "$slug-search.tsv"
  & java -Xmx8g -cp "$classesDir;$planetiler" OsmSearchExtractor $pbf $tsvOut $code
  $searchDb = Join-Path $outDir "$slug-search.db"
  $extraArgs = @("--compact")
  if ($slug -eq "california" -and (Test-Path $caScales)) { $extraArgs += "--ca-scales=$caScales" }
  & node --experimental-sqlite (Join-Path $PSScriptRoot "build-search-db.mjs") $tsvOut $searchDb @extraArgs

  # 4. Stage BRouter .rd5 tiles for state bbox
  $rd5Tiles = Get-Rd5TilesForBbox $minLon $minLat $maxLon $maxLat
  foreach ($seg in $rd5Tiles) {
    $cached = Join-Path $rd5Cache $seg
    if (!(Test-Path $cached) -or (Get-Item $cached).Length -lt 10000) {
      # Reuse from california-package if already downloaded
      $caCopy = Join-Path $build "california-package\$seg"
      if (Test-Path $caCopy) {
        Copy-Item $caCopy $cached -Force
      } else {
        Write-Host "Downloading BRouter $seg..."
        & curl.exe -L -sS -o $cached "https://brouter.de/brouter/segments4/$seg"
      }
    }
    if ((Test-Path $cached) -and (Get-Item $cached).Length -gt 10000) {
      Copy-Item $cached (Join-Path $outDir $seg) -Force
    }
  }

  # 5. Write state-meta.json
  $meta = @{
    id = "us-$slug"
    name = $displayName
    slug = $slug
    code = $code
    bbox = @($minLon, $minLat, $maxLon, $maxLat)
  } | ConvertTo-Json
  Set-Content -Path (Join-Path $outDir "state-meta.json") -Value $meta

  Write-Host "`nMeasured files for ${displayName}:"
  Get-ChildItem $outDir | Select-Object Name,@{N='MB';E={[math]::Round($_.Length/1MB,2)}} | Format-Table -AutoSize
}

# Generate unified manifest.json across all built states
& node (Join-Path $PSScriptRoot "generate-multi-manifest.mjs") `
  $ReleaseVersion $R2BaseUrl $statesRoot (Join-Path $statesRoot "manifest.json")
