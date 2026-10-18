@echo off
rem uninstall.bat - double-click wrapper for uninstall.ps1 (dsh-context).
rem Removes the profile bundle and this package's packed tarballs.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
echo.
pause
