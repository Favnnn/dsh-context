@echo off
rem install.bat - double-click wrapper for install.ps1 (dsh-context).
rem Builds this folder and installs it into the web profile; keeps the window open.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
