@echo off
rem ---------------------------------------------------------------------------
rem  Watch the whole wall.
rem
rem  One worker pulling straight off the SFU, the way a viewer does. It finds
rem  cameras through the Hub, so adding one at /join gets it watched with
rem  nothing restarted - and the publisher never uploads a second copy, so a
rem  backgrounded tab cannot stop it.
rem
rem  This is a stopgap for running it on a laptop. The real home for this is a
rem  cheap always-on box - see the "Deploying it" section of README.md - because
rem  a watcher that stops when a lid closes is a demo that works when you are
rem  watching it and not when anyone else is.
rem ---------------------------------------------------------------------------

setlocal
cd /d "%~dp0"

rem The model caches. Keeping them outside the repo means a reinstall does not
rem re-download four gigabytes.
if "%TORCH_HOME%"=="" set TORCH_HOME=C:/rc/th
if "%HF_HOME%"=="" set HF_HOME=C:/rc/hf
set PYTHONUNBUFFERED=1

rem The teacher's key, read from the Worker's dev vars so there is one copy.
if "%NEBIUS_API_KEY%"=="" (
  for /f "usebackq tokens=1,* delims==" %%A in ("..\.dev.vars") do (
    if "%%A"=="NEBIUS_API_KEY" set NEBIUS_API_KEY=%%B
  )
)

if "%PACT_HUB%"=="" set PACT_HUB=https://pact.lanvar.ai

echo Watching every camera on %PACT_HUB%
echo Logging to %USERPROFILE%\pact-watcher.log
echo.

rem Restart on exit. A long-running process on a home network will lose its
rem socket, and the one that needs a human to restart it is the one that is off.
:loop
".venv\Scripts\python.exe" -m pact_perception.run ^
  --room * --embed local --resolution 384 --source sfu --idle-hz 8 ^
  --hub "%PACT_HUB%" --level info >> "%USERPROFILE%\pact-watcher.log" 2>&1
echo [%date% %time%] watcher exited, restarting in 5s >> "%USERPROFILE%\pact-watcher.log"
timeout /t 5 /nobreak >nul
goto loop
