@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 goto usepython
py -3 -B vibecheck.py %*
goto finished
:usepython
python -B vibecheck.py %*
:finished
set "launch_status=%errorlevel%"
if not "%launch_status%"=="0" if "%~1"=="" pause
exit /b %launch_status%
