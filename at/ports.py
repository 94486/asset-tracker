# -*- coding: utf-8 -*-
"""端口占用检测与清理（桌面模式启动前调用）"""
import os
import socket
import subprocess
import sys
import time


def is_port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _pid_image_name(pid):
    """查 PID 对应的进程名（中文 Windows 的 tasklist 输出是 GBK）"""
    try:
        r = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            capture_output=True, creationflags=0x08000000,
        )
        text = r.stdout.decode("gbk", "ignore") or r.stdout.decode("utf-8", "ignore")
        first = text.strip().splitlines()[0] if text.strip() else ""
        if not first.startswith('"'):
            return ""
        return first.split('","')[0].strip('"')
    except Exception:
        return ""


# 本程序的 exe 名：源码运行时 sys.executable 是 python.exe，
# 认不出「上一次双击启动的桌面实例」，会导致端口一直被旧实例占着。
# 这里把发行名一并列出，改名时记得同步（qa/test_units.py 有断言）。
APP_EXE_NAMES = ("数码资产持有成本管理.exe", "asset_tracker.exe")


def _allowed_names():
    """只允许结束「本程序」或 Python 进程，避免误杀别人的服务"""
    names = {"python.exe", "pythonw.exe"}
    names.update(n.lower() for n in APP_EXE_NAMES)
    try:
        names.add(os.path.basename(sys.executable).lower())
    except Exception:
        pass
    return names


def kill_port(port):
    """结束占用指定端口的**本程序**进程，返回是否成功

    不认识的进程一律不杀：5678 完全可能是别人的服务，
    启动时强行 taskkill 会误伤，这里改成只清理自己的残留实例。
    """
    allowed = _allowed_names()
    killed = False
    try:
        result = subprocess.run(
            ["netstat", "-ano"], capture_output=True, text=True, creationflags=0x08000000
        )
        pids = set()
        for line in result.stdout.splitlines():
            if f":{port}" in line and "LISTENING" in line:
                pid = line.split()[-1]
                if pid and pid != "0":
                    pids.add(pid)
        for pid in pids:
            name = _pid_image_name(pid)
            if name.lower() not in allowed:
                print(f"[警告] 端口 {port} 被 {name or '未知进程'}(PID {pid}) 占用，"
                      f"不是本程序，已跳过（请手动处理或换端口）")
                continue
            subprocess.run(
                ["taskkill", "/F", "/PID", pid],
                capture_output=True, creationflags=0x08000000,
            )
            killed = True
    except Exception:
        pass
    return killed


def ensure_port_free(port):
    """启动前确保端口可用：被占用则尝试清理，等待最多 3 秒"""
    if is_port_in_use(port):
        print(f"[提示] 端口 {port} 被占用，正在清理旧进程...")
        kill_port(port)
        for _ in range(6):
            time.sleep(0.5)
            if not is_port_in_use(port):
                print("[提示] 端口已释放")
                return True
        print("[警告] 端口清理失败，可能需要手动结束旧进程")
        return False
    return True
