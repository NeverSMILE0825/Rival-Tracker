@echo off
setlocal
cd /d "%~dp0"
title Rival Tracker

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 22 or newer is required to run Rival Tracker.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

netstat -ano | findstr ":4177" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo Rival Tracker is already running at http://127.0.0.1:4177
  start "" "http://127.0.0.1:4177"
  exit /b 0
)

echo Starting Rival Tracker at http://127.0.0.1:4177
echo Close this window to stop it.
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://127.0.0.1:4177"
node src\server.js
echo.
echo Tracker stopped.
pause
