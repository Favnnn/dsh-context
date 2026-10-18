# uninstall.ps1 - remove dsh-context from the web profile.
# ASCII-only source: Windows PowerShell 5.1 reads BOM-less files as ANSI.
#
# The plugin installs as a profile bundle, so the primary step is the
# harness's own removal (`pnpm dsh plugin --profile web remove dsh-context`)
# run from the harness checkout. Afterwards this package's packed tarballs in
# the profile's .artifacts directory are deleted pointwise (each by its own
# literal path), and a legacy register.sh install (`dsh plugin add .`, a link
# dependency) is cleared by the same official remove.

param(
  # Harness source checkout. Probed automatically when omitted.
  [string]$HarnessRoot = '',
  # Profile the bundle was installed into.
  [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'

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

# --- 1. The official removal -----------------------------------------------------
$Removed = $false
if ($null -ne $Harness) {
  Write-Host "Removing the bundle: pnpm dsh plugin --profile $Profile remove dsh-context"
  Push-Location $Harness
  try {
    & pnpm dsh plugin --profile $Profile remove dsh-context
    if ($LASTEXITCODE -eq 0) { $Removed = $true }
    else {
      Write-Host "dsh plugin remove reported exit code $LASTEXITCODE (not installed?)." -ForegroundColor Yellow
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Host 'Harness checkout not found; pass -HarnessRoot to remove the bundle via the CLI.' -ForegroundColor Yellow
}

# --- 2. Pointwise cleanup of this package's packed tarballs ------------------------
# Only after a successful remove: the manifest no longer references them. Each
# deletion names one literal path, never a wildcard delete.
if ($Removed) {
  $ArtifactsDir = Join-Path $DshHome "profiles/$Profile/.artifacts"
  if (Test-Path -LiteralPath $ArtifactsDir) {
    foreach ($Stale in @(Get-ChildItem -LiteralPath $ArtifactsDir -Filter '*.tgz' -File)) {
      if ($Stale.Name -like 'dsh-context-*.tgz') {
        Remove-Item -Force -LiteralPath $Stale.FullName
        Write-Host "Removed the artifact: $($Stale.FullName)"
      }
    }
  }
}

Write-Host ''
if ($Removed) {
  Write-Host 'dsh-context uninstalled. Restart the web server to apply.' -ForegroundColor Green
} else {
  Write-Host 'dsh-context was not removed (see the messages above).' -ForegroundColor Yellow
}
