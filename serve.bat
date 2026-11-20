@echo off
cd /d "%~dp0"
set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" (
  echo Node.js 22 or newer is required to run Rival Tracker.
  exit /b 1
)
if not exist "node_modules\" call "C:\Program Files\nodejs\npm.cmd" install
if not exist "data\" mkdir "data"

:loop
netstat -ano | findstr ":4177" | findstr "LISTENING" >nul
if not errorlevel 1 (
  ping -n 16 127.0.0.1 >nul
  goto loop
)
echo [%date% %time%] starting>> data\tracker-service.log
"%NODE%" src\server.js >> data\tracker-service.log 2>&1
echo [%date% %time%] stopped %errorlevel%>> data\tracker-service.log
ping -n 6 127.0.0.1 >nul
goto loop
