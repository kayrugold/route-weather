param(
  [string[]]$Regions = @("us-northeast", "us-west", "us-midwest", "us-south"),
  [int]$MaxZoom = 13,
  [string]$ReleaseVersion = "2026.11-usa48",
  [string]$R2BaseUrl = "https://pub-4389a2be46a544d1a2a9390b67835338.r2.dev/offline-maps"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$build = Join-Path $root "dist\offline-build"
$regionsRoot = Join-Path $build "regions"
$pbfDir = Join-Path $build "pbf"
$rd5Cache = Join-Path $build "rd5-cache"
$plData = Join-Path $build "planetiler-data"
$classesDir = Join-Path $build "classes"
$planetiler = Join-Path $build "planetiler.jar"
$caScales = Join-Path $root "assets\ca-weigh-stations.json"

New-Item -ItemType Directory -Force -Path $regionsRoot,$pbfDir,$rd5Cache,$plData,$classesDir | Out-Null
if (!(Test-Path $planetiler)) { throw "Missing $planetiler" }

# Geofabrik Continental US Regions (48 States + DC)
# [GeofabrikPath, DisplayName, MinLon, MinLat, MaxLon, MaxLat]
$regionTable = @{
  "us-northeast" = @("us-northeast-latest.osm.pbf", "US Northeast (ME, NH, VT, MA, RI, CT, NY, NJ, PA)",              -80.6, 38.9, -66.9, 47.5)
  "us-west"      = @("us-west-latest.osm.pbf",      "US West (WA, OR, CA, NV, ID, MT, WY, UT, CO, AZ, NM)",          -124.8, 31.3, -102.0, 49.1)
  "us-midwest"   = @("us-midwest-latest.osm.pbf",   "US Midwest (ND, SD, NE, KS, MN, IA, MO, WI, IL, MI, IN, OH)",   -104.1, 35.9,  -80.5, 49.4)
  "us-south"     = @("us-south-latest.osm.pbf",     "US South (TX, OK, AR, LA, MS, AL, TN, KY, GA, FL, SC, NC, VA, WV, MD, DE, DC)", -106.7, 24.5, -75.0, 39.7)
  "canada"       = @("canada-latest.osm.pbf",       "Canada (All Provinces & Territories)",                           -141.0, 41.7,  -52.6, 70.0)
  "mexico"       = @("mexico-latest.osm.pbf",       "Mexico (All States)",                                            -118.4, 14.5,  -86.7, 32.7)
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

& javac -cp $planetiler -d $classesDir (Join-Path $PSScriptRoot "OsmSearchExtractor.java")

$regionList = $Regions | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ }
foreach ($slug in $regionList) {
  if (!$regionTable.ContainsKey($slug)) { throw "Unknown region: $slug" }
  $info = $regionTable[$slug]
  $pbfName = $info[0]; $displayName = $info[1]
  $minLon = $info[2]; $minLat = $info[3]; $maxLon = $info[4]; $maxLat = $info[5]

  $outDir = Join-Path $regionsRoot $slug
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null

  Write-Host "`n============================================================"
  Write-Host "Building $displayName | maxzoom=$MaxZoom"
  Write-Host "============================================================"

  # 1. Download Geofabrik regional PBF
  $pbf = Join-Path $pbfDir $pbfName
  Write-Host "Downloading $pbfName from Geofabrik..."
  & curl.exe -L -C - -A "RouteWeatherMapBuilder/1.0" --connect-timeout 20 -sS -o $pbf `
    "https://download.geofabrik.de/north-america/$pbfName"
  Write-Host "PBF size:" ([math]::Round((Get-Item $pbf).Length / 1MB, 1)) "MB"

  # 2. Build driving-optimized PMTiles (z0..$MaxZoom)
  $pmtilesOut = Join-Path $outDir "$slug.pmtiles"
  Push-Location $plData
  & java -Xmx12g -jar $planetiler `
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
  & java -Xmx10g -cp "$classesDir;$planetiler" OsmSearchExtractor $pbf $tsvOut ""
  $searchDb = Join-Path $outDir "$slug-search.db"
  $extraArgs = @("--compact")
  if ($slug -eq "us-west" -and (Test-Path $caScales)) { $extraArgs += "--ca-scales=$caScales" }
  & node --experimental-sqlite (Join-Path $PSScriptRoot "build-search-db.mjs") $tsvOut $searchDb @extraArgs

  # 4. Stage BRouter .rd5 tiles for region bbox (skip missing ocean tiles cleanly)
  $rd5Tiles = Get-Rd5TilesForBbox $minLon $minLat $maxLon $maxLat
  foreach ($seg in $rd5Tiles) {
    $cached = Join-Path $rd5Cache $seg
    if (!(Test-Path $cached)) {
      Write-Host "Fetching $seg..."
      & curl.exe -f -L -sS -o $cached "https://brouter.de/brouter/segments4/$seg" 2>$null
      if ($LASTEXITCODE -ne 0 -and (Test-Path $cached)) { Remove-Item $cached -Force }
    }
    if ((Test-Path $cached) -and (Get-Item $cached).Length -gt 10000) {
      Copy-Item $cached (Join-Path $outDir $seg) -Force
    }
  }

  # 5. Write region metadata
  $meta = @{
    id = $slug
    name = $displayName
    slug = $slug
    bbox = @($minLon, $minLat, $maxLon, $maxLat)
  } | ConvertTo-Json
  Set-Content -Path (Join-Path $outDir "state-meta.json") -Value $meta

  Write-Host "`nMeasured files for ${slug}:"
  Get-ChildItem $outDir | Select-Object Name,@{N='MB';E={[math]::Round($_.Length/1MB,2)}} | Format-Table -AutoSize
}

& node (Join-Path $PSScriptRoot "generate-multi-manifest.mjs") `
  $ReleaseVersion $R2BaseUrl $regionsRoot (Join-Path $regionsRoot "manifest.json")
