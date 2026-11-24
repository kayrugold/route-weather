$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$apk = Join-Path $root "android\app\build\outputs\apk\debug\app-debug.apk"
$pkg = Join-Path $root "dist\offline-build\norcal-package"
$adb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
$appId = "com.andysdevstudio.routeweather.debug"
$remoteBase = "/sdcard/Android/data/$appId/files/offline-maps"

if (!(Test-Path $adb)) { throw "adb.exe not found at $adb" }
if (!(Test-Path $apk)) { throw "Debug APK not found at $apk. Build it first." }

Write-Host "Checking connected Android device..."
& $adb devices

Write-Host "`nInstalling Route Weather Debug APK..."
& $adb install -r $apk

Write-Host "`nCreating offline-maps directories on device..."
& $adb shell "mkdir -p $remoteBase/tiles $remoteBase/routing $remoteBase/search"

Write-Host "`nPushing Northern California offline package (350.65 MB)..."
& $adb push (Join-Path $pkg "norcal.pmtiles") "$remoteBase/tiles/norcal.pmtiles"
& $adb push (Join-Path $pkg "norcal-search.db") "$remoteBase/search/norcal-search.db"
& $adb push (Join-Path $pkg "W125_N35.rd5") "$remoteBase/routing/W125_N35.rd5"
& $adb push (Join-Path $pkg "W125_N40.rd5") "$remoteBase/routing/W125_N40.rd5"

Write-Host "`nLaunching Route Weather (Test)..."
& $adb shell "am start -n $appId/com.andysdevstudio.routeweather.MainActivity"
Write-Host "Done! Open Menu -> Offline maps & routing -> switch to Offline Only and test Anderson, CA -> Stockton, CA in Airplane Mode."
