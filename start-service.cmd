@echo off
setlocal
cd /d "%~dp0"

echo.
echo   DSH x WPS  -  Starting local service
echo   ============================================
echo.

rem 日志写到用户目录，和安装脚本启动的服务用同一个文件。
rem 这样无论谁把服务拉起来，出问题都有日志可查（这个窗口关掉就没了）。
if not defined DSH_WPS_LOG set "DSH_WPS_LOG=%APPDATA%\dsh-wps\service.log"

rem Node 不在 PATH 里就找几个常见位置（DSH 自带的运行时也在候选里）
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd" set "NODE_EXE=%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd"

if not defined NODE_EXE (
  echo   [ERROR] Node.js not found.
  echo.
  echo   Please install Node.js 18 or newer first:
  echo       https://nodejs.org/
  echo.
  echo   After installing, run this file again.
  echo.
  pause
  exit /b 1
)

echo   Node   : %NODE_EXE%
echo   Log    : %DSH_WPS_LOG%
echo.
echo   Keep this window open while using the assistant.
echo.

"%NODE_EXE%" "%~dp0server\index.mjs" --verbose
echo.
echo   Service stopped. Press any key to close.
pause >nul
