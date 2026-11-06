@echo off
rem Build the fnOS .fpk package. Double-click to run.
rem If packaging\fnos\.out\assettracker-image.tar exists, it is packed in for offline install.
rem NOTE: keep this file ASCII-only with CRLF line endings (see build-image.bat).
setlocal
chcp 65001 >nul
cd /d "%~dp0..\.."

set "PY="
where python >nul 2>&1
if not errorlevel 1 set "PY=python"
if not defined PY where py >nul 2>&1
if not defined PY if not errorlevel 1 set "PY=py -3"
if not defined PY goto no_python

set "IMG="
if exist "packaging\fnos\.out\assettracker-image.tar" set "IMG=--with-image"
if exist "packaging\fnos\.out\assettracker-image.tar.gz" set "IMG=--with-image"
if not defined IMG echo [i] no offline image in packaging\fnos\.out, packing a 20 KB shell only

%PY% packaging\fnos\build.py %IMG% %*
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" goto failed

echo [ok] package written to dist-fpk\
pause
exit /b 0

:no_python
echo [x] Python not found. Install Python 3.10+ and run again.
pause
exit /b 1

:failed
echo [x] packaging failed, exit code %CODE%
pause
exit /b %CODE%
