@echo off
rem Deploys web\ (the GameDay mobile app) to Vercel.
rem   P = preview link only (gameday-cfb.vercel.app is not touched)
rem   L = LIVE site, gameday-cfb.vercel.app, for everyone
rem Needs Node.js and a Vercel login the first time (a browser window opens).
setlocal
cd /d "%~dp0web"

choice /c PL /m "Deploy to [P]review or [L]ive"
if errorlevel 2 goto live

call :icons
call npx --yes vercel@latest deploy
echo.
echo Open the preview link above on your phone and check it before going live.
pause
exit /b 0

:live
set /p OK=This updates the live GameDay app for everyone. Type YES to continue:
if /i not "%OK%"=="YES" exit /b 0
call :icons
call npx --yes vercel@latest deploy --prod
pause
exit /b 0

:icons
rem Three app icons live only on Vercel; copy them down so the deploy keeps them.
for %%F in (icon-512.png icon-maskable-512.png badge-96.png) do (
  if not exist "%%F" powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing https://gameday-cfb.vercel.app/%%F -OutFile %%F"
)
exit /b 0
