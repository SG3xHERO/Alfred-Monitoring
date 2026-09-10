# Cross-compiles the agent for both platforms into agent/bin/<version>/.
# -Version embeds into the binary via ldflags (main.version) so a running
# agent reports the exact build it's running, and update pushes can tell
# builds apart. Defaults to "dev" for local/manual builds.
param(
    [string]$Version = "dev"
)
$ErrorActionPreference = "Stop"
Push-Location "$PSScriptRoot\..\agent"
try {
    $outDir = "bin/$Version"
    New-Item -ItemType Directory -Force $outDir | Out-Null
    $env:CGO_ENABLED = "0"
    $ldflags = "-s -w -X main.version=$Version"
    $env:GOOS = "linux";   $env:GOARCH = "amd64"
    go build -ldflags $ldflags -o "$outDir/alfred-agent" ./cmd/alfred-agent
    $env:GOOS = "windows"; $env:GOARCH = "amd64"
    go build -ldflags $ldflags -o "$outDir/alfred-agent.exe" ./cmd/alfred-agent
    Write-Host "Built $outDir/alfred-agent (linux) and $outDir/alfred-agent.exe (windows), version=$Version"
} finally {
    Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED -ErrorAction SilentlyContinue
    Pop-Location
}
