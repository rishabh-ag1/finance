@echo off
rem Gets the latest code, installs packages, updates the database, then starts the Finance app.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-finance.ps1" -Update
pause
