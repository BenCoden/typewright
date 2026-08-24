<#
.SYNOPSIS
    Starts Typewright in Docker and opens it in a dedicated browser window.

.DESCRIPTION
    Brings up the docker compose stack, waits for the API to answer, then opens
    the app in Chrome or Edge using --app mode. App mode removes the tab strip
    and address bar, which also removes most of the browser shortcuts that would
    otherwise fire while typing (Ctrl+W, Ctrl+T, Ctrl+N).

.PARAMETER Port
    Host port the app is published on. Must match docker-compose.yml.

.PARAMETER Rebuild
    Rebuild the image before starting. Use after changing source files.

.PARAMETER NoBrowser
    Start the container but do not open a browser window.

.PARAMETER Stop
    Stop and remove the container, leaving ./data untouched.

.EXAMPLE
    .\Start-Typewright.ps1
    Starts the app and opens it in app mode.

.EXAMPLE
    .\Start-Typewright.ps1 -Rebuild
    Rebuilds the image first, then starts.

.EXAMPLE
    .\Start-Typewright.ps1 -Stop
    Shuts the app down.
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 5000,

    [switch]$Rebuild,

    [switch]$NoBrowser,

    [switch]$Stop
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root

try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Docker was not found on PATH. Start Docker Desktop and try again.'
    }

    if ($Stop) {
        Write-Host 'Stopping Typewright...' -ForegroundColor Cyan
        docker compose down
        Write-Host 'Stopped. Your library in .\data is untouched.' -ForegroundColor Green
        return
    }

    $composeArgs = @('compose', 'up', '-d')
    if ($Rebuild) { $composeArgs += '--build' }

    Write-Host 'Starting Typewright...' -ForegroundColor Cyan
    & docker @composeArgs
    if ($LASTEXITCODE -ne 0) { throw "docker compose exited with $LASTEXITCODE." }

    $url = "http://localhost:$Port"
    Write-Host -NoNewline 'Waiting for the app'

    $ready = $false
    foreach ($attempt in 1..40) {
        try {
            $response = Invoke-WebRequest -Uri "$url/api/settings" -TimeoutSec 2 -UseBasicParsing
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        }
        catch {
            Start-Sleep -Milliseconds 750
            Write-Host -NoNewline '.'
        }
    }
    Write-Host ''

    if (-not $ready) {
        Write-Warning "The app did not answer on $url. Check logs with: docker compose logs -f"
        return
    }

    Write-Host "Ready at $url" -ForegroundColor Green

    if ($NoBrowser) { return }

    # Prefer a dedicated app window over a browser tab.
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    )

    $browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

    if ($browser) {
        Start-Process -FilePath $browser -ArgumentList "--app=$url"
    }
    else {
        Write-Host 'Chrome or Edge not found — opening your default browser instead.'
        Start-Process $url
    }
}
finally {
    Pop-Location
}
