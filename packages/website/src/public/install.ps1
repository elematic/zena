# Standalone Windows installer for the Zena CLI (https://zena-lang.dev).
#
# Usage:
#   irm https://zena-lang.dev/install.ps1 | iex
#   $env:ZENA_VERSION = 'v0.0.1-preview.1'; irm https://zena-lang.dev/install.ps1 | iex

param(
  [string]$Version = $env:ZENA_VERSION,
  [switch]$Preview = ($env:ZENA_PREVIEW -eq '1'),
  [string]$InstallDir = $(if ($env:ZENA_INSTALL) { $env:ZENA_INSTALL } else { Join-Path $HOME '.zena' }),
  [switch]$NoModifyPath = ($env:ZENA_NO_MODIFY_PATH -eq '1')
)

$ErrorActionPreference = 'Stop'

function Install-Zena {
  $Repo = if ($env:ZENA_GITHUB_REPO) { $env:ZENA_GITHUB_REPO } else { 'elematic/zena' }
  $ApiBase = if ($env:ZENA_GITHUB_API_URL) { $env:ZENA_GITHUB_API_URL } else { "https://api.github.com/repos/$Repo" }
  $ReleaseBase = if ($env:ZENA_RELEASE_BASE_URL) { $env:ZENA_RELEASE_BASE_URL } else { "https://github.com/$Repo/releases/download" }

  $Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  if ($Arch -ne 'X64' -and $Arch -ne 'Arm64') {
    throw "Unsupported Windows architecture: $Arch"
  }
  $Target = 'x86_64-pc-windows-msvc'

  $Tag = $Version
  if ($Tag) {
    if (-not $Tag.StartsWith('v')) {
      $Tag = "v$Tag"
    }
  } else {
    $Headers = @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'zena-install-ps1' }
    if (-not $Preview) {
      try {
        $Latest = Invoke-RestMethod -Uri "$ApiBase/releases/latest" -Headers $Headers
        $Tag = $Latest.tag_name
      } catch {
        $Tag = $null
      }
    }
    if (-not $Tag) {
      $Releases = Invoke-RestMethod -Uri "$ApiBase/releases?per_page=1" -Headers $Headers
      if ($Releases -and $Releases.Count -gt 0) {
        $Tag = $Releases[0].tag_name
      }
    }
    if (-not $Tag) {
      throw "No published Zena releases were found at https://github.com/$Repo/releases"
    }
  }

  $Archive = "zena-$Tag-$Target.zip"
  $ArchiveUrl = "$ReleaseBase/$Tag/$Archive"
  $SumsUrl = "$ReleaseBase/$Tag/SHA256SUMS"

  $TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("zena-install-" + [System.Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $TmpDir | Out-Null

  try {
    $ArchivePath = Join-Path $TmpDir $Archive
    $SumsPath = Join-Path $TmpDir 'SHA256SUMS'

    Write-Host "Downloading Zena $Tag ($Target)..."
    Invoke-WebRequest -Uri $ArchiveUrl -OutFile $ArchivePath -UseBasicParsing
    Invoke-WebRequest -Uri $SumsUrl -OutFile $SumsPath -UseBasicParsing

    $ExpectedHash = $null
    foreach ($Line in (Get-Content -Path $SumsPath)) {
      $Parts = $Line.Trim() -split '\s+', 2
      if ($Parts.Length -eq 2 -and $Parts[1] -eq $Archive) {
        $ExpectedHash = $Parts[0].ToLowerInvariant()
        break
      }
    }
    if (-not $ExpectedHash) {
      throw "Checksum entry for $Archive was missing from SHA256SUMS"
    }

    $ActualHash = (Get-FileHash -Path $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualHash -ne $ExpectedHash) {
      throw "SHA-256 checksum mismatch for ${Archive}: expected $ExpectedHash, got $ActualHash"
    }

    $ExtractDir = Join-Path $TmpDir 'extract'
    Expand-Archive -Path $ArchivePath -DestinationPath $ExtractDir -Force

    $ZenaExe = Join-Path $ExtractDir 'zena.exe'
    if (-not (Test-Path $ZenaExe)) {
      throw "Downloaded archive $Archive did not contain zena.exe"
    }

    $BinDir = Join-Path $InstallDir 'bin'
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    Copy-Item -Path $ZenaExe -Destination (Join-Path $BinDir 'zena.exe') -Force

    $ZbExe = Join-Path $ExtractDir 'zb.exe'
    if (Test-Path $ZbExe) {
      Copy-Item -Path $ZbExe -Destination (Join-Path $BinDir 'zb.exe') -Force
    }

    Write-Host "Installed zena $Tag to $BinDir\zena.exe"

    $SessionPaths = $env:Path -split ';'
    if ($SessionPaths -notcontains $BinDir) {
      $env:Path = "$BinDir;$env:Path"
    }

    if (-not $NoModifyPath) {
      $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
      $UserPaths = if ($UserPath) { $UserPath -split ';' } else { @() }
      if ($UserPaths -notcontains $BinDir) {
        $NewUserPath = if ($UserPath) { "$BinDir;$UserPath" } else { $BinDir }
        [Environment]::SetEnvironmentVariable('Path', $NewUserPath, 'User')
        Write-Host "Added $BinDir to your User PATH."
      }
    } else {
      Write-Host "Add $BinDir to your PATH to run zena from new terminals."
    }
  } finally {
    if (Test-Path $TmpDir) {
      Remove-Item -Path $TmpDir -Recurse -Force
    }
  }
}

Install-Zena
