# Starts the MedForecast API (port 8000) and web app (port 3000) in separate windows.
#   .\start.ps1            normal start (sign-in required)
#   .\start.ps1 -NoAuth    sign-in disabled (development / demo without accounts)
param([switch]$NoAuth)

$root = $PSScriptRoot
if (-not (Test-Path "$root\ml\artifacts\forecast.csv")) {
    Write-Host "No trained artifacts found - training models first (about 1 minute on a GPU, 6-12 on CPU)..."
    Push-Location $root; python -m ml.train; Pop-Location
}
$authEnv = if ($NoAuth) { "`$env:MEDFORECAST_AUTH='0'; " } else { "" }
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; $authEnv python -m uvicorn backend.app:app --port 8000"
if (-not (Test-Path "$root\frontend\.next\BUILD_ID")) {
    Push-Location "$root\frontend"; npm run build; Pop-Location
}
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\frontend'; npm run start"

# Open the browser only once the API and website both answer; the API needs a few seconds to load
# the models, and pages opened earlier would show "500" errors from the not-yet-ready backend.
Write-Host "Waiting for the API and website to start..."
$deadline = (Get-Date).AddSeconds(120)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        $api = Invoke-WebRequest "http://localhost:8000/api/health" -UseBasicParsing -TimeoutSec 3
        $web = Invoke-WebRequest "http://localhost:3000/login" -UseBasicParsing -TimeoutSec 3
        # Also wait for the seasonal engine's background warm-up, so the first page view is fast.
        $warm = ($api.Content | ConvertFrom-Json).seasonal_ready
        if ($api.StatusCode -eq 200 -and $web.StatusCode -eq 200 -and $warm) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
}
if ($ready) { Write-Host "Ready: http://localhost:3000" } else { Write-Host "Still starting after 2 minutes - check the two server windows for errors." }
Start-Process "http://localhost:3000"
