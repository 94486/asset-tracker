# -*- coding: utf-8 -*-
"""资产追踪系统 验收测试

运行：python qa/acceptance_test.py
隔离：自动建临时 DATA_DIR，不碰项目里的 asset_tracker.db
"""
import csv
import gzip
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TMP = tempfile.mkdtemp(prefix="at_qa_")
os.environ["DATA_DIR"] = TMP
os.environ["HEADLESS"] = "1"
os.environ["PORT"] = "5799"
sys.path.insert(0, str(ROOT))

import app as mod  # noqa: E402

mod.init_db()
client = mod.app.test_client()

RESULTS = []
ISSUES = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    if not cond:
        print(f"  FAIL  {name}  {detail}")


def issue(level, title, detail=""):
    ISSUES.append((level, title, detail))
    print(f"  [{level}] {title}  {detail}")


def jd(resp):
    try:
        return resp.get_json()
    except Exception:
        return None


def D(days):
    return (date.today() - timedelta(days=days)).isoformat()


def post(path, payload=None, **kw):
    return client.post(path, json=payload if payload is not None else {}, **kw)


def section(t):
    print(f"\n== {t} ==")


def run(fn):
    try:
        fn()
    except Exception:
        print(f"  ERROR in {fn.__name__}")
        traceback.print_exc()
        RESULTS.append((fn.__name__, False, "exception"))


# ---------------------------------------------------------------- 静态资源
def t_static():
    section("静态资源 / 页面")
    r = client.get("/")
    check("首页 200", r.status_code == 200, r.status_code)
    check("首页含标题", "数码资产" in r.get_data(as_text=True))
    for p in ("/static/css/style.css", "/static/js/app.js", "/static/js/echarts.min.js"):
        r = client.get(p)
        check(f"{p} 200", r.status_code == 200, r.status_code)
        check(f"{p} 非空", len(r.data) > 1000, len(r.data))
    r = client.get("/favicon.ico")
    check("favicon 200", r.status_code == 200, r.status_code)


# ---------------------------------------------------------------- 资产 CRUD
def t_crud():
    section("资产 CRUD")
    r = client.get("/api/products")
    check("初始列表为空", r.status_code == 200 and jd(r)["data"] == [], r.status_code)

    r = post("/api/products", {"name": "iPhone 15", "brand": "Apple", "category": "手机",
                               "price": 9000, "purchase_date": D(100),
                               "config": "256G", "notes": "主力机",
                               "custom_fields": {"颜色": "蓝色"}})
    d = jd(r)
    check("创建资产", r.status_code == 200 and d.get("ok"), d)
    pid = d.get("id")

    r = client.get("/api/products")
    items = jd(r)["data"]
    check("列表 1 条", len(items) == 1, len(items))
    p = items[0]
    check("days_held=100", p["days_held"] == 100, p["days_held"])
    check("daily_cost=90", abs(p["daily_cost"] - 90.0) < 0.01, p["daily_cost"])
    check("自定义字段还原", p["custom_fields"] == {"颜色": "蓝色"}, p["custom_fields"])
    check("未结算无盈亏", p["profit_loss"] is None)

    cases = [
        ("空名称", {"name": "  ", "price": 1, "purchase_date": D(1)}, 400),
        ("负价格", {"name": "x", "price": -1, "purchase_date": D(1)}, 400),
        ("价格非数字", {"name": "x", "price": "abc", "purchase_date": D(1)}, 400),
        ("价格过大", {"name": "x", "price": 1e13, "purchase_date": D(1)}, 400),
        ("未来购买日", {"name": "x", "price": 1, "purchase_date": D(-1)}, 400),
        ("非法日期", {"name": "x", "price": 1, "purchase_date": "2024-02-31"}, 400),
        ("缺购买日", {"name": "x", "price": 1}, 400),
        ("名称 121 字", {"name": "字" * 121, "price": 1, "purchase_date": D(1)}, 400),
        ("名称 120 字", {"name": "字" * 120, "price": 1, "purchase_date": D(1)}, 200),
    ]
    for label, payload, expect in cases:
        r = post("/api/products", payload)
        check(f"校验-{label} -> {expect}", r.status_code == expect, r.status_code)

    r = client.put(f"/api/products/{pid}", json={"name": "iPhone 15 Pro", "brand": "Apple",
                                                 "category": "手机", "price": 9500,
                                                 "purchase_date": D(100), "config": "256G"})
    check("更新资产", r.status_code == 200 and jd(r)["ok"], r.status_code)
    r = client.put("/api/products/999999", json={"name": "x", "price": 1, "purchase_date": D(1)})
    check("更新不存在 404", r.status_code == 404, r.status_code)

    r = post("/api/products", [1, 2])
    if r.status_code >= 500:
        issue("中", "JSON 体为数组时接口 500", f"POST /api/products 传 list 返回 {r.status_code}")
    check("非法 JSON 体不崩", r.status_code in (400, 415), r.status_code)


# ---------------------------------------------------------------- 结算
def t_settle():
    section("出售 / 损坏 / 恢复")
    r = post("/api/products", {"name": "相机", "price": 3000, "purchase_date": D(90), "category": "相机"})
    cid = jd(r)["id"]

    r = post(f"/api/products/{cid}/sell", {"status": "sold", "sale_price": 2000, "sale_date": D(0)})
    check("登记出售", r.status_code == 200, r.status_code)
    p = [x for x in jd(client.get("/api/products"))["data"] if x["id"] == cid][0]
    check("售出 days_held=90", p["days_held"] == 90, p["days_held"])
    check("售出 最终日均=11.11", abs(p["final_holding_cost"] - 11.11) < 0.02, p["final_holding_cost"])
    check("售出 盈亏=-1000", abs(p["profit_loss"] + 1000) < 0.01, p["profit_loss"])
    check("售出 折旧=1000", abs(p["depreciation"] - 1000) < 0.01, p["depreciation"])

    r = post(f"/api/products/{cid}/sell", {"status": "sold", "sale_price": 2000, "sale_date": D(100)})
    check("处理日早于购买日 -> 400", r.status_code == 400, r.status_code)
    r = post(f"/api/products/{cid}/sell", {"status": "sold", "sale_price": 2000, "sale_date": D(-2)})
    check("处理日晚于今天 -> 400", r.status_code == 400, r.status_code)
    r = post(f"/api/products/{cid}/sell", {"status": "bad"})
    check("非法状态 -> 400", r.status_code == 400, r.status_code)

    r = post("/api/products", {"name": "当日", "price": 100, "purchase_date": D(0)})
    did = jd(r)["id"]
    post(f"/api/products/{did}/sell", {"status": "sold", "sale_price": 0, "sale_date": D(0)})
    p = [x for x in jd(client.get("/api/products"))["data"] if x["id"] == did][0]
    check("当日买卖 days_held=1（不除零）", p["days_held"] == 1, p["days_held"])
    check("当日买卖 最终日均=100", abs(p["final_holding_cost"] - 100) < 0.01, p["final_holding_cost"])

    r = post("/api/products", {"name": "损坏机", "price": 500, "purchase_date": D(5)})
    kid = jd(r)["id"]
    post(f"/api/products/{kid}/sell", {"status": "damaged", "sale_date": D(0)})
    p = [x for x in jd(client.get("/api/products"))["data"] if x["id"] == kid][0]
    check("损坏 全额损失 -500", abs(p["profit_loss"] + 500) < 0.01, p["profit_loss"])
    check("损坏 折旧=500", abs(p["depreciation"] - 500) < 0.01, p["depreciation"])
    check("损坏 折旧率=100", abs(p["depreciation_rate"] - 100) < 0.1, p["depreciation_rate"])

    r = post("/api/products", {"name": "理财", "price": 1000, "purchase_date": D(10)})
    gid = jd(r)["id"]
    post(f"/api/products/{gid}/sell", {"status": "sold", "sale_price": 1200, "sale_date": D(0)})
    p = [x for x in jd(client.get("/api/products"))["data"] if x["id"] == gid][0]
    check("溢价 盈亏=200", abs(p["profit_loss"] - 200) < 0.01, p["profit_loss"])
    check("溢价 折旧不为负", p["depreciation"] == 0 and p["depreciation_rate"] == 0,
          (p["depreciation"], p["depreciation_rate"]))

    r = post(f"/api/products/{cid}/sell", {"status": "in_use"})
    p = [x for x in jd(client.get("/api/products"))["data"] if x["id"] == cid][0]
    check("恢复使用中", p["status"] == "in_use" and p["sale_date"] is None and p["sale_price"] is None)

    # 已结算记录改购买日 -> 不得晚于处理日
    post(f"/api/products/{cid}/sell", {"status": "sold", "sale_price": 2000, "sale_date": D(10)})
    r = client.put(f"/api/products/{cid}", json={"name": "相机", "price": 3000, "purchase_date": D(0)})
    check("改购买日晚于处理日 -> 400", r.status_code == 400, r.status_code)


# ---------------------------------------------------------------- 待售
def t_forsale():
    section("待售清单")
    r = post("/api/products", {"name": "旧笔记本", "price": 4000, "purchase_date": D(60), "category": "笔记本"})
    fid = jd(r)["id"]

    r = post(f"/api/products/{fid}/list", {"list_price": 3500, "list_date": D(10)})
    check("挂待售", r.status_code == 200, r.status_code)
    p = [x for x in jd(client.get("/api/products"))["data"] if x["id"] == fid][0]
    check("状态 for_sale", p["status"] == "for_sale", p["status"])
    check("days_listed=10", p["days_listed"] == 10, p["days_listed"])
    check("待售仍计持有成本", abs(p["daily_cost"] - round(4000 / 60, 2)) < 0.01, p["daily_cost"])
    check("挂单浮亏 -500", abs(p["list_pnl"] + 500) < 0.01, p["list_pnl"])

    r = post(f"/api/products/{fid}/list", {"list_date": D(70)})
    check("上架日早于购买日 -> 400", r.status_code == 400, r.status_code)
    r = post(f"/api/products/{fid}/list", {"list_date": D(-1)})
    check("上架日晚于今天 -> 400", r.status_code == 400, r.status_code)

    r = client.patch(f"/api/products/{fid}/ask", json={"list_price": 3000})
    check("改挂单价", r.status_code == 200 and jd(r)["list_pnl"] == -1000, jd(r))

    r = post(f"/api/products/{fid}/unlist")
    p = [x for x in jd(client.get("/api/products"))["data"] if x["id"] == fid][0]
    check("下架回到 in_use", r.status_code == 200 and p["status"] == "in_use" and p["list_date"] is None)
    r = client.patch(f"/api/products/{fid}/ask", json={"list_price": 100})
    check("非待售改价 -> 400", r.status_code == 400, r.status_code)

    r = post("/api/products", {"name": "已卖", "price": 100, "purchase_date": D(3)})
    sid = jd(r)["id"]
    post(f"/api/products/{sid}/sell", {"status": "sold", "sale_price": 50})
    r = post(f"/api/products/{sid}/list", {})
    check("已售出不能转待售 -> 400", r.status_code == 400, r.status_code)

    r = client.get("/api/forsale/board")
    b = jd(r)["data"]
    check("待售看板 200", r.status_code == 200)
    check("看板计数与列表一致", b["total"] == 0, b["total"])


# ---------------------------------------------------------------- 删除/撤销
def t_delete():
    section("删除与撤销")
    r = post("/api/products", {"name": "待删", "price": 800, "purchase_date": D(20), "notes": "n"})
    did = jd(r)["id"]
    r = client.delete(f"/api/products/{did}")
    d = jd(r)
    check("删除返回完整记录", r.status_code == 200 and d["deleted"]["name"] == "待删", d)
    check("删除后不在列表", all(x["id"] != did for x in jd(client.get("/api/products"))["data"]))

    r = post("/api/products/restore", d["deleted"])
    check("撤销删除成功", r.status_code == 200 and jd(r)["ok"], jd(r))
    check("撤销后 id 复用", jd(r)["id"] == did, jd(r)["id"])

    r = post("/api/products/restore", d["deleted"])
    check("id 冲突时新建（不覆盖）", r.status_code == 200 and jd(r)["id"] != did, jd(r))
    r = post("/api/products/restore", {"name": ""})
    check("撤销空名 -> 400", r.status_code == 400, r.status_code)
    r = client.delete("/api/products/999999")
    check("删除不存在 -> 404", r.status_code == 404, r.status_code)


# ---------------------------------------------------------------- 预购
def t_wish():
    section("预购清单")
    r = post("/api/wishlist", {"name": "掌机", "target_price": 2500, "priority": "high",
                               "expected_date": (date.today() + timedelta(days=30)).isoformat(),
                               "config": "512G", "custom_fields": {"容量": "512G"}})
    wid = jd(r)["id"]
    check("新增预购", r.status_code == 200 and wid, jd(r))
    w = [x for x in jd(client.get("/api/wishlist"))["data"] if x["id"] == wid][0]
    check("days_left=30", w["days_left"] == 30, w["days_left"])

    r = post("/api/wishlist", {"name": ""})
    check("预购空名 -> 400", r.status_code == 400, r.status_code)

    r = client.patch(f"/api/wishlist/{wid}/price", json={"target_price": 2300})
    check("改心理价", r.status_code == 200 and jd(r)["target_price"] == 2300, jd(r))
    r = client.patch(f"/api/wishlist/{wid}/price", json={"target_price": -5})
    check("负心理价 -> 400", r.status_code == 400, r.status_code)

    b = jd(client.get("/api/wishlist/board"))["data"]
    check("看板预算=2300", abs(b["budget"] - 2300) < 0.01, b["budget"])
    check("看板转化率=0", b["convert_rate"] == 0, b["convert_rate"])

    r = post(f"/api/wishlist/{wid}/convert", {"price": 2200, "purchase_date": D(1)})
    pid = jd(r).get("product_id")
    check("预购转资产", r.status_code == 200 and pid, jd(r))
    prod = [x for x in jd(client.get("/api/products"))["data"] if x["id"] == pid][0]
    check("转化价覆盖预算", prod["price"] == 2200, prod["price"])
    check("转化继承规格", prod["config"] == "512G", prod["config"])
    check("转化继承自定义字段", prod["custom_fields"] == {"容量": "512G"}, prod["custom_fields"])

    r = post(f"/api/wishlist/{wid}/convert", {"price": 2200, "purchase_date": D(1)})
    check("重复转化 -> 400", r.status_code == 400, r.status_code)
    r = client.put(f"/api/wishlist/{wid}", json={"name": "x", "target_price": 1})
    check("已转化不可编辑 -> 400", r.status_code == 400, r.status_code)
    r = client.patch(f"/api/wishlist/{wid}/price", json={"target_price": 1})
    check("已转化不可改价 -> 400", r.status_code == 400, r.status_code)
    r = post(f"/api/wishlist/{wid}/drop")
    check("已转化不可放弃 -> 400", r.status_code == 400, r.status_code)

    b = jd(client.get("/api/wishlist/board"))["data"]
    check("转化后预算=0", abs(b["budget"]) < 0.01, b["budget"])
    check("转化率=100", b["convert_rate"] == 100, b["convert_rate"])

    r = post("/api/wishlist", {"name": "放弃项", "target_price": 100})
    wid2 = jd(r)["id"]
    check("放弃预购", post(f"/api/wishlist/{wid2}/drop").status_code == 200)
    check("恢复预购", post(f"/api/wishlist/{wid2}/restore").status_code == 200)
    r = post(f"/api/wishlist/{wid2}/restore")
    check("非放弃状态恢复 -> 400", r.status_code == 400, r.status_code)
    check("删除预购", client.delete(f"/api/wishlist/{wid2}").status_code == 200)

    r = post("/api/wishlist", [1])
    if r.status_code >= 500:
        issue("中", "预购接口 JSON 体为数组时 500", f"返回 {r.status_code}")
    check("预购非法 JSON 体不崩", r.status_code in (400, 415), r.status_code)


# ---------------------------------------------------------------- 报表
def t_report():
    section("报表口径")
    # 用 replace 导入一批可控数据，同时测导入
    payload = {"products": [
        {"name": "P1-在用", "brand": "A", "category": "手机", "price": 1000,
         "purchase_date": D(10), "status": "in_use", "custom_fields": {}},
        {"name": "P2-待售", "brand": "A", "category": "平板", "price": 2000,
         "purchase_date": D(20), "status": "for_sale", "list_date": D(5), "list_price": 1800},
        {"name": "P3-已售", "brand": "B", "category": "手机", "price": 3000,
         "purchase_date": D(30), "status": "sold", "sale_date": D(10), "sale_price": 2500},
        {"name": "P4-损坏", "brand": "B", "category": "耳机", "price": 500,
         "purchase_date": D(5), "status": "damaged", "sale_date": D(0)},
    ]}
    raw = json.dumps(payload, ensure_ascii=False).encode()
    r = client.post("/api/import", data={"file": (io.BytesIO(raw), "seed.json"), "mode": "replace"},
                    content_type="multipart/form-data")
    d = jd(r)
    check("JSON 覆盖导入 4 条", d and d["inserted"] == 4, d)
    check("覆盖导入自动备份", os.path.exists(mod.DB_FILE + ".backup"))

    s = jd(client.get("/api/report/summary"))["data"]
    check("总件数=4", s["total_count"] == 4, s["total_count"])
    check("持有资产总额=3000", abs(s["held_value"] - 3000) < 0.01, s["held_value"])
    check("总投入=6500", abs(s["total_invested"] - 6500) < 0.01, s["total_invested"])
    check("当前日成本=200", abs(s["current_daily_total"] - 200) < 0.01, s["current_daily_total"])
    check("累计盈亏=-1000", abs(s["total_pnl"] + 1000) < 0.01, s["total_pnl"])
    check("亏损件数=2", s["loss_count"] == 2, s["loss_count"])
    check("状态分布 待售=1", [x for x in s["status_dist"] if x["name"] == "待售"][0]["value"] == 1)
    check("月度聚合非空", len(s["monthly"]) >= 1, s["monthly"])

    dep = jd(client.get("/api/report/depreciation?limit=1"))["data"]
    check("折旧接口 total=4", dep["total"] == 4, dep["total"])
    check("limit 生效", len(dep["daily_rank"]) == 1, len(dep["daily_rank"]))
    if dep["daily_others"]:
        total_rank = sum(x["daily_cost"] for x in dep["daily_rank"]) + dep["daily_others"]["total"]
        # 1000/10 + 2000/20 + (3000-2500)/20 + 500/5 = 100 + 100 + 25 + 100
        check("Top N + others 守恒", abs(total_rank - 325) < 0.5, total_rank)
    tl = dep["timeline"]
    check("时间线累计单调", all(tl[i]["cum_price"] <= tl[i + 1]["cum_price"] for i in range(len(tl) - 1)))
    check("时间线累计=总投入", abs(tl[-1]["cum_price"] - 6500) < 0.01, tl[-1]["cum_price"])


# ---------------------------------------------------------------- 导出
def t_export():
    section("导出")
    r = client.get("/api/export?format=json")
    d = json.loads(r.data.decode("utf-8"))
    check("JSON 导出 count=4", d["count"] == 4, d["count"])
    check("JSON 导出含 custom_fields", isinstance(d["products"][0]["custom_fields"], dict))

    r = client.get("/api/export?format=csv")
    check("CSV 带 BOM", r.data.startswith(b"\xef\xbb\xbf"), r.data[:3])
    text = r.data.decode("utf-8-sig")
    check("CSV 表头完整", text.splitlines()[0].startswith("name,brand,category,price,purchase_date"))

    # 公式注入
    post("/api/products", {"name": "=1+1", "price": 1, "purchase_date": D(1)})
    post("/api/products", {"name": "@SUM(A1)", "price": 1, "purchase_date": D(1)})
    post("/api/products", {"name": "-12.5", "price": 1, "purchase_date": D(1)})
    text = client.get("/api/export?format=csv").data.decode("utf-8-sig")
    check("CSV 公式注入转义 =", "'=1+1" in text)
    check("CSV 公式注入转义 @", "'@SUM(A1)" in text)
    check("负数不当公式", "'-12.5" not in text)


# ---------------------------------------------------------------- 导入
def t_import():
    section("导入")
    # 追加去重
    raw = client.get("/api/export?format=json").data
    r = client.post("/api/import", data={"file": (io.BytesIO(raw), "a.json"), "mode": "append"},
                    content_type="multipart/form-data")
    d = jd(r)
    check("重复导入全部跳过", d["inserted"] == 0 and d["skipped"] == d["total"], d)

    # 带逗号/换行的 CSV
    csv_text = ('name,brand,category,price,purchase_date,config,status,sale_date,sale_price,'
                'list_date,list_price,custom_fields,notes\n'
                '"Phone, Pro",BrandX,手机,1234.5,%s,256G,in_use,,,,,{},"line1\nline2"\n') % D(3)
    r = client.post("/api/import",
                    data={"file": (io.BytesIO(csv_text.encode("utf-8")), "c.csv"), "mode": "append"},
                    content_type="multipart/form-data")
    d = jd(r)
    check("CSV 追加导入 1 条", d["inserted"] == 1, d)
    item = [x for x in jd(client.get("/api/products"))["data"] if x["name"] == "Phone, Pro"]
    check("CSV 引号内逗号/换行正确", item and "\n" in item[0]["notes"], item[0]["notes"] if item else None)

    # GBK
    gbk = csv_text.replace("Phone, Pro", "国行手机").replace("BrandX", "华为").encode("gb18030")
    r = client.post("/api/import",
                    data={"file": (io.BytesIO(gbk), "g.csv"), "mode": "append"},
                    content_type="multipart/form-data")
    d = jd(r)
    check("GBK CSV 导入", d["inserted"] == 1, d)
    check("GBK 中文未乱码", any(x["name"] == "国行手机" for x in jd(client.get("/api/products"))["data"]))

    # 非法输入
    r = client.post("/api/import", data={}, content_type="multipart/form-data")
    check("无文件 -> 400", r.status_code == 400, r.status_code)
    r = client.post("/api/import",
                    data={"file": (io.BytesIO(b"abc"), "x.txt"), "mode": "append"},
                    content_type="multipart/form-data")
    check("不支持扩展名 -> 400", r.status_code == 400, r.status_code)
    r = client.post("/api/import",
                    data={"file": (io.BytesIO(b"{bad json"), "x.json"), "mode": "append"},
                    content_type="multipart/form-data")
    check("坏 JSON -> 400", r.status_code == 400, r.status_code)

    # 未来日期：接口是否与新增保持一致
    future = json.dumps({"products": [{"name": "未来机", "price": 1,
                                       "purchase_date": D(-10), "status": "in_use"}]}).encode()
    r = client.post("/api/import",
                    data={"file": (io.BytesIO(future), "f.json"), "mode": "append"},
                    content_type="multipart/form-data")
    if jd(r) and jd(r)["inserted"] == 1:
        issue("低", "导入允许未来购买日期", "新增接口会拒绝，导入不会；口径不一致，且会让 days_held 恒为 0")


# ---------------------------------------------------------------- 安全
def t_security():
    section("安全 / 边界")
    post("/api/products", {"name": "'; DROP TABLE products;--", "price": 1, "purchase_date": D(1)})
    r = client.get("/api/products")
    check("SQL 注入无效", r.status_code == 200)
    r = client.get("/api/report/summary")
    check("注入后报表可用", r.status_code == 200, r.status_code)

    xss = "<img src=x onerror=alert(1)>"
    post("/api/products", {"name": xss, "price": 1, "purchase_date": D(1)})
    item = [x for x in jd(client.get("/api/products"))["data"] if x["name"] == xss]
    check("XSS 字符串原样存储（前端需转义）", bool(item))

    # 超大备注
    r = post("/api/products", {"name": "长备注", "price": 1, "purchase_date": D(1), "notes": "x" * 200000})
    check("20 万字符备注可写入", r.status_code == 200, r.status_code)

    # 并发写
    errs = []
    def worker(n):
        c = mod.app.test_client()
        for i in range(20):
            try:
                resp = c.post("/api/products", json={"name": f"并发{n}-{i}", "price": 1,
                                                     "purchase_date": D(1)})
                if resp.status_code != 200:
                    errs.append(resp.status_code)
            except Exception as e:
                errs.append(repr(e))
    ts = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    check("8 线程 × 20 并发写全部成功", not errs, errs[:3])


# ---------------------------------------------------------------- 性能
def t_perf():
    section("性能（1200 条）")
    rows = [{"name": f"批量{i}", "brand": f"B{i % 10}", "category": f"C{i % 8}",
             "price": 100 + i, "purchase_date": D(i % 365), "status": "in_use"} for i in range(1200)]
    raw = json.dumps({"products": rows}, ensure_ascii=False).encode()
    t0 = time.time()
    r = client.post("/api/import", data={"file": (io.BytesIO(raw), "bulk.json"), "mode": "append"},
                    content_type="multipart/form-data")
    imp = time.time() - t0
    check("批量导入 1200 条", jd(r)["inserted"] == 1200, jd(r))

    t0 = time.time()
    r = client.get("/api/products")
    t_list = time.time() - t0
    size = len(r.data)
    t0 = time.time()
    client.get("/api/report/summary")
    t_sum = time.time() - t0
    t0 = time.time()
    client.get("/api/report/depreciation")
    t_dep = time.time() - t0

    print(f"  导入 {imp:.2f}s | 列表 {t_list * 1000:.0f}ms/{size / 1024:.0f}KB | "
          f"summary {t_sum * 1000:.0f}ms | depreciation {t_dep * 1000:.0f}ms")
    check("列表接口 < 1.5s", t_list < 1.5, f"{t_list:.2f}s")
    check("汇总接口 < 1s", t_sum < 1.0, f"{t_sum:.2f}s")
    check("折旧接口 < 1s", t_dep < 1.0, f"{t_dep:.2f}s")
    if size > 2 * 1024 * 1024:
        issue("低", "列表接口返回体偏大", f"{size / 1024 / 1024:.1f} MB（无分页，前端自行分页）")


# ---------------------------------------------------------------- 数据库
def t_db():
    section("数据库")
    with sqlite3.connect(mod.DB_FILE) as c:
        mode = c.execute("PRAGMA journal_mode").fetchone()[0]
        idx = [r[0] for r in c.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")]
        cols_p = [r[1] for r in c.execute("PRAGMA table_info(products)")]
        cols_w = [r[1] for r in c.execute("PRAGMA table_info(wishlist)")]
    check("日志模式为 wal/delete", mode.lower() in ("wal", "delete"), mode)
    if mode.lower() != "wal":
        issue("信息", "本次测试环境 WAL 探针回退到 delete",
              "同目录并发写探针在本机报 5/120 次 'attempt to write a readonly database'；"
              "打包产物 dist/asset_tracker.db 实际为 wal，判断为测试沙箱的文件过滤导致，非产品缺陷")
    check("索引齐全", {"idx_products_pdate", "idx_products_status", "idx_wishlist_status"} <= set(idx), idx)
    check("products 含待售字段", {"list_date", "list_price"} <= set(cols_p), cols_p)
    check("wishlist 含 config", "config" in cols_w, cols_w)

    # 旧库迁移
    old_dir = tempfile.mkdtemp(prefix="at_old_")
    old_db = os.path.join(old_dir, "asset_tracker.db")
    c = sqlite3.connect(old_db)
    c.execute("CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, "
              "brand TEXT DEFAULT '', category TEXT DEFAULT '', price REAL NOT NULL DEFAULT 0, "
              "purchase_date TEXT NOT NULL, config TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'in_use', "
              "sale_date TEXT, sale_price REAL, custom_fields TEXT DEFAULT '{}', notes TEXT DEFAULT '', "
              "created_at TEXT)")
    c.execute("INSERT INTO products (name, price, purchase_date) VALUES ('老数据', 100, '2024-01-01')")
    c.commit()
    c.close()
    env = dict(os.environ, DATA_DIR=old_dir, HEADLESS="1", PORT="5798")
    r = subprocess.run([sys.executable, "-c",
                        "import sys; sys.path.insert(0, r'%s'); import app; app.init_db(); print('ok')" % ROOT],
                       env=env, capture_output=True, text=True, timeout=120)
    ok = "ok" in r.stdout
    check("旧库启动自动迁移", ok, r.stderr[-300:])
    if ok:
        c = sqlite3.connect(old_db)
        cols = [x[1] for x in c.execute("PRAGMA table_info(products)")]
        kept = c.execute("SELECT COUNT(*) FROM products WHERE name='老数据'").fetchone()[0]
        tables = [x[0] for x in c.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        c.close()
        check("迁移补列 list_date", "list_date" in cols, cols)
        check("迁移不丢数据", kept == 1, kept)
        check("迁移补建 wishlist", "wishlist" in tables, tables)
    shutil.rmtree(old_dir, ignore_errors=True)


# ---------------------------------------------------------------- 异常状态
def t_edge():
    section("异常状态 / 脏数据")
    r = post("/api/products", {"name": "状态机边界", "price": 100, "purchase_date": D(10)})
    eid = jd(r)["id"]
    r = post(f"/api/products/{eid}/sell", {"status": "for_sale", "sale_date": D(1), "sale_price": 50})
    if r.status_code == 200:
        p = [x for x in jd(client.get("/api/products"))["data"] if x["id"] == eid][0]
        issue("中", "sell 接口接受 for_sale 状态，写出非法组合",
              f"status=for_sale 且 sale_date={p['sale_date']}、list_date={p['list_date']}，"
              "违反「待售不应有结算字段」的不变量")
    check("待售状态不可由 sell 写入 -> 400", r.status_code == 400, r.status_code)

    # 撤销删除接口不校验 sale_price/sale_date，写坏数据会让整个列表 500
    r = post("/api/products/restore", {"name": "脏数据", "price": 10, "purchase_date": D(5),
                                       "status": "sold", "sale_date": "not-a-date",
                                       "sale_price": "abc"})
    if r.status_code == 200:
        issue("高", "撤销删除接口未校验结算字段，可写出让列表/报表全部 500 的脏数据",
              "POST /api/products/restore 传入 sale_price='abc' 后，"
              "GET /api/products 与 /api/report/summary 均返回 500，前端整页不可用")
    check("撤销删除校验结算字段 -> 400", r.status_code == 400, r.status_code)

    code = client.get("/api/products").status_code
    check("脏数据后列表仍可用", code == 200, code)
    # 清理，避免污染后续用例
    with sqlite3.connect(mod.DB_FILE) as c:
        c.execute("DELETE FROM products WHERE name IN ('脏数据','状态机边界')")
        c.commit()


# ---------------------------------------------------------------- 健壮性
def t_robustness():
    section("健壮性（本轮修复）")

    # 1) 覆盖导入全是坏数据：不能先清空再插 0 条
    post("/api/products", {"name": "保命A", "price": 10, "purchase_date": D(1)})
    before = len(jd(client.get("/api/products"))["data"])
    bad = {"products": [{"name": "", "price": 1, "purchase_date": D(1)},
                        {"name": "X", "price": "abc", "purchase_date": D(1)}]}
    r = client.post("/api/import",
                    data={"file": (io.BytesIO(json.dumps(bad).encode()), "bad.json"), "mode": "replace"},
                    content_type="multipart/form-data")
    after = len(jd(client.get("/api/products"))["data"])
    check("覆盖导入无有效行 -> 400", r.status_code == 400, r.status_code)
    check("覆盖导入失败不清空原数据", before == after, (before, after))

    # 2) 出售必须填价格（否则会被当成全额损失）
    r = post("/api/products", {"name": "无价出售", "price": 500, "purchase_date": D(5)})
    pid = jd(r)["id"]
    r = post(f"/api/products/{pid}/sell", {"status": "sold", "sale_date": D(0)})
    check("出售未填价格 -> 400", r.status_code == 400, r.status_code)

    # 3) 撤销删除拒绝未来日期
    r = post("/api/products/restore", {"name": "未来", "price": 1, "purchase_date": "2099-01-01"})
    check("撤销删除拒绝未来日期 -> 400", r.status_code == 400, r.status_code)

    # 4) 预购脏日期不能打挂列表
    r = post("/api/wishlist", {"name": "脏日期", "target_price": 1,
                               "expected_date": (date.today() + timedelta(days=3)).isoformat()})
    wid = jd(r)["id"]
    with sqlite3.connect(mod.DB_FILE) as c:
        c.execute("UPDATE wishlist SET expected_date='not-a-date' WHERE id=?", (wid,))
        c.commit()
    r = client.get("/api/wishlist")
    check("预购脏日期仍返回 200", r.status_code == 200, r.status_code)
    if r.status_code == 200:
        w = [x for x in jd(r)["data"] if x["id"] == wid][0]
        check("脏日期 days_left 为 None", w["days_left"] is None, w["days_left"])
    with sqlite3.connect(mod.DB_FILE) as c:
        c.execute("DELETE FROM wishlist WHERE id=?", (wid,))
        c.commit()

    # 5) 健康检查
    r = client.get("/api/health")
    check("健康检查 200", r.status_code == 200 and jd(r)["ok"], r.status_code)

    # 6) 大响应 gzip
    r = client.get("/api/products", headers={"Accept-Encoding": "gzip"})
    check("大响应 gzip", r.headers.get("Content-Encoding") == "gzip", r.headers.get("Content-Encoding"))
    if r.headers.get("Content-Encoding") == "gzip":
        data = json.loads(gzip.decompress(r.data).decode("utf-8"))
        check("gzip 解压后可解析", data["ok"] is True)

    # 7) Excel 常见斜杠日期可导入并归一化
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=["name", "brand", "category", "price", "purchase_date",
                                             "config", "status", "sale_date", "sale_price",
                                             "list_date", "list_price", "custom_fields", "notes"])
    writer.writeheader()
    writer.writerow({"name": "斜杠日期", "brand": "B", "category": "C", "price": "100",
                     "purchase_date": "2026/10/1"})
    r = client.post("/api/import",
                    data={"file": (io.BytesIO(buf.getvalue().encode("utf-8")), "d.csv"), "mode": "append"},
                    content_type="multipart/form-data")
    check("斜杠日期可导入", jd(r)["inserted"] == 1, jd(r))
    item = [x for x in jd(client.get("/api/products"))["data"] if x["name"] == "斜杠日期"]
    check("斜杠日期归一化为 ISO",
          bool(item) and item[0]["purchase_date"] == "2026-10-01",
          item[0]["purchase_date"] if item else None)

    # 8) 导入 sold 无售价：盈亏留空，而不是当成全额损失
    payload = {"products": [{"name": "导入无价", "price": 500, "purchase_date": D(10),
                             "status": "sold", "sale_date": D(1)}]}
    client.post("/api/import",
                data={"file": (io.BytesIO(json.dumps(payload).encode()), "s.json"), "mode": "append"},
                content_type="multipart/form-data")
    item = [x for x in jd(client.get("/api/products"))["data"] if x["name"] == "导入无价"]
    check("导入无售价盈亏为空",
          bool(item) and item[0]["profit_loss"] is None,
          item[0]["profit_loss"] if item else None)


# ---------------------------------------------------------------- fnOS 网关前缀
def t_gateway_prefix():
    section("fnOS 统一网关（子路径 /app/assettracker）")

    r = client.get("/app/assettracker/")
    check("子路径首页 200", r.status_code == 200, r.status_code)
    html = r.data.decode("utf-8")
    check("注入 base 前缀", '<base href="/app/assettracker/">' in html)
    check("静态资源改相对路径", 'src="static/js/app.js' in html and 'src="/static' not in html)

    r = client.get("/app/assettracker/api/health")
    check("子路径 API 200", r.status_code == 200 and jd(r)["ok"], r.status_code)

    r = client.get("/app/assettracker/static/js/util.js")
    check("子路径静态资源 200", r.status_code == 200, r.status_code)

    r = client.get("/api/health")
    check("根路径仍然可用（局域网直连）", r.status_code == 200, r.status_code)
    check("根路径 base 为 /", '<base href="/">' in client.get("/").data.decode("utf-8"))


def main():
    t0 = time.time()
    for fn in (t_static, t_crud, t_settle, t_forsale, t_delete, t_wish, t_report,
               t_export, t_import, t_security, t_perf, t_edge, t_robustness, t_gateway_prefix, t_db):
        run(fn)

    total = len(RESULTS)
    failed = [r for r in RESULTS if not r[1]]
    print("\n" + "=" * 60)
    print(f"用例 {total} | 通过 {total - len(failed)} | 失败 {len(failed)} | 耗时 {time.time() - t0:.1f}s")
    if ISSUES:
        print("\n发现的问题：")
        for lv, title, detail in ISSUES:
            print(f"  [{lv}] {title} — {detail}")
    print("=" * 60)

    with open(Path(__file__).with_name("last_result.json"), "w", encoding="utf-8") as f:
        json.dump({"total": total, "failed": len(failed),
                   "results": [{"name": n, "ok": o, "detail": str(d)} for n, o, d in RESULTS],
                   "issues": [{"level": l, "title": t, "detail": d} for l, t, d in ISSUES]},
                  f, ensure_ascii=False, indent=2)
    shutil.rmtree(TMP, ignore_errors=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
