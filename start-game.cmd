@echo off
REM Double-click this to play. It uses the user-local Node in
REM %USERPROFILE%\Programs\node, so it needs no admin rights and no PATH setup.
setlocal
cd /d "%~dp0"

if exist "%USERPROFILE%\Programs\node\node.exe" (
  set "PATH=%USERPROFILE%\Programs\node;%PATH%"
)

where node >nul 2>&1
if errorlevel 1 (
  echo Could not find node. Expected it at %USERPROFILE%\Programs\node\node.exe
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-fund --no-audit || exit /b 1
)

REM Open the browser a moment after the server has had time to bind.
start "" /min cmd /c "timeout /t 3 >nul & start "" http://localhost:3000"

echo Starting the daily game on http://localhost:3000
echo Press Ctrl+C to stop.
node server.js
