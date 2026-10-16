@echo off
rem Starts the Finance app: database, backend, frontend, then opens the browser.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-finance.ps1"
