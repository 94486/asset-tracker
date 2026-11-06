# -*- coding: utf-8 -*-
"""入参解析与状态常量

所有写接口共用同一套解析逻辑，保证「前端校验」与「服务端校验」口径一致。
"""
import json
from datetime import date, datetime

# in_use 使用中 / for_sale 待售（仍持有）/ sold 已售出 / damaged 已损坏
VALID_STATUS = ("in_use", "for_sale", "sold", "damaged")
# 待售清单状态：watching 观望 / ready 待下手 / converted 已转化 / dropped 已放弃
WISH_STATUS = ("watching", "ready", "converted", "dropped")
WISH_PRIORITY = ("high", "normal", "low")
# 仍在持有、继续产生持有成本的状态（待售只是挂了牌子，东西还在手里）
HOLDING_STATUS = ("in_use", "for_sale")


def parse_date(value):
    """校验日期，返回 ISO 字符串；非法返回 None

    兼容常见写法：2026-01-02 / 2026/1/2 / 2026.1.2 / 2026年1月2日，
    以及带时间的 2026-01-02T10:00:00。Excel 导出的 CSV 经常是斜杠格式，
    这里统一收口，避免导入时整行被当成非法数据丢掉。
    """
    if not value:
        return None
    s = str(value).strip()
    if not s:
        return None
    head = s.replace("T", " ").split(" ")[0]
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%Y年%m月%d日"):
        try:
            return datetime.strptime(head, fmt).date().isoformat()
        except (ValueError, TypeError):
            continue
    return None


def parse_purchase_date(value):
    """购买日期：必须是合法日期，且不能晚于今天（未来设备会让持有天数为负）"""
    d = parse_date(value)
    if d is None:
        return None, "请填写正确的购买时间"
    if d > date.today().isoformat():
        return None, "购买时间不能晚于今天"
    return d, None


def parse_money(value, allow_blank=False):
    """解析金额：返回 (数值, 错误信息)"""
    if value is None or value == "":
        return (None, None) if allow_blank else (None, "请填写价格")
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None, "价格格式不正确"
    if num != num or num in (float("inf"), float("-inf")):
        return None, "价格格式不正确"
    if num < 0:
        return None, "价格不能为负数"
    if num > 1e12:
        return None, "价格数值过大"
    return round(num, 2), None


def parse_custom_fields(value):
    """自定义字段统一成 dict"""
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            obj = json.loads(value)
            return obj if isinstance(obj, dict) else {}
        except Exception:
            return {}
    return {}
