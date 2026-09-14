#Requires -Version 5.1
<#
    Avvia backend (FastAPI/uvicorn) e frontend (Vite) in due finestre
    PowerShell separate, cosi' i log restano visibili e si possono
    fermare indipendentemente con Ctrl+C.

    Uso (dalla root del repo):
        .\start.ps1
#>

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

$venvPython = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Error "Virtualenv non trovato in .venv\Scripts\python.exe. Creane uno con: python -m venv .venv"
    exit 1
}

$backendEnv = Join-Path $root "backend\.env"
if (-not (Test-Path $backendEnv)) {
    Write-Warning "backend\.env non trovato: copialo da backend\.env.example e configuralo prima del sync Jira."
}

if (-not (Test-Path (Join-Path $root "frontend\node_modules"))) {
    Write-Warning "frontend\node_modules non trovato: eseguo 'npm install'..."
    Push-Location (Join-Path $root "frontend")
    npm install
    Pop-Location
}

Write-Host "Avvio backend (http://localhost:8000) ..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "Set-Location '$root\backend'; & '$venvPython' -m uvicorn app.main:app --reload --port 8000"
)

Write-Host "Avvio frontend (http://localhost:5174) ..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "Set-Location '$root\frontend'; npm run dev"
)

Start-Sleep -Seconds 2
Start-Process "http://localhost:5174"

Write-Host "Fatto. Backend e frontend girano in due finestre separate: chiudile (o Ctrl+C) per fermarli." -ForegroundColor Green
