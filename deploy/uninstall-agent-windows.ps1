# Alfred agent uninstaller for Windows — run in an elevated PowerShell.
# Usage: .\uninstall-agent-windows.ps1
$ErrorActionPreference = "Stop"

$installDir = "C:\Program Files\AlfredAgent"
$configDir = "C:\ProgramData\AlfredAgent"
$exe = "$installDir\alfred-agent.exe"

if (Test-Path $exe) {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try { & $exe -service stop *>$null } catch {}
    try { & $exe -service uninstall *>$null } catch {}
    $ErrorActionPreference = $prevEap
} else {
    # Binary already gone but the service registration might still exist.
    try { Stop-Service alfred-agent -ErrorAction SilentlyContinue } catch {}
    try { sc.exe delete alfred-agent | Out-Null } catch {}
}

Remove-Item -Recurse -Force $installDir -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $configDir -ErrorAction SilentlyContinue
Write-Host "alfred-agent uninstalled and removed from $installDir / $configDir"
