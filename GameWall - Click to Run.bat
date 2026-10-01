@echo off
setlocal
cd /d "%~dp0"

rem GameWall alpha launcher: builds (first time or after changes), then starts GameWall
rem in the tray. It also starts itself with Windows from now on (turn that off from the
rem tray icon), so on game day you just plug in the laptop and use your phone.

set DISPLAY_DIST=dist\DisplayHost
set CONTROL_DIST=dist\ControlServer

where dotnet >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo GameWall needs the free .NET 8 SDK installed once to build itself.
  echo Opening the download page for you now...
  start https://dotnet.microsoft.com/download/dotnet/8.0
  echo.
  echo After installing, close this window and double-click this file again.
  pause
  exit /b 1
)

rem Stop a running copy so the new build can replace its files.
taskkill /im GameWallDisplayHost.exe /f >nul 2>nul

echo Building GameWall Display (the wall + tray app)...
dotnet publish GameWallDisplayHost\GameWallDisplayHost.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "%DISPLAY_DIST%"
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo Build failed - see the error above. Copy it and send it back for help.
  pause
  exit /b 1
)

echo Building the optional offline remote...
dotnet publish GameWallControlServer\GameWallControlServer.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "%CONTROL_DIST%"

echo.
echo Starting GameWall in the tray...
start "" "%DISPLAY_DIST%\GameWallDisplayHost.exe" --background

echo.
echo GameWall is running (look for its icon in the tray, bottom-right).
echo  - First run: a window shows a 6-digit code. On your phone open
echo    gameday-cfb.vercel.app, tap Wall, and enter the code.
echo  - From then on it starts with Windows and waits quietly in the tray.
echo  - Tray icon menu: Show the wall, End session, Pair a phone, Quit.
echo.
echo This window closes by itself in a few seconds.
timeout /t 6 /nobreak >nul
exit /b 0
