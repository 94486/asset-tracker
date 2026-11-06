# -*- coding: utf-8 -*-
"""数码资产持有成本管理系统 · 入口

应用装配在 at/ 包里（create_app），这里只负责组装与启动：
  · at/config.py       运行配置、路径、静态资源版本
  · at/db.py           连接、日志模式探针、建表迁移
  · at/validators.py   入参解析与状态常量
  · at/costing.py      成本口径（纯函数）
  · at/reporting.py    报表辅助（Top N 汇总、时间线）
  · at/api/*           蓝图：products / wishlist / reports / data_io
  · at/desktop.py      桌面托盘与开发模式启动

打包为 exe 后可直接使用；亦提供 Docker 运行方案。
"""
import sys

from werkzeug.serving import make_server

from at import create_app
from at.config import GATEWAY_SOCKET, HEADLESS, HOST, IS_FROZEN, PORT, URL
from at.db import DB_FILE, get_db, init_db
from at.desktop import run_desktop, run_dev

app = create_app()

__all__ = ["app", "init_db", "get_db", "DB_FILE"]


if __name__ == "__main__":
    init_db()
    if HEADLESS:
        # Docker / 服务器：纯服务模式
        from at.ports import ensure_port_free

        if not ensure_port_free(PORT):
            # 端口清不掉就明确退出，而不是扔一个 OSError 堆栈
            print(f"[错误] 端口 {PORT} 被其它程序占用且无法释放，服务未启动。\n"
                  f"       请结束占用该端口的进程，或用 PORT=其它端口 重新启动。")
            sys.exit(1)
        if GATEWAY_SOCKET:
            # 飞牛桌面 / FN Connect 走 unix socket，不直接连端口。
            # 平台不支持 AF_UNIX（例如 Windows 开发机）时只提示，不能让服务起不来。
            try:
                from at.gateway import start_unix_proxy

                start_unix_proxy(GATEWAY_SOCKET, PORT)
                print(f" * 网关 socket: {GATEWAY_SOCKET}")
            except Exception as exc:
                print(f" * [警告] 网关 socket 未启用：{exc}")
        server = make_server(HOST, PORT, app, threaded=True)
        print(f" * 服务已启动: http://{HOST}:{PORT}")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            server.shutdown()
            server.server_close()
    elif IS_FROZEN:
        # 打包后的 exe：托盘 + 自动开浏览器
        run_desktop(app, PORT, URL)
    else:
        # 开发模式
        run_dev(app, PORT, URL)
