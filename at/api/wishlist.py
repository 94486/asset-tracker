# -*- coding: utf-8 -*-
"""预购清单：CRUD、改价、放弃/恢复、转化、看板"""
import json
import sqlite3
from contextlib import closing
from datetime import date, datetime

from flask import Blueprint, jsonify, request

from ..costing import days_between
from ..db import get_db
from ..http import json_body
from ..reporting import others_bucket
from ..validators import (
    WISH_PRIORITY,
    WISH_STATUS,
    parse_custom_fields,
    parse_date,
    parse_money,
    parse_purchase_date,
)

wishlist_bp = Blueprint("wishlist", __name__)

WISH_FIELDS = ("name", "brand", "category", "target_price", "expected_date",
               "priority", "source", "status", "custom_fields", "notes", "config")


def _wish_row(row):
    """把 wishlist 行转成前端用的 dict"""
    d = dict(row)
    try:
        d["custom_fields"] = json.loads(d.get("custom_fields") or "{}")
    except Exception:
        d["custom_fields"] = {}
    # 预算与目标日期的派生信息，省得前端各算一遍
    try:
        price = float(d.get("target_price") or 0)
    except (TypeError, ValueError):
        price = 0.0          # 外部写入的 TEXT 不影响列表渲染
    ed = parse_date(d.get("expected_date"))
    if ed:
        d["days_left"] = (date.fromisoformat(ed) - date.today()).days
    else:
        d["days_left"] = None
    if d.get("converted_at"):
        d["waited_days"] = days_between(
            (d.get("created_at") or "")[:10], d["converted_at"][:10]
        )
    else:
        d["waited_days"] = days_between((d.get("created_at") or "")[:10], date.today().isoformat())
    d["target_price"] = round(price, 2)
    return d


@wishlist_bp.route("/wishlist", methods=["GET"])
def list_wishlist():
    status = request.args.get("status", "").strip()
    with closing(get_db()) as conn:
        if status and status in WISH_STATUS:
            rows = conn.execute(
                "SELECT * FROM wishlist WHERE status=? "
                "ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, "
                "id DESC", (status,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM wishlist ORDER BY "
                "CASE status WHEN 'ready' THEN 0 WHEN 'watching' THEN 1 "
                "WHEN 'converted' THEN 2 ELSE 3 END, "
                "CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, "
                "id DESC"
            ).fetchall()
    return jsonify({"ok": True, "data": [_wish_row(r) for r in rows]})


@wishlist_bp.route("/wishlist", methods=["POST"])
def create_wish():
    p = json_body()
    name = (p.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "msg": "名称不能为空"}), 400
    if len(name) > 120:
        return jsonify({"ok": False, "msg": "名称过长（最多 120 字）"}), 400

    # 预购允许「先记下意向、价格待定」，所以价格可以留空（记 0）
    target_price, err = parse_money(p.get("target_price"), allow_blank=True)
    if err:
        return jsonify({"ok": False, "msg": "预算价格不正确"}), 400
    expected_date = parse_date(p.get("expected_date"))
    priority = p.get("priority") if p.get("priority") in WISH_PRIORITY else "normal"
    status = p.get("status") if p.get("status") in ("watching", "ready") else "watching"

    with closing(get_db()) as conn:
        cur = conn.execute(
            """
            INSERT INTO wishlist
            (name, brand, category, target_price, expected_date, priority,
             source, status, custom_fields, notes, config)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                name,
                (p.get("brand") or "").strip(),
                (p.get("category") or "").strip(),
                target_price or 0,
                expected_date,
                priority,
                (p.get("source") or "").strip(),
                status,
                json.dumps(parse_custom_fields(p.get("custom_fields")), ensure_ascii=False),
                (p.get("notes") or "").strip(),
                (p.get("config") or "").strip(),
            ),
        )
        conn.commit()
        new_id = cur.lastrowid
    return jsonify({"ok": True, "id": new_id})


@wishlist_bp.route("/wishlist/<int:wid>", methods=["PUT"])
def update_wish(wid):
    p = json_body()
    name = (p.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "msg": "名称不能为空"}), 400
    target_price, err = parse_money(p.get("target_price"), allow_blank=True)
    if err:
        return jsonify({"ok": False, "msg": "预算价格不正确"}), 400
    priority = p.get("priority") if p.get("priority") in WISH_PRIORITY else "normal"
    status = p.get("status") if p.get("status") in ("watching", "ready") else "watching"

    with closing(get_db()) as conn:
        row = conn.execute("SELECT status FROM wishlist WHERE id=?", (wid,)).fetchone()
        if row is None:
            return jsonify({"ok": False, "msg": "预购记录不存在"}), 404
        if row["status"] == "converted":
            return jsonify({"ok": False, "msg": "已转化的预购不能编辑"}), 400
        conn.execute(
            """
            UPDATE wishlist SET
                name=?, brand=?, category=?, target_price=?, expected_date=?,
                priority=?, source=?, status=?, custom_fields=?, notes=?, config=?
            WHERE id=?
            """,
            (
                name,
                (p.get("brand") or "").strip(),
                (p.get("category") or "").strip(),
                target_price or 0,
                parse_date(p.get("expected_date")),
                priority,
                (p.get("source") or "").strip(),
                status,
                json.dumps(parse_custom_fields(p.get("custom_fields")), ensure_ascii=False),
                (p.get("notes") or "").strip(),
                (p.get("config") or "").strip(),
                wid,
            ),
        )
        conn.commit()
    return jsonify({"ok": True})


@wishlist_bp.route("/wishlist/<int:wid>/drop", methods=["POST"])
def drop_wish(wid):
    """标记为放弃：保留记录不删，方便以后回看「当初想买什么、为什么没买」"""
    with closing(get_db()) as conn:
        row = conn.execute("SELECT status FROM wishlist WHERE id=?", (wid,)).fetchone()
        if row is None:
            return jsonify({"ok": False, "msg": "预购记录不存在"}), 404
        if row["status"] == "converted":
            return jsonify({"ok": False, "msg": "已转化的预购不能标记放弃"}), 400
        conn.execute("UPDATE wishlist SET status='dropped' WHERE id=?", (wid,))
        conn.commit()
    return jsonify({"ok": True})


@wishlist_bp.route("/wishlist/<int:wid>/restore", methods=["POST"])
def restore_wish(wid):
    """从放弃状态恢复到观望中"""
    with closing(get_db()) as conn:
        row = conn.execute("SELECT status FROM wishlist WHERE id=?", (wid,)).fetchone()
        if row is None:
            return jsonify({"ok": False, "msg": "预购记录不存在"}), 404
        if row["status"] != "dropped":
            return jsonify({"ok": False, "msg": "只有已放弃的预购可以恢复"}), 400
        conn.execute("UPDATE wishlist SET status='watching' WHERE id=?", (wid,))
        conn.commit()
    return jsonify({"ok": True})


@wishlist_bp.route("/wishlist/<int:wid>", methods=["DELETE"])
def delete_wish(wid):
    with closing(get_db()) as conn:
        row = conn.execute("SELECT * FROM wishlist WHERE id=?", (wid,)).fetchone()
        if row is None:
            return jsonify({"ok": False, "msg": "预购记录不存在"}), 404
        conn.execute("DELETE FROM wishlist WHERE id=?", (wid,))
        conn.commit()
    return jsonify({"ok": True, "deleted": _wish_row(row)})


@wishlist_bp.route("/wishlist/<int:wid>/price", methods=["PATCH"])
def update_wish_price(wid):
    """改心理价：预购清单里直接改，配合比价做最终选购决策。

    只动 target_price，不动其他字段——这条清单的高频动作就是「心里价位
    下移一点再看」，为此开整个编辑抽屉太重。
    """
    p = json_body()
    price, err = parse_money(p.get("target_price"))
    if err:
        return jsonify({"ok": False, "msg": err}), 400

    with closing(get_db()) as conn:
        row = conn.execute("SELECT status FROM wishlist WHERE id=?", (wid,)).fetchone()
        if row is None:
            return jsonify({"ok": False, "msg": "预购记录不存在"}), 404
        if row["status"] == "converted":
            return jsonify({"ok": False, "msg": "已转化的预购不能再改心理价"}), 400
        conn.execute("UPDATE wishlist SET target_price=? WHERE id=?", (price, wid))
        conn.commit()
    return jsonify({"ok": True, "target_price": price})


@wishlist_bp.route("/wishlist/<int:wid>/convert", methods=["POST"])
def convert_wish(wid):
    """预购 → 正式资产

    这一步是两条清单之间唯一的接缝。要点：
      · 实际购买价 / 购买日期由用户在这时填，覆盖预购里的预算价——
        预算是意向，成交价才是成本口径
      · 转化与建资产必须同一事务，否则出现「预购标了已买、资产却没建」
        的半截状态，报表会凭空少一笔
      · 原预购记录保留（status=converted + product_id），留下决策轨迹
    """
    p = json_body()
    with closing(get_db()) as conn:
        row = conn.execute("SELECT * FROM wishlist WHERE id=?", (wid,)).fetchone()
        if row is None:
            return jsonify({"ok": False, "msg": "预购记录不存在"}), 404
        if row["status"] == "converted":
            return jsonify({"ok": False, "msg": "该预购已经转化过了"}), 400

        # 成交价：未填则回落到预算价，方便「按预算买到」的常见情况
        raw_price = p.get("price")
        if raw_price in (None, ""):
            raw_price = row["target_price"]
        price, err = parse_money(raw_price)
        if err:
            return jsonify({"ok": False, "msg": err}), 400
        purchase_date, err = parse_purchase_date(p.get("purchase_date"))
        if err:
            return jsonify({"ok": False, "msg": err}), 400

        conn.execute("SAVEPOINT convert")
        try:
            cur = conn.execute(
                """
                INSERT INTO products
                (name, brand, category, price, purchase_date, config, status,
                 custom_fields, notes)
                VALUES (?,?,?,?,?,?,?,?,?)
                """,
                (
                    row["name"],
                    p.get("brand") if p.get("brand") is not None else row["brand"],
                    p.get("category") if p.get("category") is not None else row["category"],
                    price,
                    purchase_date,
                    # 转换窗里没填规格时，沿用预购阶段记下的参数——
                    # 买的就是当初想买的那个配置，不该到这一步丢掉
                    (p.get("config") or row["config"] or "").strip(),
                    "in_use",
                    json.dumps(parse_custom_fields(row["custom_fields"]), ensure_ascii=False),
                    (p.get("notes") if p.get("notes") is not None else row["notes"]) or "",
                ),
            )
            product_id = cur.lastrowid
            conn.execute(
                "UPDATE wishlist SET status='converted', product_id=?, converted_at=? WHERE id=?",
                (product_id, datetime.now().strftime("%Y-%m-%d %H:%M:%S"), wid),
            )
            conn.execute("RELEASE convert")
            conn.commit()
        except sqlite3.DatabaseError as e:
            conn.execute("ROLLBACK TO convert")
            conn.execute("RELEASE convert")
            return jsonify({"ok": False, "msg": f"转化失败：{e}"}), 500

    return jsonify({"ok": True, "product_id": product_id})


@wishlist_bp.route("/wishlist/board", methods=["GET"])
def wishlist_board():
    """预购看板数据"""
    with closing(get_db()) as conn:
        rows = conn.execute("SELECT * FROM wishlist").fetchall()
        brand_rows = conn.execute(
            "SELECT COALESCE(NULLIF(brand, ''), '未标注') AS k, SUM(target_price) AS v, "
            "COUNT(*) AS c FROM wishlist WHERE status IN ('watching','ready') "
            "GROUP BY k ORDER BY v DESC"
        ).fetchall()
        cat_rows = conn.execute(
            "SELECT COALESCE(NULLIF(category, ''), '未分类') AS k, SUM(target_price) AS v, "
            "COUNT(*) AS c FROM wishlist WHERE status IN ('watching','ready') "
            "GROUP BY k ORDER BY v DESC"
        ).fetchall()
        month_rows = conn.execute(
            "SELECT substr(coalesce(converted_at, created_at), 1, 7) AS k, SUM(target_price) AS v "
            "FROM wishlist GROUP BY k ORDER BY k"
        ).fetchall()

    data = [_wish_row(r) for r in rows]
    active = [d for d in data if d["status"] in ("watching", "ready")]
    ready = [d for d in data if d["status"] == "ready"]
    converted = [d for d in data if d["status"] == "converted"]

    # 愿望清单总预算：只算还没买的，已买的不该继续占预算
    budget = round(sum(d["target_price"] or 0 for d in active), 2)
    # 转化率：已经买下的比例，是这张清单最有信息量的一个数字
    total_decided = len(active) + len(converted)
    convert_rate = round(len(converted) / total_decided * 100, 1) if total_decided else 0
    # 平均犹豫天数：从记录到转化，衡量「想买」到「真买」的间隔
    waits = [d["waited_days"] for d in converted if d["waited_days"] is not None]
    avg_wait = round(sum(waits) / len(waits), 1) if waits else 0

    # 优先级分布
    prio_dist = []
    for key, label in (("high", "很想要"), ("normal", "一般"), ("low", "观望")):
        grp = [d for d in active if d["priority"] == key]
        if grp:
            prio_dist.append({
                "name": label,
                "value": len(grp),
                "amount": round(sum(d["target_price"] or 0 for d in grp), 2),
            })

    # 预算 Top（图表只画前 12 个，其余合成 others）
    by_price = sorted(active, key=lambda d: d["target_price"] or 0, reverse=True)
    top = [
        {"name": d["name"], "value": d["target_price"], "priority": d["priority"]}
        for d in by_price[:12]
    ]
    others = others_bucket(by_price[12:], "target_price")

    # 未来 90 天的入手计划（按 expected_date 聚月）
    plan = {}
    for d in active:
        ed = d.get("expected_date")
        if not ed or len(ed) < 7:
            continue
        bucket = plan.setdefault(ed[:7], {"month": ed[:7], "count": 0, "value": 0.0})
        bucket["count"] += 1
        bucket["value"] += d["target_price"] or 0
    plan_list = [{"month": k, "count": v["count"], "value": round(v["value"], 2)}
                 for k, v in sorted(plan.items())]

    return jsonify({
        "ok": True,
        "data": {
            "total": len(data),
            "watching_count": len([d for d in data if d["status"] == "watching"]),
            "ready_count": len(ready),
            "converted_count": len(converted),
            "dropped_count": len([d for d in data if d["status"] == "dropped"]),
            "budget": budget,
            "ready_budget": round(sum(d["target_price"] or 0 for d in ready), 2),
            "convert_rate": convert_rate,
            "avg_wait_days": avg_wait,
            "brand_dist": [{"name": r["k"], "value": round(r["v"] or 0, 2), "count": r["c"]}
                           for r in brand_rows],
            "cat_dist": [{"name": r["k"], "value": round(r["v"] or 0, 2), "count": r["c"]}
                         for r in cat_rows],
            "priority_dist": prio_dist,
            "top_budget": top,
            "top_others": others,
            "plan": plan_list,
            "monthly": [{"month": r["k"], "value": round(r["v"] or 0, 2)} for r in month_rows],
        },
    })
