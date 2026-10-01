@echo off
rem Deploys web\ to your LIVE site, gameday-cfb.vercel.app.
rem Only run this after the preview works. You can roll back from the Vercel dashboard.
setlocal
cd /d "%~dp0web"
set /p OK=This updates the live GameDay app for everyone. Type YES to continue: 
if /i not "%OK%"=="YES" exit /b 0
for %%F in (icon-512.png icon-maskable-512.png badge-96.png) do (
  if not exist "%%F" powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing https://gameday-cfb.vercel.app/%%F -OutFile %%F"
)
call npx --yes vercel@latest deploy --prod
pause
