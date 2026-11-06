# -*- coding: utf-8 -*-
"""数据导入导出：JSON / CSV，含公式注入防护与批量事务"""
import csv
import io
import json
import sqlite3
from contextlib import closing
from datetime import date, datetime

from flask import Blueprint, Response, jsonify, request

from ..config import DB_FILE
from ..db import get_db
from ..validators import (
    HOLDING_STATUS,
    VALID_STATUS,
    parse_custom_fields,
    parse_date,
    parse_money,
)

data_io_bp = Blueprint("data_io", __name__)

EXPORT_FIELDS = ["name", "brand", "category", "price", "purchase_date",
                 "config", "status", "sale_date", "sale_price",
                 "list_date", "list_price", "custom_fields", "notes"]

# 会让 Excel / WPS / Numbers 当成公式执行的起始字符。
# 导出时给这类单元格加一个前导单引号，把「=1+1」变成纯文本 —— 这是
# 典型的 CSV Injection（公式注入）：别人打开你导出的表格就触发了。
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r", "\n")


def _csv_safe(value):
    """把可能被电子表格当成公式的字符串转义为纯文本"""
    if not isinstance(value, str):
        return value
    if value and value[0] in _FORMULA_PREFIXES:
        # 纯数字（如 "-12.5"）不是公式，保持原样避免把负数变成文本
        try:
            float(value)
            return value
        except ValueError:
            return "'" + value
    return value


def _backup_before_replace(conn):
    """覆盖导入前做一次整库备份（滚动一份 .backup）

    用 SQLite 的 backup API 而不是复制文件：WAL 模式下直接拷文件可能拿到
    不一致的快照。备份失败就取消导入——宁可这次不导，也不能删了救不回来。
    """
    bak = DB_FILE + ".backup"
    dst = None
    try:
        dst = sqlite3.connect(bak)
        with dst:
            conn.backup(dst)
        return True
    except Exception:
        return False
    finally:
        if dst is not None:
            try:
                dst.close()
            except Exception:
                pass


@data_io_bp.route("/export", methods=["GET"])
def export_data():
    """导出所有资产数据，支持 JSON 和 CSV 格式"""
    fmt = request.args.get("format", "json").lower()
    with closing(get_db()) as conn:
        rows = conn.execute("SELECT * FROM products ORDER BY purchase_date DESC, id DESC").fetchall()

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

    stamp = datetime.now().strftime("%Y%m%d_%H%M")

    if fmt == "csv":
        # 必须带 UTF-8 BOM，否则 Excel 打开中文会乱码
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=EXPORT_FIELDS)
        writer.writeheader()
        for p in products:
            row = dict(p)
            if isinstance(row.get("custom_fields"), dict):
                row["custom_fields"] = json.dumps(row["custom_fields"], ensure_ascii=False)
            writer.writerow({k: _csv_safe(v) for k, v in row.items()})
        return Response(
            "\ufeff" + output.getvalue(),
            # mimetype 只写类型，charset 由 Flask 自动补；
            # 写成 "text/csv; charset=utf-8" 会和 Flask 补的拼成两份
            mimetype="text/csv",
            headers={"Content-Disposition": f"attachment; filename=asset_tracker_{stamp}.csv"},
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
        mimetype="application/json",
        headers={"Content-Disposition": f"attachment; filename=asset_tracker_{stamp}.json"},
    )


@data_io_bp.route("/import", methods=["POST"])
def import_data():
    """导入资产数据，支持 JSON 和 CSV 文件"""
    if "file" not in request.files:
        return jsonify({"ok": False, "msg": "请选择要导入的文件"}), 400

    file = request.files["file"]
    mode = (request.form.get("mode") or "append").strip().lower()
    if mode not in ("append", "replace"):
        return jsonify({"ok": False, "msg": "导入模式不正确"}), 400
    filename = (file.filename or "").lower()

    try:
        raw = file.read()
        # 兼容 UTF-8 BOM 与 Excel 导出的 GBK 编码 CSV
        for enc in ("utf-8-sig", "utf-8", "gb18030"):
            try:
                content = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        else:
            return jsonify({"ok": False, "msg": "文件编码无法识别，请另存为 UTF-8 编码"}), 400

        if filename.endswith(".json"):
            data = json.loads(content)
            products = data.get("products", data) if isinstance(data, dict) else data
            if not isinstance(products, list):
                return jsonify({"ok": False, "msg": "JSON 格式不正确，缺少 products 数组"}), 400
        elif filename.endswith(".csv"):
            # 用 StringIO 交给 csv 模块，正确处理引号包裹的换行与逗号
            reader = csv.DictReader(io.StringIO(content))
            products = []
            for row in reader:
                item = {}
                for f in EXPORT_FIELDS:
                    val = row.get(f, "")
                    if f in ("price", "sale_price", "list_price"):
                        val = val.strip() if isinstance(val, str) else val
                        if val in ("", None):
                            val = None
                        else:
                            try:
                                val = float(val)
                            except ValueError:
                                val = None
                    elif f == "custom_fields":
                        val = parse_custom_fields(val)
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

    with closing(get_db()) as conn:
        # 追加导入时按「名称 + 价格 + 购买日期」去重（与现有数据比对）
        seen = set()
        if mode != "replace":
            for r in conn.execute("SELECT name, price, purchase_date FROM products"):
                seen.add((r["name"], round(float(r["price"] or 0), 2), r["purchase_date"]))

        inserted = 0
        skipped = 0
        batch = []
        for p in products:
            if not isinstance(p, dict):
                skipped += 1
                continue
            name = (p.get("name") or "").strip()
            if not name:
                skipped += 1
                continue
            price, err = parse_money(p.get("price"), allow_blank=True)
            purchase_date = parse_date(p.get("purchase_date"))
            if err or purchase_date is None or price is None:
                skipped += 1
                continue
            # 与新增接口保持同一口径：购买日期不能晚于今天，
            # 否则持有天数恒为 0，报表里的日均成本会变成全额价格
            if purchase_date > date.today().isoformat():
                skipped += 1
                continue

            key = (name, round(price, 2), purchase_date)
            if key in seen:
                skipped += 1
                continue
            seen.add(key)

            status = p.get("status") if p.get("status") in VALID_STATUS else "in_use"
            sale_date = parse_date(p.get("sale_date")) if status not in HOLDING_STATUS else None
            sale_price = p.get("sale_price")
            if status == "sold":
                sp, sp_err = parse_money(sale_price, allow_blank=True)
                sale_price = sp if not sp_err else None
            else:
                sale_price = None

            # 待售字段只在待售状态下有意义，其余状态留空，避免脏数据
            if status == "for_sale":
                list_date = parse_date(p.get("list_date")) or purchase_date
                list_price, lp_err = parse_money(p.get("list_price"), allow_blank=True)
                if lp_err:
                    list_price = None
            else:
                list_date = None
                list_price = None

            batch.append((
                name,
                (p.get("brand") or "").strip() if isinstance(p.get("brand"), str) else "",
                (p.get("category") or "").strip() if isinstance(p.get("category"), str) else "",
                price,
                purchase_date,
                (p.get("config") or "").strip() if isinstance(p.get("config"), str) else "",
                status,
                sale_date,
                sale_price,
                list_date,
                list_price,
                json.dumps(parse_custom_fields(p.get("custom_fields")), ensure_ascii=False),
                (p.get("notes") or "").strip() if isinstance(p.get("notes"), str) else "",
            ))

        # 关键顺序：先把整份文件校验成 batch，确认有可写入的行，才允许清空。
        # 否则传一份全是不合法行的文件，会先把原数据删光、再插 0 条。
        if mode == "replace":
            if not batch:
                return jsonify({"ok": False,
                                "msg": "文件中没有可导入的有效数据，已保留原有记录"}), 400
            if not _backup_before_replace(conn):
                return jsonify({"ok": False,
                                "msg": "覆盖导入前备份失败，已取消导入（原数据未改动）"}), 500
            conn.execute("DELETE FROM products")

        # 单事务批量写入：几千行时逐条 execute 要多花一个数量级的时间
        if batch:
            conn.execute("SAVEPOINT bulk_insert")
            try:
                conn.executemany(
                    """
                    INSERT INTO products
                    (name, brand, category, price, purchase_date, config, status,
                     sale_date, sale_price, list_date, list_price, custom_fields, notes)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    batch,
                )
                conn.execute("RELEASE bulk_insert")
                inserted = len(batch)
            except sqlite3.DatabaseError:
                # 整批失败则回滚到保存点，再退回逐条插入，
                # 个别坏数据不会连累整份文件，也不会留下半截数据
                conn.execute("ROLLBACK TO bulk_insert")
                conn.execute("RELEASE bulk_insert")
                inserted = 0
                for row in batch:
                    try:
                        conn.execute(
                            "INSERT INTO products (name, brand, category, price, purchase_date, "
                            "config, status, sale_date, sale_price, list_date, list_price, "
                            "custom_fields, notes) "
                            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            row,
                        )
                        inserted += 1
                    except sqlite3.DatabaseError:
                        skipped += 1

        conn.commit()

    return jsonify({"ok": True, "inserted": inserted, "skipped": skipped, "total": len(products)})
