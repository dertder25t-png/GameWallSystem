@echo off
setlocal
cd /d "%~dp0"

echo Cleaning all build artifacts...

rem Kill any running GameWall processes
taskkill /im GameWallDisplayHost.exe /f >nul 2>nul
taskkill /im GameWallControlServer.exe /f >nul 2>nul

rem Remove all build directories
if exist "GameWallDisplayHost\bin" (
  echo  - Removing GameWallDisplayHost\bin
  rmdir /s /q "GameWallDisplayHost\bin" >nul 2>nul
)
if exist "GameWallDisplayHost\obj" (
  echo  - Removing GameWallDisplayHost\obj
  rmdir /s /q "GameWallDisplayHost\obj" >nul 2>nul
)
if exist "GameWallControlServer\bin" (
  echo  - Removing GameWallControlServer\bin
  rmdir /s /q "GameWallControlServer\bin" >nul 2>nul
)
if exist "GameWallControlServer\obj" (
  echo  - Removing GameWallControlServer\obj
  rmdir /s /q "GameWallControlServer\obj" >nul 2>nul
)
if exist "GameWallSystem.Tests\bin" (
  echo  - Removing GameWallSystem.Tests\bin
  rmdir /s /q "GameWallSystem.Tests\bin" >nul 2>nul
)
if exist "GameWallSystem.Tests\obj" (
  echo  - Removing GameWallSystem.Tests\obj
  rmdir /s /q "GameWallSystem.Tests\obj" >nul 2>nul
)
if exist "dist" (
  echo  - Removing dist folder
  rmdir /s /q "dist" >nul 2>nul
)

echo.
echo Clearing NuGet cache (this may take a moment)...
dotnet nuget locals all --clear >nul 2>nul

echo.
echo Clean build is ready. Now run: GameWall - Click to Run.bat
echo.
pause
