# -*- coding: utf-8 -*-
"""fnOS 统一网关：把 Unix Socket 上的连接原样转发到本机 HTTP 端口

飞牛桌面（含 FN Connect 远程访问）把请求经 unix socket 转发给应用，
而不是直接连端口。这里做一个极小的双向中继：socket 收到什么就转发到
127.0.0.1:PORT，再把响应原样写回。HTTP 是有序的请求/响应流，直接搬字节即可，
不需要解析协议；路径前缀由 PrefixMiddleware 负责剥离。
"""
import os
import socket
import threading

BUFSIZE = 65536


def _pipe(src, dst):
    try:
        while True:
            data = src.recv(BUFSIZE)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def _handle(conn, target_port):
    try:
        upstream = socket.create_connection(("127.0.0.1", target_port), timeout=60)
    except OSError:
        conn.close()
        return
    threading.Thread(target=_pipe, args=(conn, upstream), daemon=True).start()
    _pipe(upstream, conn)
    try:
        conn.close()
        upstream.close()
    except OSError:
        pass


def start_unix_proxy(sock_path, target_port):
    """在 sock_path 上监听，转发到本机 target_port；返回 server socket"""
    if not hasattr(socket, "AF_UNIX"):
        raise RuntimeError("当前平台不支持 AF_UNIX（仅 Linux/macOS 可用）")
    directory = os.path.dirname(sock_path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    try:
        os.unlink(sock_path)      # 上次异常退出留下的残留
    except OSError:
        pass

    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(sock_path)
    # fnOS 网关以另一个用户访问，需要组/其他可读写
    try:
        os.chmod(sock_path, 0o770)
    except OSError:
        pass
    srv.listen(128)

    def loop():
        while True:
            try:
                conn, _ = srv.accept()
            except OSError:
                break
            threading.Thread(target=_handle, args=(conn, target_port), daemon=True).start()

    threading.Thread(target=loop, daemon=True).start()
    return srv
