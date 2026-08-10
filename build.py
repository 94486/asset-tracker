# -*- coding: utf-8 -*-
"""
PyInstaller 打包脚本
运行: python build.py
产出: dist/数码资产持有成本管理.exe
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "app.py")
NAME = "数码资产持有成本管理"

# Windows 下 add-data 分隔符为 ;
sep = ";"

cmd = [
    sys.executable, "-m", "PyInstaller",
    "--noconfirm",
    "--clean",
    "--onefile",
    "--windowed",                      # 无控制台窗口
    "--name", NAME,
    f"--add-data=templates{sep}templates",
    f"--add-data=static{sep}static",
    "--hidden-import", "flask",
    "--hidden-import", "jinja2",
    "--hidden-import", "werkzeug",
    "--hidden-import", "pystray",
    "--hidden-import", "PIL",
    "--collect-all", "flask",
    "--collect-all", "pystray",
    "--collect-submodules", "PIL",
    APP,
]

print("执行打包：")
print(" ".join(cmd))
r = subprocess.run(cmd, cwd=HERE)
sys.exit(r.returncode)
