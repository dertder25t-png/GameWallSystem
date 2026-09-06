@echo off
setlocal
cd /d "%~dp0"

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

echo Building or updating GameWall Display...
dotnet publish GameWallDisplayHost\GameWallDisplayHost.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "%DISPLAY_DIST%"
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo Build failed - see the error above. Common cause: no internet access
  echo during this first build ^(it needs to download the WebView2 package once^).
  pause
  exit /b 1
)

echo Building or updating GameWall Control Server...
dotnet publish GameWallControlServer\GameWallControlServer.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "%CONTROL_DIST%"
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo Build failed - see the error above.
  pause
  exit /b 1
)

echo.
echo Starting GameWall...
start "GameWall Display" /D "%DISPLAY_DIST%" GameWallDisplayHost.exe
timeout /t 2 /nobreak >nul
start "GameWall Control Server" /D "%CONTROL_DIST%" GameWallControlServer.exe
timeout /t 2 /nobreak >nul
start http://localhost:5050

echo.
echo GameWall is running.
echo   - Display Host window: shows your PC's IP address in the top-left, for your phone.
echo   - Remote page just opened in your browser at http://localhost:5050
echo.
echo From now on, double-clicking this file just launches GameWall instantly
echo ^(no rebuild^) - or you can double-click the two .exe files directly:
echo   %DISPLAY_DIST%\GameWallDisplayHost.exe
echo   %CONTROL_DIST%\GameWallControlServer.exe
echo.
pause
