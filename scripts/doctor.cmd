@echo off
REM Quick wrapper around scripts\doctor.ps1.
REM Usage: scripts\doctor.cmd
REM Returns: 0=green / 1=warnings / 2=critical
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0doctor.ps1"
exit /b %ERRORLEVEL%
