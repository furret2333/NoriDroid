$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'apk-verification-lib.ps1')
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixtureRoot = Join-Path $tempRoot ('nori-apk-check-' + [guid]::NewGuid().ToString('N'))
$passed = 0

function Assert-Check {
    param([string]$Name, [scriptblock]$Check)
    & $Check
    $script:passed++
    Write-Output "PASS $Name"
}
function Assert-Fails {
    param([scriptblock]$Check, [string]$Message)
    $caught = $false
    try { & $Check | Out-Null } catch { $caught = $true; if ($_.Exception.Message -notlike "*$Message*") { throw } }
    if (-not $caught) { throw "Expected failure containing: $Message" }
}
function Write-FixtureApk {
    param([string]$Name, [hashtable]$Entries)
    $file = Join-Path $fixtureRoot "$Name.apk"
    $archive = [IO.Compression.ZipFile]::Open($file, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($key in $Entries.Keys) {
            $stream = $archive.CreateEntry($key).Open()
            try {
                $bytes = [Text.Encoding]::UTF8.GetBytes($Entries[$key])
                $stream.Write($bytes, 0, $bytes.Length)
            } finally { $stream.Dispose() }
        }
    } finally { $archive.Dispose() }
    return $file
}

try {
    New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
    $web = Join-Path $fixtureRoot 'web'
    New-Item -ItemType Directory -Path (Join-Path $web 'assets') | Out-Null
    [IO.File]::WriteAllText((Join-Path $web 'index.html'), 'index', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $web 'assets/app.js'), 'app', [Text.UTF8Encoding]::new($false))
    Assert-Check 'exact Web file set and content pass without modifying inputs' {
        $hashInput = Join-Path $fixtureRoot 'hash-input.txt'
        [IO.File]::WriteAllText($hashInput, 'abc', [Text.UTF8Encoding]::new($false))
        if ((Get-NoriFileHash $hashInput) -cne 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD') { throw 'Incorrect file SHA-256' }
        $apk = Write-FixtureApk 'same' @{'assets/web/index.html'='index'; 'assets/web/assets/app.js'='app'; 'classes.dex'='irrelevant'}
        $hash = Get-NoriFileHash $apk
        if ((Test-NoriApkWebAssets $apk $web) -ne 2) { throw 'Expected two Web files' }
        if ((Get-NoriFileHash $apk) -ne $hash) { throw 'APK changed during check' }
    }
    Assert-Check 'changed Web content is rejected' {
        $apk = Write-FixtureApk 'changed' @{'assets/web/index.html'='index'; 'assets/web/assets/app.js'='bad'}
        Assert-Fails { Test-NoriApkWebAssets $apk $web } 'content mismatch'
    }
    Assert-Check 'missing Web file is rejected' {
        $apk = Write-FixtureApk 'missing' @{'assets/web/index.html'='index'}
        Assert-Fails { Test-NoriApkWebAssets $apk $web } 'Missing Web'
    }
    Assert-Check 'extra Web file is rejected' {
        $apk = Write-FixtureApk 'extra' @{'assets/web/index.html'='index'; 'assets/web/assets/app.js'='app'; 'assets/web/stale.js'='stale'}
        Assert-Fails { Test-NoriApkWebAssets $apk $web } 'Extra Web'
    }
    Assert-Check 'case mismatch is rejected' {
        $apk = Write-FixtureApk 'case' @{'assets/web/index.html'='index'; 'assets/web/assets/App.js'='app'}
        Assert-Fails { Test-NoriApkWebAssets $apk $web } 'Extra Web'
    }
    Assert-Check 'duplicate ZIP Web entry is rejected' {
        $apk = Join-Path $fixtureRoot 'duplicate.apk'
        $archive = [IO.Compression.ZipFile]::Open($apk, [IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($name in @('assets/web/index.html', 'assets/web/index.html')) {
                $stream = $archive.CreateEntry($name).Open()
                try { $bytes = [Text.Encoding]::UTF8.GetBytes('index'); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
            }
        } finally { $archive.Dispose() }
        Assert-Fails { Test-NoriApkWebAssets $apk $web } 'Duplicate Web'
    }
    Assert-Check 'noncanonical ZIP path is rejected' {
        $apk = Write-FixtureApk 'unsafe' @{'assets/web/../index.html'='index'}
        Assert-Fails { Test-NoriApkWebAssets $apk $web } 'Noncanonical'
    }
    Assert-Check 'package and versions must all match' {
        $expected = [pscustomobject]@{applicationId='com.example';versionCode='10';versionName='2.5.3'}
        $actual = Get-NoriApkIdentity "package: name='com.example' versionCode='10' versionName='2.5.3' platformBuildVersionName='14'"
        Assert-NoriApkIdentity $actual $expected
        foreach ($field in @('applicationId','versionCode','versionName')) {
            $copy = [pscustomobject]@{applicationId='com.example';versionCode='10';versionName='2.5.3'}
            $copy.$field = 'wrong'
            Assert-Fails { Assert-NoriApkIdentity $copy $expected } "$field mismatch"
        }
        Assert-Fails { Get-NoriApkIdentity 'invalid' } 'aapt did not return'
    }
    Assert-Check 'literal Gradle identity is parsed and ambiguous values fail' {
        $gradle = Join-Path $fixtureRoot 'build.gradle'
        [IO.File]::WriteAllText($gradle, "applicationId 'com.example'`nversionCode 10`nversionName '2.5.3'`n")
        $actual = Get-NoriReleaseIdentity $gradle
        if ($actual.applicationId -cne 'com.example' -or $actual.versionCode -ne '10' -or $actual.versionName -cne '2.5.3') { throw 'Wrong identity' }
        [IO.File]::AppendAllText($gradle, "versionName 'other'`n")
        Assert-Fails { Get-NoriReleaseIdentity $gradle } 'single literal versionName'
    }
    Assert-Check 'missing Android tools fail clearly' {
        Assert-Fails { Find-NoriAndroidTools -SdkPath (Join-Path $fixtureRoot 'absent-sdk') -AndroidRoot $fixtureRoot } 'not found'
    }
    Assert-Check 'default signer policy is pinned to the accepted certificate' {
        $pin = Get-NoriExpectedSigner
        if ($pin -cne '6A8BAEEDA8E866233955098ED791B09DAD30F02612BCD7CC0C30656548A3E91C') { throw 'Unexpected default signer identity.' }
        Assert-NoriApkSigner -Fingerprints @($pin.ToLowerInvariant()) -Expected $pin
    }
    Assert-Check 'wrong or additional signers and malformed pins are rejected' {
        $pin = Get-NoriExpectedSigner
        $wrong = '0' * 64
        Assert-Fails { Assert-NoriApkSigner -Fingerprints @($wrong) -Expected $pin } 'signer does not match'
        Assert-Fails { Assert-NoriApkSigner -Fingerprints @($pin, $wrong) -Expected $pin } 'signer does not match'
        Assert-Fails { Get-NoriExpectedSigner -Override 'invalid' } 'SHA-256'
    }
    Write-Output "$passed APK verification checks passed (temporary unsigned ZIP fixtures; no claim of signature verification)."
} finally {
    $resolved = [IO.Path]::GetFullPath($fixtureRoot)
    if ([IO.Path]::GetDirectoryName($resolved).TrimEnd('\') -cne $tempRoot.TrimEnd('\') -or -not [IO.Path]::GetFileName($resolved).StartsWith('nori-apk-check-')) { throw 'Refusing to remove an unchecked fixture path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
