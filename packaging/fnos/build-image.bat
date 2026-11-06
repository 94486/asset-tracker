@echo off
rem Build the Docker image inside WSL, smoke-test it, and export an offline tar.
rem Double-click to run. Optional: set FNOS_WSL_DISTRO=Ubuntu to use another distro.
rem NOTE: keep this file ASCII-only with CRLF line endings. cmd.exe parses .bat with
rem the OEM code page; UTF-8 or LF-only will break the script on a Chinese Windows.
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if "%FNOS_WSL_DISTRO%"=="" set "DISTRO=Debian"
if not "%FNOS_WSL_DISTRO%"=="" set "DISTRO=%FNOS_WSL_DISTRO%"

rem always save the image unless you pass --no-save; build-fpk.bat needs the tar
set "EXTRA=--save"

where wsl.exe >nul 2>&1
if errorlevel 1 goto no_wsl

echo [i] distro: %DISTRO%
echo [i] folder: %CD%
echo.

wsl.exe -d %DISTRO% -u root bash -c "test -f ./build-image.sh" >nul 2>&1
if errorlevel 1 goto no_script

wsl.exe -d %DISTRO% -u root bash ./build-image.sh %EXTRA% %*
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" goto failed

echo [ok] image built
echo.
echo      next: double-click build-fpk.bat
echo      or  : python packaging\fnos\build.py --with-image
pause
exit /b 0

:no_wsl
echo [x] wsl.exe not found. Enable "Windows Subsystem for Linux" and install a distro.
goto fail_pause

:no_script
echo [x] WSL cannot see this folder: %CD%
echo     Move the project to a local drive such as D:/ and retry.
echo     (network / UNC paths are not mounted into WSL by default)
goto fail_pause

:failed
echo [x] build failed, exit code %CODE%
echo     Docker daemon: try  sudo service docker start  inside WSL

:fail_pause
pause
exit /b 1
