@echo off
REM Avvia backend e frontend con doppio click, senza dover aprire PowerShell
REM a mano (vedi start.ps1 per i dettagli). -ExecutionPolicy Bypass vale solo
REM per questa esecuzione, non cambia le policy di sistema.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
pause
