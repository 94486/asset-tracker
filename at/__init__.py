# -*- coding: utf-8 -*-
"""应用工厂：装配 Flask、注册蓝图、页面路由与数据库异常兜底"""
import gzip
import sqlite3
from contextlib import closing

from flask import Flask, Response, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

from .api import BLUEPRINTS
from .config import APP_VERSION, ASSET_VERSION, resource_path
from .db import get_db, init_db

FAVICON_SVG = (
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>"
    "<rect width='32' height='32' rx='8' fill='#5b8cff'/>"
    "<g stroke='#fff' stroke-width='2.6' stroke-linecap='round'>"
    "<path d='M9 21v-5M16 21v-9M23 21v-4'/></g></svg>"
)


def create_app():
    app = Flask(
        __name__,
        template_folder=resource_path("templates"),
        static_folder=resource_path("static"),
    )
    # Flask 3.x 已移除 JSON_AS_ASCII 配置项，改用 provider 属性，避免中文被转义成 \uXXXX
    app.json.ensure_ascii = False
    app.json.sort_keys = False
    # 导入文件上限 64MB：避免一个超大文件把内存吃满（前端也做不了这么大的表）
    app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024

    @app.context_processor
    def inject_version():
        return {"asset_version": ASSET_VERSION}

    # ---------- API ----------
    for bp in BLUEPRINTS:
        app.register_blueprint(bp, url_prefix="/api")

    @app.errorhandler(sqlite3.OperationalError)
    def _handle_schema_missing(err):
        """表 / 列不存在时自动补建，而不是抛 500

        真实场景：用户先在跑程序，又把旧备份的 asset_tracker.db 覆盖回来，
        新版本的 wishlist 表 / list_date 列就没了。这时与其报错，不如就地
        迁移一次，让下一次请求正常（前端拿到 retry 提示后重试即可）。
        """
        msg = str(err)
        if "no such table" in msg or "no such column" in msg:
            try:
                init_db()
                return jsonify({"ok": False, "msg": "数据结构已升级，请重试", "retry": True}), 503
            except Exception:
                pass
        return jsonify({"ok": False, "msg": f"数据库错误：{msg}"}), 500

    # ---------- 通用错误 / 压缩 ----------
    @app.errorhandler(HTTPException)
    def _http_error(err):
        """API 统一返回 JSON，前端不用去解析 HTML 错误页"""
        if request.path.startswith("/api/"):
            msg = err.description or err.name
            if err.code == 413:
                msg = "文件过大（上限 64MB）"
            return jsonify({"ok": False, "msg": msg, "code": err.code}), err.code
        return err

    @app.after_request
    def _gzip_json(response):
        """大响应走 gzip：1200 条列表从 793KB 压到 ~90KB，局域网/Docker 下更明显"""
        if response.direct_passthrough or not (200 <= response.status_code < 300):
            return response
        if response.headers.get("Content-Encoding"):
            return response
        if "gzip" not in (request.headers.get("Accept-Encoding") or "").lower():
            return response
        if response.mimetype not in ("application/json", "text/html", "text/css", "text/csv"):
            return response
        data = response.get_data()
        if len(data) < 1024:
            return response
        response.set_data(gzip.compress(data, compresslevel=6))
        response.headers["Content-Encoding"] = "gzip"
        response.headers["Content-Length"] = str(len(response.get_data()))
        response.headers.add("Vary", "Accept-Encoding")
        return response

    @app.route("/api/health")
    def health():
        """健康检查：Docker healthcheck / 外部探活都能用"""
        try:
            with closing(get_db()) as conn:
                conn.execute("SELECT 1").fetchone()
            return jsonify({"ok": True, "db": True, "version": APP_VERSION})
        except Exception as exc:
            return jsonify({"ok": False, "db": False, "msg": str(exc)}), 503

    # ---------- 页面 ----------
    @app.route("/")
    def index():
        return render_template("index.html")

    @app.route("/favicon.ico")
    def favicon():
        # 内联 SVG 图标，省掉一个静态文件，也避免浏览器 404
        return Response(FAVICON_SVG, mimetype="image/svg+xml",
                        headers={"Cache-Control": "public, max-age=86400"})

    # fnOS 统一网关会把 /app/assettracker/... 转进来：包一层 WSGI 中间件，
    # 保留 Flask 对象本身（test_client / 托盘 / 调试都还按原样用）
    app.wsgi_app = PrefixMiddleware(app.wsgi_app)
    return app


class PrefixMiddleware:
    """支持挂在子路径下（fnOS 统一网关会把 /app/assettracker/... 转进来）

    命中前缀时剥掉前缀再交给 Flask，同时设置 SCRIPT_NAME，
    这样模板里的 request.script_root 与 url_for 都会自动带上前缀。
    BASE_PATH 环境变量优先，否则按 "/app/<name>" 自动识别。
    """

    def __init__(self, app, base_path=""):
        self.app = app
        self.base_path = (base_path or "").rstrip("/")

    @staticmethod
    def detect(path):
        if path.startswith("/app/"):
            parts = path.split("/")
            if len(parts) >= 3 and parts[2]:
                return "/app/" + parts[2]
        return ""

    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO", "")
        prefix = self.base_path or self.detect(path)
        if prefix and path.startswith(prefix):
            environ["PATH_INFO"] = path[len(prefix):] or "/"
            environ["SCRIPT_NAME"] = environ.get("SCRIPT_NAME", "") + prefix
        return self.app(environ, start_response)
