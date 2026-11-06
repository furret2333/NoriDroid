[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ApkPath,
    [string]$WebAssetsPath,
    [string]$SdkPath,
    [string]$ApplicationId,
    [string]$VersionCode,
    [string]$VersionName,
    [string]$SignerSha256
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'apk-verification-lib.ps1')

try {
    $SignerSha256 = Get-NoriExpectedSigner -Override $SignerSha256
    $androidRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    if (-not $WebAssetsPath) { $WebAssetsPath = Join-Path $androidRoot 'app/src/main/assets/web' }
    $apk = (Resolve-Path -LiteralPath $ApkPath).ProviderPath
    if (-not (Test-Path -LiteralPath $apk -PathType Leaf)) { throw "APK is not a file: $apk" }
    $expected = if ($ApplicationId -and $VersionCode -and $VersionName) {
        [pscustomobject]@{ applicationId = $ApplicationId; versionCode = $VersionCode; versionName = $VersionName }
    } else { Get-NoriReleaseIdentity (Join-Path $androidRoot 'app/build.gradle') }
    if ($ApplicationId) { $expected.applicationId = $ApplicationId }
    if ($VersionCode) { $expected.versionCode = $VersionCode }
    if ($VersionName) { $expected.versionName = $VersionName }
    $tools = Find-NoriAndroidTools -SdkPath $SdkPath -AndroidRoot $androidRoot
    $webCount = Test-NoriApkWebAssets -ApkPath $apk -WebAssetsPath $WebAssetsPath
    $badging = @(& $tools.Aapt dump badging $apk 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "aapt rejected the APK (exit $LASTEXITCODE)." }
    $identity = Get-NoriApkIdentity ($badging -join "`n")
    Assert-NoriApkIdentity -Actual $identity -Expected $expected
    $signature = @(& $tools.ApkSigner verify --verbose --print-certs $apk 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "apksigner verification failed (exit $LASTEXITCODE)." }
    $signatureText = $signature -join "`n"
    $fingerprints = @([regex]::Matches($signatureText, '(?m)^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]{64})\s*$') | ForEach-Object { $_.Groups[1].Value.ToUpperInvariant() })
    if ($fingerprints.Count -eq 0) { throw 'apksigner verified but returned no signer SHA-256 certificate digest.' }
    Assert-NoriApkSigner -Fingerprints $fingerprints -Expected $SignerSha256
    [pscustomobject]@{
        ok = $true
        apk = $apk
        bytes = (Get-Item -LiteralPath $apk).Length
        sha256 = Get-NoriFileHash $apk
        applicationId = $identity.applicationId
        versionCode = $identity.versionCode
        versionName = $identity.versionName
        webFiles = $webCount
        signatureVerified = $true
        signerCertificateSha256 = $fingerprints
        signerPinned = [bool]$SignerSha256
        buildTools = $tools.BuildTools
    } | ConvertTo-Json -Depth 3
} catch {
    Write-Error "APK verification failed: $($_.Exception.Message)"
    exit 1
}
