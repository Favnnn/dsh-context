# install.ps1 - build dsh-context from this folder and install it into the web
# profile (dsh v0.2.0-rc.2) as a profile bundle.
#
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File install.ps1
#
# The ONLY supported install is the harness's own: this script builds lib\
# (tsdown), packs the npm-published file set (package.json's `files` allowlist)
# into a tarball and runs
#   pnpm dsh plugin --profile web add <that tarball>
# from the harness checkout. That registers the package as a profile bundle:
# the harness adds it to the profile manifest, installs a REAL COPY of the
# package into the profile's node_modules, and loads cordis.patch.yml from the
# bundle as an overlay row. The Plugins page then lists the plugin with the
# enable switch and the settings editor. Because the profile holds its own
# copy, this folder can be moved or deleted at any time without breaking the
# running plugin.
#
# Nothing is published to, and the plugin itself is never fetched from, the
# public registry: the tarball is packed from THIS folder, so the installed
# version is always this exact local build (pinned). Re-running this script
# after editing the source IS the console update path: rebuild, repack, re-add.
# Superseded tarballs are deleted pointwise (each by its own literal path,
# this package's artifacts only), never by a blind wildcard delete.
# ASCII-only source: Windows PowerShell 5.1 reads BOM-less files as ANSI.

param(
  # Harness source checkout (provides the dsh CLI). Probed automatically when omitted.
  [string]$HarnessRoot = '',
  # Profile to install into. The web app is this plugin's target.
  [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'

# --- Locate the delivery folder ------------------------------------------------
$PluginDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($PluginDir)) {
  throw 'install.ps1 must run as a saved script file (needs $PSScriptRoot).'
}

# --- Resolve the harness home ---------------------------------------------------
$DshHome = $env:DSH_HOME
if ([string]::IsNullOrEmpty($DshHome)) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }

# --- Locate the harness checkout -------------------------------------------------
$HarnessCandidates = @(
  $HarnessRoot,
  $env:DSH_ROOT,
  'C:\Deepseek-Harness\deepseek-harness-v0.2.0-rc.2',
  'C:\Deepseek-Harness\deepseek-harness'
) | Where-Object { -not [string]::IsNullOrEmpty($_) }

$Harness = $null
foreach ($Root in $HarnessCandidates) {
  if (Test-Path (Join-Path $Root 'apps/cli/package.json')) { $Harness = $Root; break }
}
if ($null -eq $Harness) {
  throw ("Harness checkout not found. Pass it explicitly: install.ps1 -HarnessRoot <path> " +
         "(looked in: $($HarnessCandidates -join '; ')).")
}
Write-Host "Harness checkout : $Harness"

# --- 1. The build toolchain -------------------------------------------------------
# tsdown (a devDependency) builds lib\. Without node_modules the build cannot
# run, so install the workspace's locked devDependencies first.
if (-not (Test-Path (Join-Path $PluginDir 'node_modules/tsdown/package.json'))) {
  Write-Host 'Installing devDependencies (pnpm install; one-time, per the locked pnpm-lock.yaml)...'
  Push-Location $PluginDir
  try {
    & pnpm install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed (exit code $LASTEXITCODE)." }
  } finally {
    Pop-Location
  }
}

# --- 2. Build lib\ from the current source ----------------------------------------
Write-Host 'Building lib\ (pnpm run build)...'
Push-Location $PluginDir
try {
  & pnpm run build
  if ($LASTEXITCODE -ne 0) { throw "pnpm run build failed (exit code $LASTEXITCODE)." }
} finally {
  Pop-Location
}
foreach ($Built in @('lib/index.js', 'lib/client.js', 'lib/index.d.ts')) {
  if (-not (Test-Path (Join-Path $PluginDir ($Built -replace '/', '\')))) {
    throw "Build output missing: $Built"
  }
}

# --- 3. Version and the profile's artifact bookkeeping ------------------------------
$Manifest = Get-Content (Join-Path $PluginDir 'package.json') -Raw | ConvertFrom-Json
$ArtifactName = '{0}-{1}.tgz' -f $Manifest.name, $Manifest.version
$ArtifactsDir = Join-Path $DshHome "profiles/$Profile/.artifacts"
New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null
$ArtifactPath = Join-Path $ArtifactsDir $ArtifactName

# What does the profile currently reference for this package?
$ProfileManifestPath = Join-Path $DshHome "profiles/$Profile/package.json"
$OldArtifact = $null
if (Test-Path -LiteralPath $ProfileManifestPath) {
  try {
    $OldDep = (Get-Content $ProfileManifestPath -Raw | ConvertFrom-Json).dependencies.($Manifest.name)
  } catch {
    $OldDep = $null
  }
  if ($OldDep -match '^file:(.+\.tgz)$') {
    $OldArtifact = [System.IO.Path]::GetFullPath($Matches[1])
  }
}

# A referenced-but-missing tarball would break the add's dependency
# resolution: clear the stale bundle first (official CLI, no manual edits).
# The row's Plugins-page settings die with that remove; the re-add restores
# defaults.
if ($null -ne $OldArtifact -and -not (Test-Path -LiteralPath $OldArtifact)) {
  Write-Host "The profile references a missing tarball ($([System.IO.Path]::GetFileName($OldArtifact))); clearing the stale bundle first."
  Write-Host 'This reset reverts the plugin''s settings on the Plugins page.' -ForegroundColor Yellow
  Push-Location $Harness
  try {
    & pnpm dsh plugin --profile $Profile remove $Manifest.name
    if ($LASTEXITCODE -ne 0) {
      Write-Host "dsh plugin remove reported exit code $LASTEXITCODE (continuing)." -ForegroundColor Yellow
    }
  } finally {
    Pop-Location
  }
  $OldArtifact = $null
}

# Pointwise pre-clean of the same-named artifact left by an earlier run: one
# exact path, recreated by the pack below before the add resolves dependencies.
if (Test-Path -LiteralPath $ArtifactPath) {
  Remove-Item -Force -LiteralPath $ArtifactPath
  Write-Host "Removed the stale same-version artifact: $ArtifactName"
}

# --- 4. Pack the `files` allowlist from this folder ---------------------------------
# pnpm pack re-runs the `prepare` script (husky && tsdown); without a .git husky
# exits 0 and tsdown rebuilds the same lib\ from the same sources, so the packed
# tree is the build above. The tarball lands in the profile's own .artifacts
# directory - the manifest records a file: reference to it, so it must stay put
# and is cleaned up pointwise after the add.
Write-Host ''
Push-Location $PluginDir
try {
  & pnpm pack --pack-destination $ArtifactsDir
  if ($LASTEXITCODE -ne 0) { throw "pnpm pack failed (exit code $LASTEXITCODE)." }
} finally {
  Pop-Location
}
if (-not (Test-Path -LiteralPath $ArtifactPath)) { throw "pnpm pack produced no $ArtifactName." }
$Bundle = Get-Item -LiteralPath $ArtifactPath
Write-Host "Packed the bundle: $($Bundle.FullName)"

# --- 5. The official install --------------------------------------------------------
Write-Host "Installing the bundle: pnpm dsh plugin --profile $Profile add `"$($Bundle.FullName)`""
Push-Location $Harness
try {
  & pnpm dsh plugin --profile $Profile add $Bundle.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "dsh plugin add failed (exit code $LASTEXITCODE)."
  }
} finally {
  Pop-Location
}

# --- 6. Pointwise cleanup of superseded artifacts ------------------------------------
# The add succeeded and the manifest points at the current artifact, which
# STAYS. Everything superseded goes one exact path at a time: the previously
# referenced tarball, then this package's other tarballs in .artifacts (each
# deleted by its own literal FullName, never a wildcard delete).
if ($null -ne $OldArtifact -and $OldArtifact -ne [System.IO.Path]::GetFullPath($ArtifactPath) -and (Test-Path -LiteralPath $OldArtifact)) {
  Remove-Item -Force -LiteralPath $OldArtifact
  Write-Host "Removed the superseded artifact: $($OldArtifact)"
}
foreach ($Stale in @(Get-ChildItem -LiteralPath $ArtifactsDir -Filter '*.tgz' -File)) {
  if ($Stale.Name -like ($Manifest.name + '-*.tgz') -and $Stale.FullName -ne [System.IO.Path]::GetFullPath($ArtifactPath)) {
    Remove-Item -Force -LiteralPath $Stale.FullName
    Write-Host "Removed the superseded artifact: $($Stale.FullName)"
  }
}
Write-Host "Kept the referenced artifact: $ArtifactPath"

Write-Host ''
Write-Host 'dsh-context installed as a profile bundle.' -ForegroundColor Green
Write-Host "  master folder : $PluginDir (pinned local build $ArtifactName)"
Write-Host "  profile copy  : $DshHome\profiles\$Profile\node_modules\dsh-context (refreshed by install.ps1)"
Write-Host "  artifact      : $ArtifactPath (referenced by the profile manifest; kept)"
Write-Host ''
Write-Host 'Restart "dsh web" (or "pnpm run web") if the harness was running. To update later,'
Write-Host 're-run install.ps1 - it rebuilds and re-installs this folder, never the npm registry.'
Write-Host 'To uninstall, run uninstall.ps1.'
