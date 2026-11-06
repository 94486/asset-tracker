# -*- coding: utf-8 -*-
"""报表辅助：Top N 截断汇总、按日投入时间线（纯函数）"""


def others_bucket(items, field):
    """把被 Top N 截断的记录汇成一个桶，保证合计值仍然正确"""
    if not items:
        return None
    return {
        "count": len(items),
        "total": round(sum(d.get(field) or 0 for d in items), 2),
    }


def build_timeline(data):
    """按日期聚合的累计投入序列（同一天合并，点数 = 唯一日期数）"""
    daily = {}
    for d in data:
        pd = d.get("purchase_date") or ""
        if len(pd) < 10:
            continue
        bucket = daily.setdefault(pd, {"date": pd, "value": 0.0, "count": 0})
        bucket["value"] += d["price"] or 0
        bucket["count"] += 1

    timeline = []
    cum = 0.0
    for pd in sorted(daily):
        bucket = daily[pd]
        cum += bucket["value"]
        timeline.append({
            "date": pd,
            "value": round(bucket["value"], 2),
            "cum_price": round(cum, 2),
            "count": bucket["count"],
        })
    return timeline
