@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 goto usepython
py -3 -B vibecheck.py
goto finished
:usepython
python -B vibecheck.py
:finished
if errorlevel 1 pause
