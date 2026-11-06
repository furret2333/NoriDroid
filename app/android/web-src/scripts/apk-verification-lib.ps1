Set-StrictMode -Version Latest

function Get-NoriExpectedSigner {
    param([string]$Override)
    $digest = $Override
    if (-not $digest) {
        $policy = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'testing/apk-policy.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($policy.version -ne 1) { throw 'Unsupported APK signer policy version.' }
        $digest = [string]$policy.signerCertificateSha256
    }
    $digest = $digest.Replace(':', '').ToUpperInvariant()
    if ($digest -notmatch '^[0-9A-F]{64}$') { throw 'Expected signer must be a SHA-256 certificate digest.' }
    return $digest
}

function Assert-NoriApkSigner {
    param([Parameter(Mandatory)][string[]]$Fingerprints, [Parameter(Mandatory)][string]$Expected)
    if ($Fingerprints.Count -ne 1 -or $Fingerprints[0].ToUpperInvariant() -cne $Expected) {
        throw 'APK signer does not match the expected single certificate SHA-256.'
    }
}

function Get-NoriReleaseIdentity {
    param([Parameter(Mandatory)][string]$GradleFile)
    $text = [IO.File]::ReadAllText($GradleFile)
    $values = @{}
    foreach ($field in @('applicationId', 'versionName', 'versionCode')) {
        $pattern = if ($field -eq 'versionCode') { '(?m)^\s*versionCode\s+(\d+)\s*$' } else { '(?m)^\s*' + $field + '\s+["'']([^"'']+)["'']\s*$' }
        $matches = [regex]::Matches($text, $pattern)
        if ($matches.Count -ne 1) { throw "Cannot determine a single literal $field from $GradleFile; provide explicit expected identity." }
        $values[$field] = $matches[0].Groups[1].Value
    }
    return [pscustomobject]$values
}

function Find-NoriAndroidTools {
    param([string]$SdkPath, [Parameter(Mandatory)][string]$AndroidRoot)
    $candidates = @()
    if ($SdkPath) { $candidates = @($SdkPath) }
    else {
        $candidates += @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME)
        $properties = Join-Path $AndroidRoot 'local.properties'
        if (Test-Path -LiteralPath $properties -PathType Leaf) {
            $line = [IO.File]::ReadAllLines($properties) | Where-Object { $_ -match '^\s*sdk\.dir\s*=' } | Select-Object -Last 1
            if ($line) { $candidates += (($line -replace '^\s*sdk\.dir\s*=\s*', '').Replace('\:', ':').Replace('\\', '\')) }
        }
        if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
    }
    foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
        $buildTools = Join-Path $candidate 'build-tools'
        if (-not (Test-Path -LiteralPath $buildTools -PathType Container)) { continue }
        $versions = Get-ChildItem -LiteralPath $buildTools -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } | Sort-Object { [version]$_.Name } -Descending
        foreach ($version in $versions) {
            $aapt = Join-Path $version.FullName 'aapt.exe'
            $signer = Join-Path $version.FullName 'apksigner.bat'
            if ((Test-Path -LiteralPath $aapt -PathType Leaf) -and (Test-Path -LiteralPath $signer -PathType Leaf)) {
                return [pscustomobject]@{ Sdk = [IO.Path]::GetFullPath($candidate); Aapt = $aapt; ApkSigner = $signer; BuildTools = $version.Name }
            }
        }
    }
    throw 'Android aapt/apksigner not found. Set ANDROID_SDK_ROOT, ANDROID_HOME, sdk.dir, or -SdkPath to an installed SDK.'
}

function Get-NoriStreamHash {
    param([Parameter(Mandatory)][IO.Stream]$Stream)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($Stream)).Replace('-', '') }
    finally { $sha.Dispose() }
}

function Test-NoriApkWebAssets {
    param([Parameter(Mandatory)][string]$ApkPath, [Parameter(Mandatory)][string]$WebAssetsPath)
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $webRoot = (Resolve-Path -LiteralPath $WebAssetsPath).ProviderPath
    if (-not (Test-Path -LiteralPath (Join-Path $webRoot 'index.html') -PathType Leaf)) { throw "Missing built Web index.html: $webRoot" }
    $files = @(Get-ChildItem -LiteralPath $webRoot -Recurse -Force)
    if ($files | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Web assets must not contain symbolic links or junctions.' }
    $expected = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
    foreach ($file in ($files | Where-Object { -not $_.PSIsContainer })) {
        $relative = $file.FullName.Substring($webRoot.TrimEnd('\', '/').Length + 1).Replace('\', '/')
        $expected.Add($relative, $file.FullName)
    }
    $archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $ApkPath).ProviderPath)
    try {
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($entry in $archive.Entries) {
            if (-not $entry.FullName.StartsWith('assets/web/', [StringComparison]::Ordinal)) { continue }
            $relative = $entry.FullName.Substring(11)
            if (-not $entry.Name) { continue }
            if ($relative.Contains('\') -or @($relative.Split('/') | Where-Object { $_ -eq '.' -or $_ -eq '..' -or $_ -eq '' }).Count -gt 0) { throw "Noncanonical Web entry in APK: $($entry.FullName)" }
            if (-not $seen.Add($relative)) { throw "Duplicate Web entry in APK: $relative" }
            if (-not $expected.ContainsKey($relative)) { throw "Extra Web file in APK: $relative" }
            $packed = $entry.Open()
            $local = [IO.File]::OpenRead($expected[$relative])
            try {
                if ($entry.Length -ne $local.Length -or (Get-NoriStreamHash $packed) -ne (Get-NoriStreamHash $local)) { throw "Web content mismatch in APK: $relative" }
            } finally { $packed.Dispose(); $local.Dispose() }
        }
        foreach ($relative in $expected.Keys) {
            if (-not $seen.Contains($relative)) { throw "Missing Web file in APK: $relative" }
        }
        return $seen.Count
    } finally { $archive.Dispose() }
}

function Get-NoriApkIdentity {
    param([Parameter(Mandatory)][string]$Badging)
    $match = [regex]::Match($Badging, "(?m)^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'")
    if (-not $match.Success) { throw 'aapt did not return package name, versionCode and versionName.' }
    return [pscustomobject]@{ applicationId = $match.Groups[1].Value; versionCode = $match.Groups[2].Value; versionName = $match.Groups[3].Value }
}

function Assert-NoriApkIdentity {
    param([Parameter(Mandatory)]$Actual, [Parameter(Mandatory)]$Expected)
    foreach ($field in @('applicationId', 'versionCode', 'versionName')) {
        if ([string]$Actual.$field -cne [string]$Expected.$field) { throw "APK $field mismatch: expected $($Expected.$field), got $($Actual.$field)." }
    }
}
