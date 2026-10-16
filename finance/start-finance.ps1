<#
.SYNOPSIS
  Starts the Finance app on this PC: the database (Postgres 17, port 5433), the backend
  (http://localhost:3100) and the frontend (http://localhost:5174), then opens the browser.

.EXAMPLE
  .\start-finance.ps1            # start everything
  .\start-finance.ps1 -Update    # first get the latest code, install packages, update the database, then start
  .\start-finance.ps1 -Stop      # stop the backend and frontend

  Or double-click "Start Finance.cmd" (start) / "Stop Finance.cmd" (stop) in this folder.
#>
param(
  [switch]$Update,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Backend = Join-Path $Root 'backend'
$Frontend = Join-Path $Root 'frontend'
$PgBin = 'C:\Program Files\PostgreSQL\17\bin'
$PgData = 'C:\Program Files\PostgreSQL\17\data'
$PgPort = 5433

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

function PortOwner([int]$port) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $c) { return $null }
  return $c.OwningProcess
}

function StopPort([int]$port, [string]$name) {
  $procId = PortOwner $port
  if ($null -eq $procId) { Say "  $name was not running." ; return }
  # Stop the whole process tree (npm -> node), so the port is freed.
  & taskkill /PID $procId /T /F | Out-Null
  Say "  Stopped $name (port $port)." 'Green'
}

if ($Stop) {
  Say 'Stopping the Finance app...' 'Cyan'
  StopPort 3100 'the backend'
  StopPort 5174 'the frontend'
  Say 'Done. The database keeps running (that is fine).' 'Cyan'
  return
}

Say '=== Finance app ===' 'Cyan'

# ---------- 1. Database ----------
Say '1. Database (Postgres 17, port 5433)'
$ready = & "$PgBin\pg_isready.exe" -p $PgPort 2>&1
if ($LASTEXITCODE -eq 0) {
  Say '  Already running.' 'Green'
} else {
  Say '  Not running: starting it...' 'Yellow'
  # Started detached (hidden window, own log) so this window is not tied to the server.
  $log = Join-Path $env:TEMP 'finance-postgres.log'
  try {
    Start-Process -FilePath "$PgBin\pg_ctl.exe" -ArgumentList 'start', '-D', "`"$PgData`"", '-l', "`"$log`"" -WindowStyle Hidden | Out-Null
  } catch {
    Say '  Could not start the database. Close this window, right-click "Start Finance.cmd" and choose "Run as administrator".' 'Red'
    Read-Host 'Press Enter to close'
    exit 1
  }
  for ($i = 0; $i -lt 30; $i++) {
    & "$PgBin\pg_isready.exe" -p $PgPort | Out-Null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 1
  }
  if ($LASTEXITCODE -ne 0) {
    Say "  The log is at $log" 'Yellow'
    Say '  The database did not start. Run this again as administrator.' 'Red'
    Read-Host 'Press Enter to close'
    exit 1
  }
  Say '  Started.' 'Green'
}

# ---------- 2. Optional update ----------
if ($Update) {
  Say '2. Getting the latest code and updating...'
  Push-Location $Root
  try {
    & git -C (Split-Path $Root -Parent) pull
    Say '  Installing backend packages...'
    & npm --prefix $Backend install --no-audit --no-fund
    Say '  Installing frontend packages...'
    & npm --prefix $Frontend install --no-audit --no-fund
    Say '  Updating the database tables (never removes data)...'
    & npm --prefix $Backend run db:sync
    Say '  Refreshing menu access for the founders (passwords are not touched)...'
    & npm --prefix $Backend run db:seed
  } finally {
    Pop-Location
  }
  Say '  Up to date. Sign out and back in if a new menu does not show.' 'Green'
} else {
  Say '2. Update skipped (run with -Update, or "Update and Start Finance.cmd", after new code is pushed).'
}

# ---------- 3. Backend and frontend, each in its own window ----------
Say '3. Backend (port 3100) and frontend (port 5174)'
if ($null -ne (PortOwner 3100)) {
  Say '  The backend is already running.' 'Green'
} else {
  Start-Process powershell -ArgumentList '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle = 'Finance backend (keep open)'; npm --prefix '$Backend' run dev" | Out-Null
  Say '  Backend starting in its own window (keep that window open).' 'Green'
}
if ($null -ne (PortOwner 5174)) {
  Say '  The frontend is already running.' 'Green'
} else {
  Start-Process powershell -ArgumentList '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle = 'Finance frontend (keep open)'; npm --prefix '$Frontend' run dev" | Out-Null
  Say '  Frontend starting in its own window (keep that window open).' 'Green'
}

# ---------- 4. Wait for the backend, then open the app ----------
Say '4. Waiting for the backend to answer...'
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:3100/api/health' -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { Start-Sleep -Seconds 2 }
}
if ($ok) {
  Say '  Backend is up.' 'Green'
} else {
  Say '  The backend has not answered after 2 minutes: look at the "Finance backend" window for the error.' 'Yellow'
}
Start-Process 'http://localhost:5174'
Say ''
Say 'The app is at http://localhost:5174 - sign in with your e-mail and password.' 'Cyan'
Say 'To stop: double-click "Stop Finance.cmd" (or close the two Finance windows).' 'Cyan'
Start-Sleep -Seconds 4
