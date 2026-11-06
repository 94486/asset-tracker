# -*- coding: utf-8 -*-
"""PyInstaller 打包脚本

默认 **文件夹模式（--onedir）**：

    dist/数码资产持有成本管理/
        数码资产持有成本管理.exe
        _internal/            # 依赖、模板、静态资源

为什么默认 onedir：
  · 启动不再自解压到临时目录，冷启动更快
  · 不需要往 %TEMP% 落地一堆 dll/exe，被杀软与 Windows 智能应用控制（SAC）
    拦截的概率明显更低（onefile 常被判定为"释放并执行可执行文件"）
  · 升级时只替换 _internal 即可，磁盘占用也更省

需要单文件时显式指定：

    python build.py --onefile
"""
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "app.py")
NAME = "数码资产持有成本管理"
ICON = os.path.join(HERE, "asset.ico")
DIST = os.environ.get("AT_DISTPATH") or os.path.join(HERE, "dist")

# Windows 下 add-data 分隔符为 ;
sep = ";"


def db_path():
    """数据库在产物里的位置：onedir 在 exe 同级，onefile 在 dist 根目录"""
    if MODE == "onedir":
        return os.path.join(DIST, NAME, "asset_tracker.db")
    return os.path.join(DIST, "asset_tracker.db")


def backup_db():
    """打包前把已有数据库挪走

    PyInstaller 带 --noconfirm 时会**整个删掉产物目录**，里面正好有用户的
    asset_tracker.db。直接跑 build.py（而不是 build.bat）的人就会丢数据，
    所以备份/恢复放在脚本里，不依赖外部批处理。
    """
    src = db_path()
    if not os.path.exists(src):
        return None
    tmp_dir = tempfile.mkdtemp(prefix="asset_db_")
    dst = os.path.join(tmp_dir, "asset_tracker.db")
    shutil.copy2(src, dst)
    try:
        with sqlite3.connect(dst) as conn:
            rows = conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]
    except sqlite3.DatabaseError:
        rows = "?"
    print(f"[db] 已备份数据库：{rows} 条记录 -> {dst}")
    return dst


def restore_db(backup):
    if not backup:
        return
    dst = db_path()
    if os.path.exists(dst):
        print(f"[db] 产物里已有数据库，保留不覆盖：{dst}")
        return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(backup, dst)
    print(f"[db] 已恢复数据库 -> {dst}")


def ensure_icon():
    """图标缺失时自动用 make_icon.py 生成，避免 exe 退回 PyInstaller 默认图标"""
    if os.path.exists(ICON):
        return ICON
    maker = os.path.join(HERE, "make_icon.py")
    if not os.path.exists(maker):
        return None
    try:
        subprocess.run([sys.executable, maker], cwd=HERE, check=True)
    except Exception as exc:
        print(f"[warn] 图标生成失败，将使用默认图标: {exc}")
        return None
    return ICON if os.path.exists(ICON) else None


def ensure_runtime_deps():
    """托盘是桌面模式的核心功能，缺依赖会打出一个「没有图标」的 exe。

    这里显式检查、缺了就中止：静默降级比打包失败更难发现。
    """
    import importlib
    missing = []
    for mod in ("flask", "pystray", "PIL", "six"):
        try:
            importlib.import_module(mod)
        except ImportError:
            missing.append(mod)
    if missing:
        print("[error] 缺少运行依赖：" + ", ".join(missing))
        print("        请先执行：pip install -r requirements.txt")
        sys.exit(1)


def pick_mode(argv):
    """默认 onedir；传 --onefile 可回到单文件"""
    for arg in argv:
        if arg == "--onefile":
            return "onefile"
        if arg == "--onedir":
            return "onedir"
    return "onedir"


MODE = pick_mode(sys.argv[1:])
ensure_runtime_deps()

cmd = [
    sys.executable, "-m", "PyInstaller",
    "--noconfirm",
    "--clean",
    f"--{MODE}",
    "--windowed",                      # 无控制台窗口
    "--noupx",                         # 不用 UPX 压缩：压缩壳是杀软/SAC 的高危特征
    "--name", NAME,
    "--distpath", DIST,
    f"--add-data=templates{sep}templates",
    f"--add-data=static{sep}static",
    f"--add-data=VERSION{sep}.",
    "--hidden-import", "flask",
    "--hidden-import", "jinja2",
    "--hidden-import", "werkzeug",
    "--hidden-import", "pystray",
    "--hidden-import", "PIL",
    "--hidden-import", "six",
    "--collect-all", "flask",
    "--collect-all", "pystray",
    "--collect-submodules", "PIL",
]

icon = ensure_icon()
if icon:
    cmd += ["--icon", icon]

cmd.append(APP)

print(f"打包模式：{MODE}")
print("执行打包：")
print(" ".join(cmd))
db_backup = backup_db()
r = subprocess.run(cmd, cwd=HERE)
if r.returncode != 0:
    restore_db(db_backup)          # 打包失败也要把数据放回去
    sys.exit(r.returncode)
restore_db(db_backup)

# ---------- 产物自检 ----------
if MODE == "onedir":
    exe = os.path.join(DIST, NAME, NAME + ".exe")
else:
    exe = os.path.join(DIST, NAME + ".exe")

if not os.path.exists(exe):
    print(f"[error] 未找到产物: {exe}")
    sys.exit(1)

if MODE == "onedir":
    total = 0
    for root, _dirs, files in os.walk(os.path.join(DIST, NAME)):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    print(f"\n[ok] 产物目录: {os.path.join(DIST, NAME)}")
    print(f"[ok] 启动文件: {exe}")
    print(f"[ok] 目录体积: {total / 1024 / 1024:.1f} MB")
    print("[提示] 分发时请复制整个文件夹，不要只拷 exe")
else:
    print(f"\n[ok] 产物文件: {exe}")
    print(f"[ok] 文件体积: {os.path.getsize(exe) / 1024 / 1024:.1f} MB")
