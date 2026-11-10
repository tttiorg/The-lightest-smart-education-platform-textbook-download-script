@echo off
chcp 65001 >nul
setlocal
set "NODE_EXE=C:\Users\33588\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
"%NODE_EXE%" "%~dp0smartedu.js" --gui
if errorlevel 1 pause
endlocal
