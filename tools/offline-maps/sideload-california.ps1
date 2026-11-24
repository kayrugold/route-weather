$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$apk = Join-Path $root "android\app\build\outputs\apk\debug\app-debug.apk"
$pkg = Join-Path $root "dist\offline-build\california-package"
$adb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
$appId = "com.andysdevstudio.routeweather.debug"
$remoteBase = "/sdcard/Android/data/$appId/files/offline-maps"

Write-Host "Installing updated Route Weather Debug APK..."
& $adb install -r $apk

Write-Host "`nClearing prior NorCal files and staging All-of-California directories..."
& $adb shell "rm -rf $remoteBase/tiles/norcal.pmtiles $remoteBase/search/norcal-search.db && mkdir -p $remoteBase/tiles $remoteBase/routing $remoteBase/search"

Write-Host "`nPushing All-of-California offline package..."
& $adb push (Join-Path $pkg "california.pmtiles") "$remoteBase/tiles/california.pmtiles"
& $adb push (Join-Path $pkg "california-search.db") "$remoteBase/search/california-search.db"
foreach ($rd5 in (Get-ChildItem $pkg -Filter "*.rd5")) {
  & $adb push $rd5.FullName "$remoteBase/routing/$($rd5.Name)"
}

Write-Host "`nRelaunching Route Weather (Test)..."
& $adb shell "am force-stop $appId && am start -n $appId/com.andysdevstudio.routeweather.MainActivity"
Write-Host "Done! All of California is installed on device."
