# -*- coding: utf-8 -*-
"""
数码资产持有成本管理系统
Flask + SQLite + ECharts
打包为 exe 后可直接使用；亦提供 Docker 运行方案
"""
import os
import sys
import json
import time
import socket
import sqlite3
import threading
import subprocess
import webbrowser
from datetime import datetime, date

from flask import Flask, jsonify, request, render_template, send_from_directory, Response
from werkzeug.serving import make_server

# ---------- 运行配置 ----------
PORT = int(os.environ.get("PORT", "5678"))
# HEADLESS=1 时为纯服务模式（Docker / 服务器），不开浏览器、无托盘
HEADLESS = str(os.environ.get("HEADLESS", "")).lower() in ("1", "true", "yes") \
    or os.environ.get("RUN_IN_DOCKER") == "1"
HOST = "0.0.0.0" if HEADLESS else "127.0.0.1"
IS_FROZEN = getattr(sys, "frozen", False)
URL = f"http://127.0.0.1:{PORT}"


# ---------- 路径处理（兼容 exe 打包 / Docker 卷挂载） ----------
def resource_path(*parts):
    """获取静态资源路径（兼容 PyInstaller 打包）"""
    if IS_FROZEN:
        base = sys._MEIPASS  # 打包后的临时目录
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, *parts)


def data_path():
    """数据库文件路径：优先 DATA_DIR 环境变量（Docker 卷挂载），否则放在 exe 同级目录"""
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
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "asset_tracker.db")


DB_FILE = data_path()

app = Flask(
    __name__,
    template_folder=resource_path("templates"),
    static_folder=resource_path("static"),
)
app.config["JSON_AS_ASCII"] = False


# ---------- 数据库 ----------
def get_db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            brand TEXT DEFAULT '',
            category TEXT DEFAULT '',
            price REAL NOT NULL DEFAULT 0,
            purchase_date TEXT NOT NULL,
            config TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'in_use',   -- in_use / sold / damaged
            sale_date TEXT,
            sale_price REAL,
            custom_fields TEXT DEFAULT '{}',          -- JSON
            notes TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime'))
        )
        """
    )
    conn.commit()
    conn.close()


# ---------- 端口占用检测与清理 ----------
def is_port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def kill_port(port):
    """Windows: 杀掉占用指定端口的进程，返回是否成功"""
    try:
        result = subprocess.run(
            ["netstat", "-ano"], capture_output=True, text=True, creationflags=0x08000000
        )
        for line in result.stdout.splitlines():
            if f":{port}" in line and "LISTENING" in line:
                parts = line.split()
                pid = parts[-1]
                if pid and pid != "0":
                    subprocess.run(
                        ["taskkill", "/F", "/PID", pid],
                        capture_output=True, creationflags=0x08000000,
                    )
                    return True
    except Exception:
        pass
    return False


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


# ---------- 成本计算 ----------
def days_between(d1, d2):
    """d1,d2 为 'YYYY-MM-DD' 字符串，返回天数差（>=1）"""
    try:
        a = datetime.strptime(d1, "%Y-%m-%d").date()
        b = datetime.strptime(d2, "%Y-%m-%d").date()
    except Exception:
        return 1
    diff = (b - a).days
    return max(diff, 1)


def compute_cost(row):
    """根据记录计算成本，返回补充后的 dict"""
    d = dict(row)
    price = d.get("price") or 0.0
    status = d.get("status") or "in_use"
    purchase_date = d.get("purchase_date") or date.today().isoformat()
    today = date.today().isoformat()

    # 解析自定义字段
    try:
        d["custom_fields"] = json.loads(d.get("custom_fields") or "{}")
    except Exception:
        d["custom_fields"] = {}

    if status == "in_use":
        days = days_between(purchase_date, today)
        d["days_held"] = days
        d["daily_cost"] = round(price / days, 2) if days else 0
        d["final_holding_cost"] = None
        d["depreciation"] = None
        d["depreciation_rate"] = None
        d["profit_loss"] = None          # 未结算，无最终盈亏
    else:
        # sold / damaged
        sale_date = d.get("sale_date") or today
        days = days_between(purchase_date, sale_date)
        sale_price = d.get("sale_price")
        if status == "sold" and sale_price is not None:
            net = price - sale_price
            d["profit_loss"] = round(sale_price - price, 2)   # 正=盈利 负=亏损
        else:
            # damaged: 视为全额损失
            net = price
            d["profit_loss"] = round(-price, 2)               # 全额亏损
        d["days_held"] = days
        d["final_holding_cost"] = round(net / days, 2) if days else 0
        d["daily_cost"] = round(net / days, 2) if days else 0
        d["depreciation"] = round(net, 2)
        d["depreciation_rate"] = round(net / price * 100, 1) if price else 0
    return d


# ---------- 页面 ----------
@app.route("/")
def index():
    return render_template("index.html")


# ---------- API ----------
@app.route("/api/products", methods=["GET"])
def list_products():
    conn = get_db()
    rows = conn.execute("SELECT * FROM products ORDER BY purchase_date DESC, id DESC").fetchall()
    conn.close()
    data = [compute_cost(r) for r in rows]
    return jsonify({"ok": True, "data": data})


@app.route("/api/products", methods=["POST"])
def create_product():
    p = request.get_json(force=True)
    name = (p.get("name") or "").strip()
    price = p.get("price")
    purchase_date = p.get("purchase_date")
    if not name:
        return jsonify({"ok": False, "msg": "名称不能为空"}), 400
    if price is None:
        return jsonify({"ok": False, "msg": "请填写价格"}), 400
    if not purchase_date:
        return jsonify({"ok": False, "msg": "请填写购买时间"}), 400
    conn = get_db()
    cur = conn.execute(
        """
        INSERT INTO products
        (name, brand, category, price, purchase_date, config, status, sale_date, sale_price, custom_fields, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            name,
            p.get("brand") or "",
            p.get("category") or "",
            float(price),
            purchase_date,
            p.get("config") or "",
            p.get("status") or "in_use",
            p.get("sale_date"),
            p.get("sale_price"),
            json.dumps(p.get("custom_fields") or {}, ensure_ascii=False),
            p.get("notes") or "",
        ),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return jsonify({"ok": True, "id": new_id})


@app.route("/api/products/<int:pid>", methods=["PUT"])
def update_product(pid):
    p = request.get_json(force=True)
    conn = get_db()
    conn.execute(
        """
        UPDATE products SET
            name=?, brand=?, category=?, price=?, purchase_date=?, config=?,
            status=?, sale_date=?, sale_price=?, custom_fields=?, notes=?
        WHERE id=?
        """,
        (
            p.get("name"),
            p.get("brand") or "",
            p.get("category") or "",
            float(p.get("price") or 0),
            p.get("purchase_date"),
            p.get("config") or "",
            p.get("status") or "in_use",
            p.get("sale_date"),
            p.get("sale_price"),
            json.dumps(p.get("custom_fields") or {}, ensure_ascii=False),
            p.get("notes") or "",
            pid,
        ),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/products/<int:pid>", methods=["DELETE"])
def delete_product(pid):
    conn = get_db()
    conn.execute("DELETE FROM products WHERE id=?", (pid,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/products/<int:pid>/sell", methods=["POST"])
def sell_product(pid):
    """登记出售 / 损坏"""
    p = request.get_json(force=True)
    status = p.get("status") or "sold"   # sold / damaged
    if status not in ("sold", "damaged", "in_use"):
        return jsonify({"ok": False, "msg": "无效状态"}), 400
    sale_date = p.get("sale_date") or date.today().isoformat()
    sale_price = p.get("sale_price")
    conn = get_db()
    if status == "in_use":
        # 恢复为使用中，清空出售信息
        conn.execute(
            "UPDATE products SET status='in_use', sale_date=NULL, sale_price=NULL WHERE id=?",
            (pid,),
        )
    else:
        conn.execute(
            "UPDATE products SET status=?, sale_date=?, sale_price=? WHERE id=?",
            (status, sale_date, sale_price if status == "sold" else None, pid),
        )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- 报表 ----------
@app.route("/api/report/summary", methods=["GET"])
def report_summary():
    conn = get_db()
    rows = conn.execute("SELECT * FROM products").fetchall()
    conn.close()
    data = [compute_cost(r) for r in rows]

    total_price = sum(d["price"] or 0 for d in data)
    total_sale = sum((d["sale_price"] or 0) for d in data if d["status"] == "sold")
    total_depreciation = sum((d["depreciation"] or 0) for d in data if d["depreciation"] is not None)
    in_use = [d for d in data if d["status"] == "in_use"]
    sold = [d for d in data if d["status"] == "sold"]
    damaged = [d for d in data if d["status"] == "damaged"]

    # 在售物品的当前总持有成本（累计到今天的净消耗）
    current_daily_total = round(sum(d["daily_cost"] for d in in_use), 2)

    # ---- 新增三项核心指标 ----
    # ① 持有资产总额：仅统计“使用中”的资产（不含已售出/已损坏），按购入价计
    held_value = round(sum((d["price"] or 0) for d in in_use), 2)
    # ② 总投入：历史累计投入（所有未删除记录的购入价之和，含已售/已损）
    total_invested = round(total_price, 2)
    # ③ 总收益/亏损：已结算资产（售出+损坏）的盈亏合计
    settled = [d for d in data if d.get("profit_loss") is not None]
    total_pnl = round(sum(d["profit_loss"] for d in settled), 2)
    profit_count = sum(1 for d in settled if d["profit_loss"] > 0)
    loss_count = sum(1 for d in settled if d["profit_loss"] < 0)

    # 品牌分布
    brand_map = {}
    for d in data:
        b = d["brand"] or "未标注"
        brand_map[b] = brand_map.get(b, 0) + (d["price"] or 0)
    brand_dist = [{"name": k, "value": round(v, 2)} for k, v in brand_map.items()]

    # 分类分布
    cat_map = {}
    for d in data:
        c = d["category"] or "未分类"
        cat_map[c] = cat_map.get(c, 0) + 1
    cat_dist = [{"name": k, "value": v} for k, v in cat_map.items()]

    return jsonify({
        "ok": True,
        "data": {
            "total_count": len(data),
            "in_use_count": len(in_use),
            "sold_count": len(sold),
            "damaged_count": len(damaged),
            "total_price": round(total_price, 2),
            "total_sale": round(total_sale, 2),
            "total_depreciation": round(total_depreciation, 2),
            "current_daily_total": current_daily_total,
            "held_value": held_value,
            "total_invested": total_invested,
            "total_pnl": total_pnl,
            "profit_count": profit_count,
            "loss_count": loss_count,
            "brand_dist": brand_dist,
            "cat_dist": cat_dist,
        },
    })


@app.route("/api/report/depreciation", methods=["GET"])
def report_depreciation():
    """折旧 & 每日成本排名数据（供图表）"""
    conn = get_db()
    rows = conn.execute("SELECT * FROM products ORDER BY purchase_date").fetchall()
    conn.close()
    data = [compute_cost(r) for r in rows]

    # 每日持有成本 Top（所有已结算的按最终成本，在售按当前日均）
    daily_rank = sorted(data, key=lambda d: d["daily_cost"], reverse=True)
    daily_rank = [
        {
            "name": d["name"],
            "daily_cost": d["daily_cost"],
            "status": d["status"],
        }
        for d in daily_rank
    ]

    # 折旧（仅已结算）
    dep = [d for d in data if d["depreciation"] is not None]
    dep_rank = sorted(dep, key=lambda d: d["depreciation"], reverse=True)
    dep_rank = [
        {
            "name": d["name"],
            "depreciation": d["depreciation"],
            "rate": d["depreciation_rate"],
            "final_cost": d["final_holding_cost"],
        }
        for d in dep_rank
    ]

    # 购买时间线（累计投入）
    timeline = []
    cum = 0.0
    for d in sorted(data, key=lambda x: x["purchase_date"]):
        cum += d["price"] or 0
        timeline.append({"date": d["purchase_date"], "cum_price": round(cum, 2), "name": d["name"]})

    return jsonify({
        "ok": True,
        "data": {"daily_rank": daily_rank, "dep_rank": dep_rank, "timeline": timeline},
    })


# ---------- 数据导出 ----------
EXPORT_FIELDS = ["name", "brand", "category", "price", "purchase_date",
                  "config", "status", "sale_date", "sale_price", "custom_fields", "notes"]


@app.route("/api/export", methods=["GET"])
def export_data():
    """导出所有资产数据，支持 JSON 和 CSV 格式"""
    fmt = request.args.get("format", "json").lower()
    conn = get_db()
    rows = conn.execute("SELECT * FROM products ORDER BY purchase_date DESC, id DESC").fetchall()
    conn.close()

    products = []
    for r in rows:
        item = {}
        for f in EXPORT_FIELDS:
            val = r[f]
            if f == "custom_fields" and val:
                try:
                    val = json.loads(val)
                except Exception:
                    val = {}
            item[f] = val
        products.append(item)

    if fmt == "csv":
        import csv
        import io
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=EXPORT_FIELDS)
        writer.writeheader()
        for p in products:
            row = dict(p)
            if isinstance(row.get("custom_fields"), dict):
                row["custom_fields"] = json.dumps(row["custom_fields"], ensure_ascii=False)
            writer.writerow(row)
        csv_content = output.getvalue()
        return Response(
            csv_content,
            mimetype="text/csv; charset=utf-8",
            headers={"Content-Disposition": "attachment; filename=asset_tracker_export.csv"},
        )

    # 默认 JSON
    payload = {
        "version": "1.0",
        "export_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(products),
        "products": products,
    }
    return Response(
        json.dumps(payload, ensure_ascii=False, indent=2),
        mimetype="application/json; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=asset_tracker_export.json"},
    )


# ---------- 数据导入 ----------
@app.route("/api/import", methods=["POST"])
def import_data():
    """导入资产数据，支持 JSON 和 CSV 文件"""
    if "file" not in request.files:
        return jsonify({"ok": False, "msg": "请选择要导入的文件"}), 400

    file = request.files["file"]
    mode = request.form.get("mode", "append")  # append 或 replace
    filename = file.filename.lower()

    try:
        if filename.endswith(".json"):
            content = file.read().decode("utf-8-sig")
            data = json.loads(content)
            products = data.get("products", data) if isinstance(data, dict) else data
            if not isinstance(products, list):
                return jsonify({"ok": False, "msg": "JSON 格式不正确，缺少 products 数组"}), 400
        elif filename.endswith(".csv"):
            import csv
            content = file.read().decode("utf-8-sig")
            reader = csv.DictReader(content.splitlines())
            products = []
            for row in reader:
                item = {}
                for f in EXPORT_FIELDS:
                    val = row.get(f, "")
                    if f == "price" and val:
                        try:
                            val = float(val)
                        except ValueError:
                            val = 0
                    elif f == "sale_price" and val:
                        try:
                            val = float(val)
                        except ValueError:
                            val = None
                    elif f == "custom_fields" and val:
                        try:
                            val = json.loads(val)
                        except Exception:
                            val = {}
                    elif val == "":
                        val = None
                    item[f] = val
                products.append(item)
        else:
            return jsonify({"ok": False, "msg": "仅支持 .json 和 .csv 文件"}), 400
    except Exception as e:
        return jsonify({"ok": False, "msg": f"文件解析失败：{str(e)}"}), 400

    if not products:
        return jsonify({"ok": False, "msg": "文件中没有有效数据"}), 400

    conn = get_db()
    if mode == "replace":
        conn.execute("DELETE FROM products")

    inserted = 0
    skipped = 0
    for p in products:
        name = (p.get("name") or "").strip()
        price = p.get("price")
        purchase_date = p.get("purchase_date")
        if not name or price is None or not purchase_date:
            skipped += 1
            continue
        try:
            custom_fields = p.get("custom_fields") or {}
            if isinstance(custom_fields, str):
                custom_fields = json.loads(custom_fields)
            conn.execute(
                """
                INSERT INTO products
                (name, brand, category, price, purchase_date, config, status, sale_date, sale_price, custom_fields, notes)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    name,
                    p.get("brand") or "",
                    p.get("category") or "",
                    float(price),
                    purchase_date,
                    p.get("config") or "",
                    p.get("status") or "in_use",
                    p.get("sale_date"),
                    p.get("sale_price"),
                    json.dumps(custom_fields, ensure_ascii=False),
                    p.get("notes") or "",
                ),
            )
            inserted += 1
        except Exception:
            skipped += 1

    conn.commit()
    conn.close()
    return jsonify({"ok": True, "inserted": inserted, "skipped": skipped, "total": len(products)})


# ---------- 托盘图标 ----------
def build_tray_image():
    """用 PIL 画一个柱状图小图标（蓝底白色柱状）"""
    from PIL import Image, ImageDraw
    s = 64
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([2, 2, s - 2, s - 2], radius=14, fill=(91, 140, 255, 255))
    d.rectangle([15, 34, 24, 48], fill=(255, 255, 255, 255))
    d.rectangle([28, 26, 37, 48], fill=(255, 255, 255, 255))
    d.rectangle([41, 17, 50, 48], fill=(255, 255, 255, 255))
    return img


def run_desktop():
    """桌面模式：后台起服务 + 自动打开浏览器 + 系统托盘图标（可退出）"""
    ensure_port_free(PORT)
    server = make_server("127.0.0.1", PORT, app, threaded=True)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    # 稍等服务就绪后自动打开浏览器
    threading.Timer(1.0, lambda: webbrowser.open(URL)).start()

    # 托盘（仅桌面环境）
    try:
        import pystray

        def open_page(icon, item):
            webbrowser.open(URL)

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
        icon.run()  # 阻塞主线程，直到退出
    except Exception:
        # 无托盘环境则退化为常驻服务
        try:
            t.join()
        except KeyboardInterrupt:
            server.shutdown()
            server.server_close()


def run_dev():
    """开发模式：make_server + 优雅退出 + 自动开浏览器"""
    init_db()
    ensure_port_free(PORT)
    server = make_server("127.0.0.1", PORT, app, threaded=True)
    threading.Timer(1.0, lambda: webbrowser.open(URL)).start()
    print(f" * 服务已启动: {URL}")
    print(" * 按 Ctrl+C 退出")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭服务...")
    finally:
        server.shutdown()
        server.server_close()
        print("已退出")


# ---------- 启动 ----------
if __name__ == "__main__":
    init_db()
    if HEADLESS:
        # Docker / 服务器：纯服务模式
        ensure_port_free(PORT)
        server = make_server(HOST, PORT, app, threaded=True)
        print(f" * 服务已启动: http://{HOST}:{PORT}")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            server.shutdown()
            server.server_close()
    elif IS_FROZEN:
        # 打包后的 exe：托盘 + 自动开浏览器
        run_desktop()
    else:
        # 开发模式
        run_dev()
