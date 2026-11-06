# -*- coding: utf-8 -*-
"""资产：CRUD、出售/损坏、待售、撤销删除"""
import json
from contextlib import closing
from datetime import date

from flask import Blueprint, jsonify

from ..costing import compute_cost
from ..db import get_db
from ..http import json_body
from ..validators import (
    VALID_STATUS,
    parse_custom_fields,
    parse_date,
    parse_money,
    parse_purchase_date,
)

products_bp = Blueprint("products", __name__)
__all__ = ["products_bp"]


@products_bp.route("/products", methods=["GET"])
def list_products():
    with closing(get_db()) as conn:
        rows = conn.execute(
            "SELECT * FROM products ORDER BY purchase_date DESC, id DESC"
        ).fetchall()
    data = [compute_cost(r) for r in rows]
    return jsonify({"ok": True, "data": data})


@products_bp.route("/products", methods=["POST"])
def create_product():
    p = json_body()
    name = (p.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "msg": "名称不能为空"}), 400
    if len(name) > 120:
        return jsonify({"ok": False, "msg": "名称过长（最多 120 字）"}), 400
    price, err = parse_money(p.get("price"))
    if err:
        return jsonify({"ok": False, "msg": err}), 400
    purchase_date, err = parse_purchase_date(p.get("purchase_date"))
    if err:
        return jsonify({"ok": False, "msg": err}), 400

    with closing(get_db()) as conn:
        cur = conn.execute(
            """
            INSERT INTO products
            (name, brand, category, price, purchase_date, config, status, sale_date, sale_price, custom_fields, notes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                name,
                (p.get("brand") or "").strip(),
                (p.get("category") or "").strip(),
                price,
                purchase_date,
                (p.get("config") or "").strip(),
                "in_use",
                None,
                None,
                json.dumps(p.get("custom_fields") or {}, ensure_ascii=False),
                (p.get("notes") or "").strip(),
            ),
        )
        conn.commit()
        new_id = cur.lastrowid
    return jsonify({"ok": True, "id": new_id})


@products_bp.route("/products/<int:pid>", methods=["PUT"])
def update_product(pid):
    p = json_body()
    name = (p.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "msg": "名称不能为空"}), 400
    price, err = parse_money(p.get("price"))
    if err:
        return jsonify({"ok": False, "msg": err}), 400
    purchase_date, err = parse_purchase_date(p.get("purchase_date"))
    if err:
        return jsonify({"ok": False, "msg": err}), 400

    with closing(get_db()) as conn:
        row = conn.execute(
            "SELECT status, sale_date, sale_price, list_date FROM products WHERE id=?", (pid,)
        ).fetchone()
        if row is None:
            return jsonify({"ok": False, "msg": "资产不存在"}), 404

        # 修改购买日期后不能晚于已有的处理日期，否则持有天数为负
        if row["sale_date"] and purchase_date > row["sale_date"]:
            return jsonify(
                {"ok": False, "msg": f"购买时间不能晚于处理日期（{row['sale_date']}）"}
            ), 400
        # 待售资产同理：购买日期不能晚于上架日期
        if row["list_date"] and purchase_date > row["list_date"]:
            return jsonify(
                {"ok": False, "msg": f"购买时间不能晚于上架日期（{row['list_date']}）"}
            ), 400

        # 状态与出售信息不由该接口修改，避免编辑时把已售/已损记录改回在用而丢数据
        conn.execute(
            """
            UPDATE products SET
                name=?, brand=?, category=?, price=?, purchase_date=?, config=?,
                custom_fields=?, notes=?
            WHERE id=?
            """,
            (
                name,
                (p.get("brand") or "").strip(),
                (p.get("category") or "").strip(),
                price,
                purchase_date,
                (p.get("config") or "").strip(),
                json.dumps(p.get("custom_fields") or {}, ensure_ascii=False),
                (p.get("notes") or "").strip(),
                pid,
            ),
        )
        conn.commit()
    return jsonify({"ok": True})


@products_bp.route("/products/<int:pid>", methods=["DELETE"])
def delete_product(pid):
    with closing(get_db()) as conn:
        row = conn.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone()
        if row is None:
            return jsonify({"ok": False, "msg": "资产不存在"}), 404
        conn.execute("DELETE FROM products WHERE id=?", (pid,))
        conn.commit()
    # 返回被删记录，供前端「撤销删除」重放
    return jsonify({"ok": True, "deleted": compute_cost(row)})


@products_bp.route("/products/<int:pid>/sell", methods=["POST"])
def sell_product(pid):
    """登记出售 / 损坏 / 恢复为使用中"""
    p = json_body()
    status = p.get("status") or "sold"
    # 只允许三种合法流转：出售 / 损坏 / 恢复使用中
    # for_sale 有独立的 /list 接口；从 /sell 写进来会产生
    # 「待售 + 结算日期、无上架日期」的非法组合
    if status not in ("sold", "damaged", "in_use"):
        return jsonify({"ok": False, "msg": "无效状态"}), 400

    with closing(get_db()) as conn:
        row = conn.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone()
        if row is None:
            return jsonify({"ok": False, "msg": "资产不存在"}), 404

        if status == "in_use":
            # 恢复使用中：结算与挂售信息一并清空，回到纯粹的持有状态
            conn.execute(
                "UPDATE products SET status='in_use', sale_date=NULL, sale_price=NULL, "
                "list_date=NULL, list_price=NULL WHERE id=?",
                (pid,),
            )
        else:
            sale_date = parse_date(p.get("sale_date")) or date.today().isoformat()
            # 处理日期不能早于购买日期（否则持有天数为负，成本计算失真）
            purchase_date = parse_date(row["purchase_date"]) or sale_date
            if sale_date < purchase_date:
                return jsonify({"ok": False, "msg": "处理日期不能早于购买日期"}), 400
            # 日期链路：购买 ≤ 上架 ≤ 售出，否则「挂了几天」是负数
            list_date = parse_date(row["list_date"]) if row["list_date"] else None
            if list_date and sale_date < list_date:
                return jsonify(
                    {"ok": False, "msg": f"处理日期不能早于上架日期（{list_date}）"}
                ), 400
            if sale_date > date.today().isoformat():
                return jsonify({"ok": False, "msg": "处理日期不能晚于今天"}), 400
            sale_price = None
            if status == "sold":
                # 售价必填：缺失时如果按 0 处理，会被算成「全额亏损」，
                # 看着像坏了一件，实际只是没填钱
                sale_price, err = parse_money(p.get("sale_price"))
                if err:
                    return jsonify({"ok": False,
                                    "msg": "请填写出售价格" if err == "请填写价格" else err}), 400
            conn.execute(
                "UPDATE products SET status=?, sale_date=?, sale_price=? WHERE id=?",
                (status, sale_date, sale_price, pid),
            )
        conn.commit()
    return jsonify({"ok": True})


@products_bp.route("/products/<int:pid>/list", methods=["POST"])
def mark_for_sale(pid):
    """资产转入待售清单

    只加状态与上架信息，不动购入价 / 购买日期——待售期间资产仍在手里，
    继续按购入价计提每日成本，看板上算的是「压了多少钱、挂了多久」。
    """
    p = json_body()
    with closing(get_db()) as conn:
        row = conn.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone()
        if row is None:
            return jsonify({"ok": False, "msg": "资产不存在"}), 404
        if row["status"] == "sold":
            return jsonify({"ok": False, "msg": "已售出的资产不能转待售"}), 400
        if row["status"] == "damaged":
            return jsonify({"ok": False, "msg": "已损坏的资产不能转待售"}), 400

        list_date = parse_date(p.get("list_date")) or date.today().isoformat()
        purchase_date = parse_date(row["purchase_date"]) or list_date
        if list_date < purchase_date:
            return jsonify({"ok": False, "msg": "上架日期不能早于购买日期"}), 400
        if list_date > date.today().isoformat():
            return jsonify({"ok": False, "msg": "上架日期不能晚于今天"}), 400
        list_price, err = parse_money(p.get("list_price"), allow_blank=True)
        if err:
            return jsonify({"ok": False, "msg": err}), 400

        conn.execute(
            "UPDATE products SET status='for_sale', list_date=?, list_price=? WHERE id=?",
            (list_date, list_price, pid),
        )
        conn.commit()
    return jsonify({"ok": True})


@products_bp.route("/products/<int:pid>/unlist", methods=["POST"])
def unmark_for_sale(pid):
    """从待售清单下架，退回使用中"""
    with closing(get_db()) as conn:
        row = conn.execute("SELECT status FROM products WHERE id=?", (pid,)).fetchone()
        if row is None:
            return jsonify({"ok": False, "msg": "资产不存在"}), 404
        if row["status"] != "for_sale":
            return jsonify({"ok": False, "msg": "该资产不在待售清单中"}), 400
        conn.execute(
            "UPDATE products SET status='in_use', list_date=NULL, list_price=NULL WHERE id=?",
            (pid,),
        )
        conn.commit()
    return jsonify({"ok": True})


@products_bp.route("/products/<int:pid>/ask", methods=["PATCH"])
def update_ask_price(pid):
    """改挂单价：待售清单里直接改价，不用开编辑抽屉。

    改价是最频繁的动作（挂高了没人问，一点点往下试），所以单独开个轻量
    接口。只动 list_price 一个字段，不碰名称/状态，避免把别的东西一起改坏。
    """
    p = json_body()
    price, err = parse_money(p.get("list_price"))
    if err:
        return jsonify({"ok": False, "msg": err}), 400

    with closing(get_db()) as conn:
        row = conn.execute(
            "SELECT status, price FROM products WHERE id=?", (pid,)
        ).fetchone()
        if row is None:
            return jsonify({"ok": False, "msg": "资产不存在"}), 404
        if row["status"] != "for_sale":
            return jsonify({"ok": False, "msg": "该资产不在待售清单中"}), 400
        conn.execute("UPDATE products SET list_price=? WHERE id=?", (price, pid))
        conn.commit()

    # 顺手把改价后的盈亏算回给前端，省一次往返
    cost = row["price"] or 0
    return jsonify({
        "ok": True,
        "list_price": price,
        "list_pnl": round(price - cost, 2) if cost else None,
    })


@products_bp.route("/products/restore", methods=["POST"])
def restore_product():
    """撤销删除：按删除接口返回的完整记录重新写回（含原 id 与状态）"""
    p = json_body()
    name = (p.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "msg": "记录已失效"}), 400
    price, err = parse_money(p.get("price"), allow_blank=True)
    if err:
        return jsonify({"ok": False, "msg": err}), 400
    purchase_date = parse_date(p.get("purchase_date")) or date.today().isoformat()
    status = p.get("status") if p.get("status") in VALID_STATUS else "in_use"

    # 撤销删除也走同一套日期口径：不能把未来的购买日期写回来
    if purchase_date > date.today().isoformat():
        return jsonify({"ok": False, "msg": "购买时间不能晚于今天"}), 400

    # 结算 / 挂售字段也要走同一套校验：
    # 这两个字段以前是原样落库的，一个 "abc" 就能让 compute_cost 抛 TypeError，
    # 进而把列表与报表全部打成 500。
    sale_price, err = parse_money(p.get("sale_price"), allow_blank=True)
    if err:
        return jsonify({"ok": False, "msg": f"出售价格不正确：{err}"}), 400
    list_price, err = parse_money(p.get("list_price"), allow_blank=True)
    if err:
        return jsonify({"ok": False, "msg": f"挂单价格不正确：{err}"}), 400
    sale_date = parse_date(p.get("sale_date"))
    list_date = parse_date(p.get("list_date"))
    if sale_date and sale_date < purchase_date:
        return jsonify({"ok": False, "msg": "处理日期不能早于购买日期"}), 400
    if list_date and list_date < purchase_date:
        return jsonify({"ok": False, "msg": "上架日期不能早于购买日期"}), 400
    if status == "in_use":
        # 恢复成持有状态时，结算与挂售信息一并清空，避免脏组合
        sale_date = sale_price = list_date = list_price = None
    elif status == "for_sale":
        sale_date = sale_price = None
    elif status == "sold":
        list_date = list_price = None
    else:  # damaged
        sale_price = None
        list_date = list_price = None

    with closing(get_db()) as conn:
        old_id = p.get("id")
        if old_id and conn.execute("SELECT 1 FROM products WHERE id=?", (old_id,)).fetchone():
            old_id = None  # id 已被占用，交给自增
        cur = conn.execute(
            """
            INSERT INTO products
            (id, name, brand, category, price, purchase_date, config, status,
             sale_date, sale_price, list_date, list_price, custom_fields, notes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                old_id,
                name,
                p.get("brand") or "",
                p.get("category") or "",
                price or 0,
                purchase_date,
                p.get("config") or "",
                status,
                sale_date,
                sale_price,
                list_date,
                list_price,
                json.dumps(parse_custom_fields(p.get("custom_fields")), ensure_ascii=False),
                p.get("notes") or "",
            ),
        )
        conn.commit()
        new_id = cur.lastrowid
    return jsonify({"ok": True, "id": new_id})
