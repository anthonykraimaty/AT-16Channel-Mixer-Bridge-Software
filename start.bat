@echo off
rem Starts the mixer bridge. Keep this window open while you use the mixer.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing, one moment...
  call npm install --omit=dev
)
node server\index.js
pause
