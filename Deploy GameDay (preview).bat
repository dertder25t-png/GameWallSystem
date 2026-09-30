@echo off
rem Deploys web\ (GameDay + the new Wall tab) to a Vercel PREVIEW link.
rem Your live gameday-cfb.vercel.app is not touched. Needs Node.js (you have it)
rem and a Vercel login the first time (a browser window opens).
setlocal
cd /d "%~dp0web"
call :icons
call npx --yes vercel@latest deploy
echo.
echo Open the preview link above on your phone, add /wall/ to the end, and pair.
pause
exit /b 0

:icons
rem Three app icons live only on Vercel; copy them down so the deploy keeps them.
for %%F in (icon-512.png icon-maskable-512.png badge-96.png) do (
  if not exist "%%F" powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing https://gameday-cfb.vercel.app/%%F -OutFile %%F"
)
exit /b 0
