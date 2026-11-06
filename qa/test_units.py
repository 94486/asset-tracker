# -*- coding: utf-8 -*-
"""核心逻辑单测（stdlib unittest，无需 pytest）

运行：python qa/test_units.py
覆盖：日期/金额解析、成本口径、报表辅助函数
"""
import os
import sys
import unittest
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from at.costing import _num, compute_cost, days_between          # noqa: E402
from at.reporting import build_timeline, others_bucket           # noqa: E402
from at.validators import (                                      # noqa: E402
    parse_custom_fields,
    parse_date,
    parse_money,
    parse_purchase_date,
)


def D(days):
    return (date.today() - timedelta(days=days)).isoformat()


class TestParse(unittest.TestCase):
    def test_date_ok(self):
        self.assertEqual(parse_date("2026-01-02"), "2026-01-02")
        self.assertEqual(parse_date("2026-01-02T10:00:00"), "2026-01-02")
        # Excel / 手工输入常见写法
        self.assertEqual(parse_date("2026/1/2"), "2026-01-02")
        self.assertEqual(parse_date("2026.1.2"), "2026-01-02")
        self.assertEqual(parse_date("2026年1月2日"), "2026-01-02")
        self.assertEqual(parse_date("2026/1/2 10:30"), "2026-01-02")

    def test_date_bad(self):
        for v in ("", None, "2024-02-31", "abc", "2026-13-01", "2026年2月30日"):
            self.assertIsNone(parse_date(v), v)

    def test_purchase_date_future(self):
        self.assertEqual(parse_purchase_date(D(-1))[0], None)
        self.assertEqual(parse_purchase_date(D(1))[0], D(1))

    def test_money(self):
        self.assertEqual(parse_money("12.345"), (12.35, None))
        self.assertEqual(parse_money(0)[0], 0.0)
        self.assertEqual(parse_money("", allow_blank=True), (None, None))
        self.assertIsNotNone(parse_money("")[1])
        self.assertIsNotNone(parse_money(-1)[1])
        self.assertIsNotNone(parse_money("abc")[1])
        self.assertIsNotNone(parse_money(1e13)[1])
        self.assertIsNotNone(parse_money(float("nan"))[1])
        self.assertIsNotNone(parse_money(float("inf"))[1])

    def test_custom_fields(self):
        self.assertEqual(parse_custom_fields({"a": 1}), {"a": 1})
        self.assertEqual(parse_custom_fields('{"a":1}'), {"a": 1})
        self.assertEqual(parse_custom_fields("[1,2]"), {})
        self.assertEqual(parse_custom_fields("bad"), {})


class TestCosting(unittest.TestCase):
    def row(self, **kw):
        base = {"price": 1000, "purchase_date": D(10), "status": "in_use",
                "custom_fields": "{}", "sale_date": None, "sale_price": None,
                "list_date": None, "list_price": None}
        base.update(kw)
        return base

    def test_days_between(self):
        self.assertEqual(days_between(D(10), D(0)), 10)
        self.assertEqual(days_between(D(0), D(10)), 0)      # 负数收敛到 0
        self.assertEqual(days_between("bad", D(0)), 0)

    def test_holding(self):
        c = compute_cost(self.row(price=9000, purchase_date=D(100)))
        self.assertEqual(c["days_held"], 100)
        self.assertAlmostEqual(c["daily_cost"], 90.0)
        self.assertIsNone(c["profit_loss"])
        self.assertIsNone(c["depreciation"])

    def test_holding_today(self):
        c = compute_cost(self.row(price=100, purchase_date=D(0)))
        self.assertEqual(c["days_held"], 0)
        self.assertEqual(c["daily_cost"], 100)

    def test_sold(self):
        c = compute_cost(self.row(price=3000, purchase_date=D(90), status="sold",
                                  sale_date=D(0), sale_price=2000))
        self.assertEqual(c["days_held"], 90)
        self.assertAlmostEqual(c["final_holding_cost"], 11.11)
        self.assertAlmostEqual(c["profit_loss"], -1000)
        self.assertAlmostEqual(c["depreciation"], 1000)

    def test_sold_same_day(self):
        c = compute_cost(self.row(price=100, purchase_date=D(0), status="sold",
                                  sale_date=D(0), sale_price=0))
        self.assertEqual(c["days_held"], 1)
        self.assertEqual(c["final_holding_cost"], 100)

    def test_sold_premium(self):
        c = compute_cost(self.row(price=1000, purchase_date=D(10), status="sold",
                                  sale_date=D(0), sale_price=1200))
        self.assertEqual(c["profit_loss"], 200)
        self.assertEqual(c["depreciation"], 0)
        self.assertEqual(c["depreciation_rate"], 0)

    def test_damaged(self):
        c = compute_cost(self.row(price=500, purchase_date=D(5), status="damaged",
                                  sale_date=D(0)))
        self.assertEqual(c["profit_loss"], -500)
        self.assertEqual(c["depreciation"], 500)
        self.assertEqual(c["depreciation_rate"], 100)

    def test_forsale(self):
        c = compute_cost(self.row(price=4000, purchase_date=D(60), status="for_sale",
                                  list_date=D(10), list_price=3500))
        self.assertEqual(c["days_listed"], 10)
        self.assertEqual(c["list_pnl"], -500)
        self.assertEqual(c["status"], "for_sale")

    def test_sold_without_price(self):
        """售价缺失不能按全额损失算（那是 damaged 的口径）"""
        c = compute_cost(self.row(price=1000, purchase_date=D(10), status="sold",
                                  sale_date=D(0), sale_price=None))
        self.assertIsNone(c["profit_loss"])
        self.assertIsNone(c["depreciation"])
        self.assertIsNone(c["daily_cost"])
        self.assertEqual(c["days_held"], 10)

    def test_dirty_text_fields(self):
        """历史库/外部写入 TEXT 时不应抛异常（P1 回归）"""
        c = compute_cost(self.row(price="1000", purchase_date=D(10), status="sold",
                                  sale_date="not-a-date", sale_price="abc"))
        self.assertIsNone(c["profit_loss"])         # 无法解析的售价按「未填」处理
        c2 = compute_cost(self.row(price="1000", purchase_date=D(10), status="for_sale",
                                   list_date=D(3), list_price="oops"))
        self.assertIsNone(c2["list_pnl"])

    def test_num(self):
        self.assertEqual(_num("12.5"), 12.5)
        self.assertEqual(_num(None), 0.0)
        self.assertEqual(_num("x"), 0.0)
        self.assertEqual(_num(float("nan")), 0.0)


class TestReporting(unittest.TestCase):
    def test_others_bucket(self):
        self.assertIsNone(others_bucket([], "daily_cost"))
        b = others_bucket([{"daily_cost": 1.1}, {"daily_cost": 2.2}], "daily_cost")
        self.assertEqual(b["count"], 2)
        self.assertAlmostEqual(b["total"], 3.3)

    def test_timeline(self):
        data = [
            {"purchase_date": "2026-01-01", "price": 100},
            {"purchase_date": "2026-01-01", "price": 50},
            {"purchase_date": "2026-02-01", "price": 200},
            {"purchase_date": "bad", "price": 999},
        ]
        tl = build_timeline(data)
        self.assertEqual(len(tl), 2)
        self.assertEqual(tl[0]["value"], 150)
        self.assertEqual(tl[1]["cum_price"], 350)


class TestPortGuard(unittest.TestCase):
    """端口清理只针对自己的进程：既要能收拾旧实例，又不能误杀别人的服务"""

    def test_allowed_names(self):
        from at.ports import APP_EXE_NAMES, _allowed_names

        names = _allowed_names()
        self.assertIn("python.exe", names)
        self.assertIn("pythonw.exe", names)
        for n in APP_EXE_NAMES:
            self.assertIn(n.lower(), names, f"{n} 不允许被清理，旧实例会一直占着端口")

    def test_does_not_allow_others(self):
        from at.ports import _allowed_names

        names = _allowed_names()
        for bad in ("svchost.exe", "nginx.exe", "chrome.exe", "node.exe"):
            self.assertNotIn(bad, names)


if __name__ == "__main__":
    unittest.main(verbosity=2)
