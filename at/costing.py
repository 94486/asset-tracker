# -*- coding: utf-8 -*-
"""成本口径：持有天数、日均成本、折旧与盈亏

纯函数，不碰数据库，方便单测与复用。
"""
import json
from datetime import date, datetime

from .validators import HOLDING_STATUS


def days_between(d1, d2):
    """d1,d2 为 'YYYY-MM-DD' 字符串，返回天数差（最小 0）"""
    try:
        a = datetime.strptime(d1, "%Y-%m-%d").date()
        b = datetime.strptime(d2, "%Y-%m-%d").date()
    except Exception:
        return 0
    return max((b - a).days, 0)


def _num(value, default=0.0):
    """把任意值收敛成有限 float。

    数据库里正常只有 REAL，但历史库/外部工具可能写入 TEXT，
    这里兜一层，避免 `float - str` 直接抛 TypeError 把整个列表打成 500。
    """
    try:
        num = float(value)
    except (TypeError, ValueError):
        return default
    if num != num or num in (float("inf"), float("-inf")):
        return default
    return num


def _num_or_none(value):
    """可空金额：空值/无法解析都返回 None，而不是被当成 0 参与计算"""
    if value is None or value == "":
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if num != num or num in (float("inf"), float("-inf")):
        return None
    return num


def compute_cost(row):
    """根据记录计算成本，返回补充后的 dict"""
    d = dict(row)
    price = _num(d.get("price"))
    d["price"] = price          # 回写：后续报表直接 sum(d["price"])，脏值也不会炸
    status = d.get("status") or "in_use"
    purchase_date = d.get("purchase_date") or date.today().isoformat()
    today = date.today().isoformat()

    # 解析自定义字段
    try:
        d["custom_fields"] = json.loads(d.get("custom_fields") or "{}")
    except Exception:
        d["custom_fields"] = {}

    # 待售附加信息：挂了多久、挂单价相对购入价的浮盈
    list_date = d.get("list_date")
    d["days_listed"] = days_between(list_date, today) if list_date else None
    list_price = _num_or_none(d.get("list_price"))
    d["list_price"] = list_price
    if list_price is not None and price:
        d["list_pnl"] = round(list_price - price, 2)
        d["list_pnl_rate"] = round((list_price - price) / price * 100, 1)
    else:
        d["list_pnl"] = None
        d["list_pnl_rate"] = None

    if status in HOLDING_STATUS:
        # 待售仍是持有状态：钱还压在里面，成本照算，只是多了个处置意图
        days = days_between(purchase_date, today)
        d["days_held"] = days
        d["daily_cost"] = round(price / days, 2) if days else round(price, 2)
        d["final_holding_cost"] = None
        d["depreciation"] = None
        d["depreciation_rate"] = None
        d["profit_loss"] = None          # 未结算，无最终盈亏
    else:
        # sold / damaged
        sale_date = d.get("sale_date") or today
        # 同一天买入卖出记 1 天，避免除零；其余按真实天数
        days = max(days_between(purchase_date, sale_date), 1)
        sale_price = _num_or_none(d.get("sale_price"))
        d["sale_price"] = sale_price
        d["days_held"] = days

        if status == "sold" and sale_price is None:
            # 售价缺失（历史数据 / 导入漏填）：不能按"全额损失"算，
            # 那是 damaged 的口径。这里标记为"待补结算"，盈亏留空，
            # 报表不会把它算进已结算金额，也就不会凭空多出一笔亏损。
            d["daily_cost"] = None
            d["final_holding_cost"] = None
            d["depreciation"] = None
            d["depreciation_rate"] = None
            d["profit_loss"] = None
            return d

        if status == "sold":
            net = price - sale_price
            d["profit_loss"] = round(sale_price - price, 2)   # 正=盈利 负=亏损
        else:
            # damaged: 视为全额损失
            net = price
            d["profit_loss"] = round(-price, 2)               # 全额亏损
        d["final_holding_cost"] = round(net / days, 2)
        d["daily_cost"] = round(net / days, 2)
        # 折旧是「资产价值消耗」，卖出价高于买入价时为 0 而不是负数，
        # 溢价部分属于收益，只体现在 profit_loss 上
        d["depreciation"] = round(max(net, 0.0), 2)
        d["depreciation_rate"] = round(max(net, 0.0) / price * 100, 1) if price else 0
    return d
