$ErrorActionPreference = "Stop"

Write-Host "SOVARA Studio GREENFIELD OpenCode setup check"
Write-Host "---------------------------------------------"

if (-not (Test-Path ".sovara-studio-root")) {
    Write-Error "Missing .sovara-studio-root. Run from SOVARA Studio root."
}

if (-not (Test-Path "opencode.json")) {
    Write-Error "Missing opencode.json."
}

if (-not (Test-Path ".opencode\agents\studio-plan.md")) {
    Write-Error "Missing studio-plan agent."
}

$config = Get-Content "opencode.json" -Raw | ConvertFrom-Json

if ($null -ne $config.permissions) {
    Write-Error "Found V2 field 'permissions'. This pack must use V1 'permission'."
}

if ($null -eq $config.permission) {
    Write-Error "Missing V1 field 'permission'."
}

$current = (Get-Location).Path
Write-Host "Workspace : $current"

if ($current -match "SOVARA Widgets") {
    Write-Error "WRONG WORKSPACE: SOVARA Widgets"
}

$gitRoot = git rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -eq 0 -and $gitRoot) {
    Write-Host "Git mode  : AVAILABLE"
    Write-Host "Git root  : $($gitRoot.Trim())"
} else {
    Write-Host "Git mode  : NOT AVAILABLE (allowed)"
}

Write-Host ""
Write-Host "OK: V1 config"
Write-Host "OK: Studio marker"
Write-Host "OK: greenfield pack"
Write-Host ""
Write-Host "Restart OpenCode and send SEND_THIS_FIRST.txt"
