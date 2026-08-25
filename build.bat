@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

title 数码资产持有成本管理 - 一键打包

echo ========================================
echo   数码资产持有成本管理 - 打包脚本
echo ========================================
echo.

:: 切换到脚本所在目录
cd /d "%~dp0"

:: ---------- 1. 检查 Python ----------
echo [1/5] 检查 Python 环境...
python --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Python，请先安装 Python 3.8+
    echo        下载地址: https://www.python.org/downloads/
    echo.
    pause
    exit /b 1
)
for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PY_VER=%%v
echo       Python %PY_VER%  ✓
echo.

:: ---------- 2. 安装依赖 ----------
echo [2/5] 安装项目依赖...
pip install -r requirements.txt -q
if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络或手动执行: pip install -r requirements.txt
    echo.
    pause
    exit /b 1
)
echo       依赖安装完成  ✓
echo.

:: ---------- 3. 清理旧构建（保留数据库） ----------
echo [3/6] 清理旧构建文件（保留数据库）...
if exist "build" (
    rmdir /s /q "build"
    echo       已删除 build/
)

:: 备份 dist 目录下的数据库（如果存在）
set DB_BACKUP=%TEMP%\asset_tracker_db_backup_%RANDOM%.db
if exist "dist\asset_tracker.db" (
    copy /y "dist\asset_tracker.db" "%DB_BACKUP%" >nul
    echo       已备份现有数据库到临时位置
)

if exist "数码资产持有成本管理.spec" del /q "数码资产持有成本管理.spec"
echo       清理完成  ✓
echo.

:: ---------- 4. 执行打包 ----------
echo [4/6] 开始打包（onefile 模式，通常需要 1-3 分钟）...
echo.
python build.py
set BUILD_RC=%errorlevel%
echo.

if not "%BUILD_RC%"=="0" (
    echo [错误] 打包失败，错误码: %BUILD_RC%
    :: 打包失败也尝试恢复数据库
    if exist "%DB_BACKUP%" (
        if not exist "dist" mkdir "dist"
        copy /y "%DB_BACKUP%" "dist\asset_tracker.db" >nul
        echo       已恢复数据库
    )
    echo.
    pause
    exit /b %BUILD_RC%
)

:: ---------- 5. 恢复数据库 ----------
echo [5/6] 恢复数据库...
if exist "%DB_BACKUP%" (
    copy /y "%DB_BACKUP%" "dist\asset_tracker.db" >nul
    del /q "%DB_BACKUP%"
    echo       数据库已恢复（沿用原有数据）✓
) else (
    echo       无原有数据库，首次运行将自动生成 ✓
)
echo.

:: ---------- 6. 完成 ----------
echo [6/6] 打包完成  ✓
echo.
echo ========================================
echo   产物位置: %~dp0dist\数码资产持有成本管理.exe
echo ========================================
echo.
echo 使用说明:
echo   - 双击 exe 即可运行，会自动打开浏览器
echo   - 首次运行会在 exe 同级目录生成 asset_tracker.db 数据库
echo   - 数据仅保存在本地，删除 db 文件即清空记录
echo.
echo 如需分发，将 dist\数码资产持有成本管理.exe 单独复制即可
echo.
pause
endlocal
