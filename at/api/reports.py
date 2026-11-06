# -*- coding: utf-8 -*-
"""报表：汇总、折旧/每日成本排名、待售看板"""
from contextlib import closing
from datetime import date

from flask import Blueprint, jsonify, request

from ..costing import compute_cost
from ..db import get_db
from ..reporting import build_timeline, others_bucket
from ..validators import HOLDING_STATUS

reports_bp = Blueprint("reports", __name__)


@reports_bp.route("/forsale/board", methods=["GET"])
def forsale_board():
    """待售看板：压货金额、挂单时长、预期回血"""
    with closing(get_db()) as conn:
        rows = conn.execute("SELECT * FROM products WHERE status='for_sale'").fetchall()
        # 已售出的用于算「成交折价」——挂单价 vs 实际成交价的偏差
        sold_rows = conn.execute(
            "SELECT * FROM products WHERE status='sold' AND sale_price IS NOT NULL"
        ).fetchall()

    data = [compute_cost(r) for r in rows]
    sold = [compute_cost(r) for r in sold_rows]
    today_iso = date.today().isoformat()

    book_value = round(sum(d["price"] or 0 for d in data), 2)        # 压货成本
    ask_value = round(sum(d["list_price"] or 0 for d in data), 2)     # 挂单报价合计
    expect_pnl = round(sum((d["list_pnl"] or 0) for d in data), 2)    # 若按挂单价成交的盈亏
    daily_cost = round(sum(d["daily_cost"] or 0 for d in data), 2)    # 每天还在烧的钱

    listed_days = [d["days_listed"] for d in data if d["days_listed"] is not None]
    avg_listed = round(sum(listed_days) / len(listed_days), 1) if listed_days else 0
    # 挂超过 30 天的算滞销，这批最该降价
    stale = [d for d in data if (d["days_listed"] or 0) >= 30]

    # 已售资产的成交折价率：挂单价 → 成交价平均低了多少
    discounts = []
    for d in sold:
        if d.get("list_price"):
            discounts.append((d["sale_price"] - d["list_price"]) / d["list_price"] * 100)
    avg_discount = round(sum(discounts) / len(discounts), 1) if discounts else None

    # 挂单时长分布（决定「该不该降价」的直观依据）
    buckets = [("0-7 天", 0, 7), ("8-30 天", 8, 30), ("31-90 天", 31, 90), ("90 天以上", 91, 10 ** 6)]
    age_dist = []
    for label, lo, hi in buckets:
        grp = [d for d in data if lo <= (d["days_listed"] or 0) <= hi]
        if grp:
            age_dist.append({
                "name": label,
                "value": len(grp),
                "amount": round(sum(d["price"] or 0 for d in grp), 2),
            })

    # 按分类看压货结构
    cat_map = {}
    for d in data:
        key = d.get("category") or "未分类"
        b = cat_map.setdefault(key, {"name": key, "count": 0, "cost": 0.0, "ask": 0.0})
        b["count"] += 1
        b["cost"] += d["price"] or 0
        b["ask"] += d["list_price"] or 0

    # 压货最久的 Top（图表限流）
    by_age = sorted(data, key=lambda d: d["days_listed"] or 0, reverse=True)
    old_top = [
        {"name": d["name"], "days": d["days_listed"], "price": d["price"],
         "list_price": d["list_price"]}
        for d in by_age[:12]
    ]

    return jsonify({
        "ok": True,
        "data": {
            "total": len(data),
            "book_value": book_value,
            "ask_value": ask_value,
            "expect_pnl": expect_pnl,
            "daily_cost": daily_cost,
            "avg_listed_days": avg_listed,
            "stale_count": len(stale),
            "stale_value": round(sum(d["price"] or 0 for d in stale), 2),
            "avg_discount": avg_discount,
            "sold_with_list": len(discounts),
            "age_dist": age_dist,
            "cat_dist": sorted(cat_map.values(), key=lambda x: -x["cost"]),
            "old_top": old_top,
            "today": today_iso,
        },
    })


@reports_bp.route("/report/summary", methods=["GET"])
def report_summary():
    """汇总指标。

    分组维度（品牌 / 分类 / 月度 / 年度）交给 SQLite 的 GROUP BY 完成，
    Python 只负责需要日期运算的单条成本推导。
    """
    with closing(get_db()) as conn:
        rows = conn.execute("SELECT * FROM products").fetchall()
        brand_rows = conn.execute(
            "SELECT COALESCE(NULLIF(brand, ''), '未标注') AS k, SUM(price) AS v "
            "FROM products GROUP BY k ORDER BY v DESC"
        ).fetchall()
        cat_rows = conn.execute(
            "SELECT COALESCE(NULLIF(category, ''), '未分类') AS k, "
            "COUNT(*) AS c, SUM(price) AS v "
            "FROM products GROUP BY k ORDER BY v DESC"
        ).fetchall()
        month_rows = conn.execute(
            "SELECT substr(purchase_date, 1, 7) AS k, SUM(price) AS v FROM products "
            "WHERE length(purchase_date) >= 7 GROUP BY k ORDER BY k"
        ).fetchall()
        year_rows = conn.execute(
            "SELECT substr(purchase_date, 1, 4) AS k, SUM(price) AS v FROM products "
            "WHERE length(purchase_date) >= 4 GROUP BY k ORDER BY k"
        ).fetchall()

    data = [compute_cost(r) for r in rows]

    total_price = sum(d["price"] or 0 for d in data)
    total_sale = sum((d["sale_price"] or 0) for d in data if d["status"] == "sold")
    total_depreciation = sum((d["depreciation"] or 0) for d in data if d["depreciation"] is not None)
    in_use = [d for d in data if d["status"] == "in_use"]
    # 待售资产仍算「持有中」：钱还压着，只是挂了牌子，若不计入会让持有
    # 资产总额凭空掉一块，看起来像资产消失了
    for_sale = [d for d in data if d["status"] == "for_sale"]
    holding = [d for d in data if d["status"] in HOLDING_STATUS]
    sold = [d for d in data if d["status"] == "sold"]
    damaged = [d for d in data if d["status"] == "damaged"]

    # 持有物品的当前总持有成本（累计到今天的净消耗）
    current_daily_total = round(sum(d["daily_cost"] for d in holding), 2)
    # ① 持有资产总额：使用中 + 待售（不含已售出/已损坏），按购入价计
    held_value = round(sum((d["price"] or 0) for d in holding), 2)
    # ② 总投入：历史累计投入（所有未删除记录的购入价之和，含已售/已损）
    total_invested = round(total_price, 2)
    # ③ 总收益/亏损：已结算资产（售出+损坏）的盈亏合计
    settled = [d for d in data if d.get("profit_loss") is not None]
    total_pnl = round(sum(d["profit_loss"] for d in settled), 2)
    profit_count = sum(1 for d in settled if d["profit_loss"] > 0)
    loss_count = sum(1 for d in settled if d["profit_loss"] < 0)

    # 品牌分布（SQL 已按投入金额聚合）
    brand_dist = [{"name": r["k"], "value": round(r["v"] or 0, 2)} for r in brand_rows]

    # 分类分布（件数）与分类投入金额，同一次 GROUP BY 出结果
    cat_dist = [{"name": r["k"], "value": r["c"]} for r in cat_rows]
    cat_amount = [{"name": r["k"], "value": round(r["v"] or 0, 2)} for r in cat_rows]

    # 状态构成（用于总览环形图）
    status_dist = [
        {"name": "使用中", "value": len(in_use), "amount": round(sum(d["price"] or 0 for d in in_use), 2)},
        {"name": "待售", "value": len(for_sale), "amount": round(sum(d["price"] or 0 for d in for_sale), 2)},
        {"name": "已售出", "value": len(sold), "amount": round(sum(d["price"] or 0 for d in sold), 2)},
        {"name": "已损坏", "value": len(damaged), "amount": round(sum(d["price"] or 0 for d in damaged), 2)},
    ]

    # 月度 / 年度投入（后端 GROUP BY，避免前端重复计算与口径差异）
    monthly = [{"month": r["k"], "value": round(r["v"] or 0, 2)} for r in month_rows]
    yearly = [{"year": r["k"], "value": round(r["v"] or 0, 2)} for r in year_rows]

    # 持有资产的平均持有天数，用作概览对照
    avg_days = round(sum(d["days_held"] for d in holding) / len(holding), 1) if holding else 0

    return jsonify({
        "ok": True,
        "data": {
            "total_count": len(data),
            "in_use_count": len(in_use),
            "for_sale_count": len(for_sale),
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
            "cat_amount": cat_amount,
            "status_dist": status_dist,
            "monthly": monthly,
            "yearly": yearly,
            "avg_days_in_use": avg_days,
        },
    })


@reports_bp.route("/report/depreciation", methods=["GET"])
def report_depreciation():
    """折旧 & 每日成本排名数据（供图表）

    图表只画 Top N，所以后端也只返回 Top N——原来把全部记录都吐回来，
    5000 条时是 781 KB 的无用负载。被截断的部分汇总成 others 桶，
    金额不会凭空消失（前端可以在图表底部提示「其余 N 件」）。
    """
    limit = request.args.get("limit", type=int) or 15
    limit = max(1, min(limit, 200))

    with closing(get_db()) as conn:
        rows = conn.execute("SELECT * FROM products ORDER BY purchase_date").fetchall()
    data = [compute_cost(r) for r in rows]

    # 每日持有成本 Top（所有已结算的按最终成本，在售按当前日均）
    daily_sorted = sorted(data, key=lambda d: d["daily_cost"] or 0, reverse=True)
    daily_rank = [
        {
            "name": d["name"],
            "daily_cost": d["daily_cost"],
            "status": d["status"],
        }
        for d in daily_sorted[:limit]
    ]
    daily_others = others_bucket(daily_sorted[limit:], "daily_cost")

    # 折旧（仅已结算）
    dep = [d for d in data if d["depreciation"] is not None]
    dep_sorted = sorted(dep, key=lambda d: d["depreciation"], reverse=True)
    dep_rank = [
        {
            "name": d["name"],
            "depreciation": d["depreciation"],
            "rate": d["depreciation_rate"],
            "final_cost": d["final_holding_cost"],
        }
        for d in dep_sorted[:limit]
    ]
    dep_others = others_bucket(dep_sorted[limit:], "depreciation")

    # 购买时间线（累计投入）：散点太密没有意义，按购买日期聚合成
    # 「同一天多件合并」的阶梯点，点数从 N 条降到 唯一日期数
    timeline = build_timeline(data)

    return jsonify({
        "ok": True,
        "data": {
            "daily_rank": daily_rank,
            "daily_others": daily_others,
            "dep_rank": dep_rank,
            "dep_others": dep_others,
            "timeline": timeline,
            "limit": limit,
            "total": len(data),
        },
    })
