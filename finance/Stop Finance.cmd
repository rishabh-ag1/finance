@echo off
rem Stops the Finance backend and frontend (the database keeps running).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-finance.ps1" -Stop
pause
