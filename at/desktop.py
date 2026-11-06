# -*- coding: utf-8 -*-
"""桌面模式：本地 HTTP 服务 + 自动开浏览器 + 系统托盘"""
import os
import sys
import threading
import time
import traceback
import webbrowser

from werkzeug.serving import make_server

from .config import DB_FILE


def build_tray_image(size=64):
    """蓝底圆角 + 三根白色柱状，与 asset.ico / favicon 保持同一套视觉"""
    from PIL import Image, ImageDraw

    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=(91, 140, 255, 255))

    base = int(s * 0.72)
    bar_w = int(s * 0.13)
    gap = int(s * 0.055)
    left = (s - (bar_w * 3 + gap * 2)) // 2
    for i, h in enumerate((0.22, 0.36, 0.50)):
        x0 = left + i * (bar_w + gap)
        d.rounded_rectangle([x0, base - int(s * h), x0 + bar_w, base],
                            radius=max(1, bar_w // 3), fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


def _notify(text):
    """桌面模式（windowed exe）没有控制台，用系统弹窗把错误告诉用户"""
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, text, "数码资产持有成本管理", 0x10)
        return
    except Exception:
        print(text)


def _port_ready(port):
    """端口可用就返回 True；被占且清不掉时提示用户并返回 False"""
    from .ports import ensure_port_free

    if ensure_port_free(port):
        return True
    _notify(f"端口 {port} 被其它程序占用，本程序无法启动。\n\n"
            f"请关闭占用该端口的程序后重试；\n"
            f"或用环境变量 PORT 指定其它端口。")
    return False


def run_desktop(flask_app, port, url):
    """桌面模式：后台起服务 + 自动打开浏览器 + 系统托盘图标（可退出）"""
    if not _port_ready(port):
        os._exit(1)
    server = make_server("127.0.0.1", port, flask_app, threaded=True)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    # 稍等服务就绪后自动打开浏览器
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    # 托盘（仅桌面环境）
    try:
        import pystray

        def open_page(icon, item):
            webbrowser.open(url)

        def quit_app(icon, item):
            # 先关 HTTP 服务，再退托盘，最后强制退出（兜底）
            try:
                server.shutdown()
                server.server_close()
            except Exception:
                pass
            try:
                icon.stop()
            except Exception:
                pass
            time.sleep(0.3)
            os._exit(0)

        menu = pystray.Menu(
            pystray.MenuItem("打开页面", open_page, default=True),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("退出程序", quit_app),
        )
        icon = pystray.Icon("asset_tracker", build_tray_image(), "数码资产持有成本管理", menu)
        # 单击托盘图标直接打开页面
        try:
            icon.on_activate = lambda icon, item: webbrowser.open(url)
        except Exception:
            pass
        icon.run()  # 阻塞主线程，直到退出
    except Exception as exc:
        # 托盘失败时不能静默：把原因写到数据库同级的日志里，
        # 否则用户只会看到「图标没了」，无从排查（常见原因是打包漏了 pystray/Pillow）
        try:
            log_path = os.path.join(os.path.dirname(DB_FILE), "tray_error.log")
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(time.strftime("[%Y-%m-%d %H:%M:%S] ") + repr(exc) + "\n")
                f.write(traceback.format_exc() + "\n")
        except Exception:
            pass
        # 无托盘环境则退化为常驻服务
        try:
            t.join()
        except KeyboardInterrupt:
            server.shutdown()
            server.server_close()


def run_dev(flask_app, port, url):
    """开发模式：make_server + 优雅退出 + 自动开浏览器"""
    if not _port_ready(port):
        sys.exit(1)
    server = make_server("127.0.0.1", port, flask_app, threaded=True)
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    print(f" * 服务已启动: {url}")
    print(" * 按 Ctrl+C 退出")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭服务...")
    finally:
        server.shutdown()
        server.server_close()
        print("已退出")
