# -*- coding: utf-8 -*-
"""运行配置与路径解析（源码 / exe 打包 / Docker 卷挂载）"""
import os
import sys

# ---------- 运行配置 ----------
PORT = int(os.environ.get("PORT", "5678"))
# HEADLESS=1 时为纯服务模式（Docker / 服务器），不开浏览器、无托盘
HEADLESS = str(os.environ.get("HEADLESS", "")).lower() in ("1", "true", "yes") \
    or os.environ.get("RUN_IN_DOCKER") == "1"
HOST = "0.0.0.0" if HEADLESS else "127.0.0.1"
IS_FROZEN = getattr(sys, "frozen", False)
# fnOS 统一网关：应用在 Unix Socket 上再开一个入口（见 at/gateway.py）
GATEWAY_SOCKET = os.environ.get("GATEWAY_SOCKET", "")
URL = f"http://127.0.0.1:{PORT}"


# ---------- 路径处理 ----------
def resource_path(*parts):
    """获取静态资源路径（兼容 PyInstaller 打包）"""
    if IS_FROZEN:
        base = sys._MEIPASS          # onefile: 临时解压目录；onedir: _internal
    else:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, *parts)


def data_path():
    """数据库文件路径：优先 DATA_DIR（Docker 卷挂载），否则放在 exe 同级目录"""
    override = os.environ.get("DATA_DIR")
    if override:
        try:
            os.makedirs(override, exist_ok=True)
        except Exception:
            pass
        return os.path.join(override, "asset_tracker.db")
    if IS_FROZEN:
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "asset_tracker.db")


DB_FILE = data_path()


def app_version():
    """版本号唯一来源：仓库根目录的 VERSION 文件

    exe / Docker / fpk 三个打包目标都读它，避免各写一份版本号对不上。
    """
    try:
        with open(resource_path("VERSION"), encoding="utf-8") as f:
            return f.read().strip() or "0.0.0"
    except OSError:
        return "0.0.0"


APP_VERSION = app_version()


def asset_version():
    """前端静态资源版本号（改动后自动更新，避免浏览器缓存读到旧文件）"""
    stamps = []
    for rel in ("static/css/style.css", "static/js/util.js", "static/js/app.js"):
        try:
            stamps.append(int(os.path.getmtime(resource_path(rel))))
        except OSError:
            pass
    return str(max(stamps)) if stamps else "1"


ASSET_VERSION = asset_version()
