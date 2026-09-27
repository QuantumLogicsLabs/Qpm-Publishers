@echo off
rem Starts the QuantumPackages registry and puts it on the internet at a random
rem https://<words>.trycloudflare.com address. Needs Node.js 18+.
cd /d "%~dp0"
where node >nul 2>&1 || (
    echo Node.js was not found. Install it from https://nodejs.org and try again.
    pause
    exit /b 1
)
node public.js
pause
