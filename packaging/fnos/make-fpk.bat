@echo off
rem ONE double-click: build the image inside WSL, then pack a self-contained .fpk
rem (the image tar is embedded, so installing the fpk needs no docker build / no network).
rem Keep this file ASCII-only with CRLF line endings - see build-image.bat.
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if "%FNOS_WSL_DISTRO%"=="" set "DISTRO=Debian"
if not "%FNOS_WSL_DISTRO%"=="" set "DISTRO=%FNOS_WSL_DISTRO%"

echo ============================================================
echo  1/2  build docker image + smoke test  (WSL: %DISTRO%)
echo ============================================================
where wsl.exe >nul 2>&1
if errorlevel 1 goto no_wsl

wsl.exe -d %DISTRO% -u root bash -c "test -f ./build-image.sh" >nul 2>&1
if errorlevel 1 goto no_script

wsl.exe -d %DISTRO% -u root bash ./build-image.sh --save
if errorlevel 1 goto build_failed

if not exist ".out\assettracker-image.tar" goto no_image

echo.
echo ============================================================
echo  2/2  pack the .fpk with the image inside
echo ============================================================
cd /d "%~dp0..\.."

set "PY="
where python >nul 2>&1
if not errorlevel 1 set "PY=python"
if not defined PY where py >nul 2>&1
if not defined PY if not errorlevel 1 set "PY=py -3"
if not defined PY goto no_python

%PY% packaging\fnos\build.py --with-image
if errorlevel 1 goto pack_failed

echo.
echo [ok] done. package:
dir /b dist-fpk\*.fpk
echo.
echo      full path: %CD%\dist-fpk
echo.
echo      install: fnOS desktop - App Center - Settings - Install manually
start "" "%~dp0..\..\dist-fpk"
pause
exit /b 0

:no_wsl
echo [x] wsl.exe not found. Enable Windows Subsystem for Linux first.
goto fail_pause

:no_script
echo [x] WSL cannot see this folder: %CD%
echo     Move the project to a local drive such as D:/ and retry.
goto fail_pause

:build_failed
echo [x] image build failed. Run this in a cmd window to see the full log:
echo     cd /d %~dp0
echo     build-image.bat
goto fail_pause

:no_image
echo [x] image built but .out\assettracker-image.tar is missing.
echo     Run build-image.bat --save and check its output.
goto fail_pause

:no_python
echo [x] Python not found on Windows. Install Python 3.10+ (needed for fnpack).
goto fail_pause

:pack_failed
echo [x] fpk packaging failed. See the log above.

:fail_pause
pause
exit /b 1
