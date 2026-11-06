[CmdletBinding()]
param([string]$SdkPath, [string]$SignerSha256)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'apk-verification-lib.ps1')

try {
    $SignerSha256 = Get-NoriExpectedSigner -Override $SignerSha256
    $webRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $androidRoot = [IO.Path]::GetFullPath((Join-Path $webRoot '..'))
    # Resolve requirements before doing a potentially long build.
    $tools = Find-NoriAndroidTools -SdkPath $SdkPath -AndroidRoot $androidRoot
    $identity = Get-NoriReleaseIdentity (Join-Path $androidRoot 'app/build.gradle')
    # --offline controls Gradle dependencies, but the wrapper can still download
    # its distribution. Require that exact wrapper distribution to be cached.
    $wrapperText = [IO.File]::ReadAllText((Join-Path $androidRoot 'gradle/wrapper/gradle-wrapper.properties'))
    $distribution = [regex]::Match($wrapperText, '(?m)^distributionUrl=.*?/(gradle-([0-9.]+)-(?:bin|all))\.zip\s*$')
    if (-not $distribution.Success) { throw 'Cannot determine a supported release Gradle wrapper distribution.' }
    $gradleUserDir = if ($env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.gradle' }
    $cacheDir = Join-Path $gradleUserDir ('wrapper/dists/' + $distribution.Groups[1].Value)
    $cached = @(Get-ChildItem -LiteralPath $cacheDir -Directory -ErrorAction SilentlyContinue | Sort-Object Name | Where-Object {
        $distributionRoot = Join-Path $_.FullName ('gradle-' + $distribution.Groups[2].Value)
        (Test-Path -LiteralPath (Join-Path $distributionRoot 'bin/gradle.bat') -PathType Leaf) -and
        @(Get-ChildItem -LiteralPath $_.FullName -Filter '*.zip.ok' -File -ErrorAction SilentlyContinue).Count -gt 0
    })
    if ($cached.Count -eq 0) { throw 'The configured Gradle wrapper is not cached. Install the wrapper distribution before running this offline build.' }
    $gradle = Join-Path $cached[0].FullName ('gradle-' + $distribution.Groups[2].Value + '/bin/gradle.bat')
    $apk = Join-Path $androidRoot "app/build/outputs/apk/release/NoriDroid-$($identity.versionName)-release.apk"
    Push-Location $webRoot
    try {
        & pnpm build
        if ($LASTEXITCODE -ne 0) { throw "Web build failed (exit $LASTEXITCODE); Android packaging was not started." }
    } finally { Pop-Location }
    Push-Location $androidRoot
    try {
        & $gradle --offline --no-daemon assembleRelease
        if ($LASTEXITCODE -ne 0) { throw "Android packaging failed (exit $LASTEXITCODE); no successful package is reported." }
    } finally { Pop-Location }
    if (-not (Test-Path -LiteralPath $apk -PathType Leaf)) { throw "Expected release output missing: $apk" }
    & (Join-Path $PSScriptRoot 'verify-apk.ps1') -ApkPath $apk -SdkPath $tools.Sdk -SignerSha256 $SignerSha256
    if ($LASTEXITCODE -ne 0) { throw 'Built APK failed verification.' }
} catch {
    Write-Error "Verified build failed: $($_.Exception.Message)"
    exit 1
}
