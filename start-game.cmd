@echo off
REM Double-click this to play. It starts the local scoring service if it is not
REM already up, waits for it to be ready, starts the game and opens a browser.
REM Uses the user-local Node in %USERPROFILE%\Programs\node: no admin rights,
REM no API key, no second terminal.
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

echo.
echo [1/2] Local scoring service
node scripts\start-local-judge.mjs
if errorlevel 1 (
  echo.
  echo The local scoring service could not be started - see above.
  echo The game would not be able to score answers, so stopping here.
  pause
  exit /b 1
)

REM Open the browser a moment after the game server has had time to bind.
start "" /min cmd /c "timeout /t 3 >nul & start "" http://localhost:3000"

echo.
echo [2/2] Game server - http://localhost:3000
echo Press Ctrl+C to stop the game. The scoring service keeps running so the
echo next start is fast; stop it with: npm run judge:stop
echo.
node server.js
