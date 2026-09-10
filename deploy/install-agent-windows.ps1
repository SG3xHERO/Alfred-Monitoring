# Alfred agent installer for Windows — run in an elevated PowerShell.
# Self-contained: downloads the agent exe from the Alfred server itself, no
# manual download required. Meant to be run straight from irm/iex, e.g.:
#   iex "& { $(irm https://monitor.example.com/agent/install.ps1) } -BackendUrl 'https://monitor.example.com' -ApiKey 'alf_xxx'"
#
# -Version is optional: omit it for a normal install, which pulls whatever
# build is currently baked into the frontend image (unversioned, always
# "current" — frontend/Dockerfile cross-compiles the agent on every deploy).
# Pass -Version to pin a specific admin-published release instead (see
# AGENT_RELEASES_DIR / the "Update agent" control in the device page) — used
# for admin-triggered update pushes, not needed for a first install.
param(
    [Parameter(Mandatory)][string]$BackendUrl,
    [Parameter(Mandatory)][string]$ApiKey,
    [string]$Version,
    [string]$BinarySource
)

$ErrorActionPreference = "Stop"
# PowerShell 7+ treats stderr from native exes as a terminating error when
# $ErrorActionPreference is "Stop". The agent prints to stderr for expected,
# non-fatal conditions (e.g. "service not installed" on first run), so those
# calls must run with a relaxed error preference or they'll abort the script.

$installDir = "C:\Program Files\AlfredAgent"
$configDir = "C:\ProgramData\AlfredAgent"

New-Item -ItemType Directory -Force $installDir | Out-Null
New-Item -ItemType Directory -Force $configDir | Out-Null

# Stop/uninstall any existing service so the binary can be replaced on
# re-runs/upgrades. These are expected to "fail" (e.g. not installed yet) on
# a first run, so treat their stderr output as non-fatal.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
try { & "$installDir\alfred-agent.exe" -service stop *>$null } catch {}
try { & "$installDir\alfred-agent.exe" -service uninstall *>$null } catch {}
$ErrorActionPreference = $prevEap

if (-not $BinarySource) {
    if ($Version) {
        $BinarySource = "$($BackendUrl.TrimEnd('/'))/agent/download/$Version/windows"
    } else {
        $BinarySource = "$($BackendUrl.TrimEnd('/'))/agent/alfred-agent.exe"
    }
}

if ($BinarySource -match '^https?://') {
    Write-Host "Downloading agent$(if ($Version) { " $Version" }) from $BinarySource ..."
    Invoke-WebRequest -Uri $BinarySource -OutFile "$installDir\alfred-agent.exe" -UseBasicParsing -Headers @{ "X-API-Key" = $ApiKey }
} else {
    Copy-Item $BinarySource "$installDir\alfred-agent.exe" -Force
}

$configPath = "$configDir\config.yaml"
# Always (re)write backend_url/api_key from the values passed to this script.
# This is an explicit "install with these credentials" action - if the config
# already exists (e.g. a previous run partially failed, or you're rotating the
# API key), silently keeping the old file would leave the agent authenticating
# with a stale key and it would never show up as online.
@"
backend_url: $BackendUrl
api_key: $ApiKey
interval_seconds: 15
checks:
  services: []
  processes: []
  eventlog_interval_seconds: 300
"@ | Set-Content -Path $configPath -Encoding UTF8

& "$installDir\alfred-agent.exe" -service install

# Admin-triggered self-update (see agent/internal/update) swaps the binary
# then exits the process on success — configure the SCM to restart the
# service on that exit so it comes back up running the new binary. Also
# covers a genuine crash the same way.
sc.exe failure alfred-agent reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null

& "$installDir\alfred-agent.exe" -service start
Get-Service alfred-agent
Write-Host "alfred-agent installed. Config: $configPath"