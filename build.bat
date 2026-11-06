@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

title 数码资产持有成本管理 - 一键打包（文件夹模式）

set "APP_NAME=数码资产持有成本管理"
set "OUT_DIR=dist\%APP_NAME%"
set "OUT_EXE=%OUT_DIR%\%APP_NAME%.exe"

echo ========================================
echo   数码资产持有成本管理 - 打包脚本
echo   模式: onedir（文件夹，避免 SAC 拦截）
echo ========================================
echo.

:: 切换到脚本所在目录
cd /d "%~dp0"

:: ---------- 1. 检查 Python ----------
echo [1/6] 检查 Python 环境...
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
echo [2/6] 安装项目依赖...
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

:: 备份数据库：优先文件夹模式的新位置，其次兼容旧的单文件模式位置
set "DB_BACKUP=%TEMP%\asset_tracker_db_backup_%RANDOM%.db"
set "HAS_DB=0"
if exist "%OUT_DIR%\asset_tracker.db" (
    copy /y "%OUT_DIR%\asset_tracker.db" "%DB_BACKUP%" >nul
    set "HAS_DB=1"
    echo       已备份现有数据库（文件夹内）
) else if exist "dist\asset_tracker.db" (
    copy /y "dist\asset_tracker.db" "%DB_BACKUP%" >nul
    set "HAS_DB=1"
    echo       已备份现有数据库（旧单文件位置，将迁移）
)

:: 旧版单文件 exe 已无意义，删掉避免误双击
if exist "dist\%APP_NAME%.exe" (
    del /q "dist\%APP_NAME%.exe"
    echo       已移除旧的单文件 exe
)

:: 图标：缺失时由 build.py 自动调用 make_icon.py 生成
if not exist "asset.ico" (
    echo       未找到 asset.ico，打包时将自动生成
)

if exist "%APP_NAME%.spec" del /q "%APP_NAME%.spec"
echo       清理完成  ✓
echo.

:: ---------- 4. 执行打包 ----------
echo [4/6] 开始打包（onedir 文件夹模式，通常需要 1-3 分钟）...
echo.
python build.py
set BUILD_RC=%errorlevel%
echo.

if not "%BUILD_RC%"=="0" (
    echo [错误] 打包失败，错误码: %BUILD_RC%
    :: 打包失败也尝试恢复数据库到原位置
    if "%HAS_DB%"=="1" (
        if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"
        copy /y "%DB_BACKUP%" "%OUT_DIR%\asset_tracker.db" >nul
        echo       已恢复数据库
    )
    echo.
    pause
    exit /b %BUILD_RC%
)

:: ---------- 5. 恢复数据库 ----------
echo [5/6] 迁移数据库...
if "%HAS_DB%"=="1" (
    if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"
    copy /y "%DB_BACKUP%" "%OUT_DIR%\asset_tracker.db" >nul
    del /q "%DB_BACKUP%"
    echo       数据库已放到 %OUT_DIR%\asset_tracker.db（沿用原有数据）✓
) else (
    echo       无原有数据库，首次运行将在 exe 同级自动生成 ✓
)
echo.

:: ---------- 6. 完成 ----------
echo [6/6] 打包完成  ✓
echo.
echo ========================================
echo   产物目录: %~dp0%OUT_DIR%\
echo   启动文件: %OUT_EXE%
echo ========================================
echo.
echo 使用说明:
echo   - 双击 %APP_NAME%.exe 即可运行，会自动打开浏览器
echo   - 首次运行会在 exe 同级（即 %OUT_DIR%）生成 asset_tracker.db
echo   - 数据仅保存在本地，删除 db 文件即清空记录
echo.
echo 分发说明（重要）:
echo   - 必须复制整个 "%APP_NAME%" 文件夹，只拷 exe 无法运行
echo   - 升级时保留文件夹里的 asset_tracker.db，替换其余文件即可
echo.
pause
endlocal
