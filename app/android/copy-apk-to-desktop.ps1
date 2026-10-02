# 把最新编译出的 APK 复制到桌面
# 用法: 在 app/android 目录下执行  powershell -ExecutionPolicy Bypass -File copy-apk-to-desktop.ps1
# 或在任意位置: powershell -ExecutionPolicy Bypass -File <本脚本路径>

$ErrorActionPreference = "Stop"

$androidDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$apkDir = Join-Path $androidDir "app\build\outputs\apk\release"

if (-not (Test-Path $apkDir)) {
    Write-Host "未找到 APK 输出目录: $apkDir（请先执行 gradlew assembleRelease）" -ForegroundColor Yellow
    exit 1
}

$apk = Get-ChildItem -Path $apkDir -Filter "*.apk" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $apk) {
    Write-Host "APK 输出目录为空，请先编译" -ForegroundColor Yellow
    exit 1
}

$desktop = [Environment]::GetFolderPath("Desktop")
if (-not $desktop -or -not (Test-Path $desktop)) {
    $desktop = Join-Path $env:USERPROFILE "Desktop"
}
$dst = Join-Path $desktop $apk.Name

Copy-Item -Path $apk.FullName -Destination $dst -Force
Write-Host "已复制到桌面: $dst" -ForegroundColor Green
Write-Host "APK: $($apk.Name) · $([math]::Round($apk.Length / 1MB, 2)) MB · $($apk.LastWriteTime)"
