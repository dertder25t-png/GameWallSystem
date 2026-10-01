@echo off
rem Optional: the old local remote page, for when the internet is down.
rem Opens http://localhost:5050 on this laptop. Add --lan to allow phones on the Wi-Fi.
cd /d "%~dp0"
if not exist dist\ControlServer\GameWallControlServer.exe (
  echo Run "GameWall - Click to Run.bat" first to build GameWall.
  pause
  exit /b 1
)
start "GameWall Offline Remote" /D dist\ControlServer GameWallControlServer.exe
timeout /t 2 /nobreak >nul
start http://localhost:5050
