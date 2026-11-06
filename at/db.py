# -*- coding: utf-8 -*-
"""SQLite 连接、日志模式探测与建表迁移"""
import os
import sqlite3
import tempfile
import threading
from contextlib import closing

from .config import DB_FILE


def _probe_journal_mode(target_path):
    """选日志模式：WAL 只有在支持共享内存的本地盘上才可靠。

    实测（12 线程并发写 480 次）：
      · 本地盘 WAL        -> 0 失败，且读写互不阻塞，是最佳选择
      · SMB/网络盘 WAL    -> 数个 "attempt to write a readonly database"
                            （-shm 共享内存无法打通，写锁协调失败）
      · 网络盘 rollback   -> 0 失败
    所以这里先做一次真并发探针，不可靠就退回 rollback journal，
    而不是盲目相信 PRAGMA 的返回值（网络盘上它照样回 "wal"）。
    """
    import shutil
    probe_dir = tempfile.mkdtemp(prefix=".at_probe_", dir=os.path.dirname(target_path) or ".")
    probe_db = os.path.join(probe_dir, "probe.db")
    try:
        seed = sqlite3.connect(probe_db)
        seed.execute("PRAGMA journal_mode = WAL")
        seed.execute("CREATE TABLE t (a INTEGER)")
        seed.commit()
        seed.close()

        fails = []
        lock = threading.Lock()

        def _hammer():
            for _ in range(20):
                conn = None
                try:
                    conn = sqlite3.connect(probe_db, timeout=5)
                    conn.execute("PRAGMA busy_timeout = 5000")
                    conn.execute("INSERT INTO t VALUES (1)")
                    conn.commit()
                except sqlite3.DatabaseError as e:
                    with lock:
                        fails.append(str(e))
                finally:
                    if conn is not None:
                        conn.close()

        threads = [threading.Thread(target=_hammer) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        return "wal" if not fails else "delete"
    except Exception:
        return "delete"
    finally:
        shutil.rmtree(probe_dir, ignore_errors=True)


_JOURNAL_MODE = None


def journal_mode():
    """惰性探测一次并缓存（每次启动只付一次探针成本）"""
    global _JOURNAL_MODE
    if _JOURNAL_MODE is None:
        _JOURNAL_MODE = _probe_journal_mode(DB_FILE)
    return _JOURNAL_MODE


def get_db():
    mode = journal_mode()
    # 网络盘上 timeout 要留够：写锁是串行的，等总比报错好
    conn = sqlite3.connect(DB_FILE, timeout=30 if mode == "wal" else 60)
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {30000 if mode == 'wal' else 60000}")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _ensure_column(conn, table, column, ddl):
    """幂等加列：老库升级时补字段，已存在则跳过"""
    cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
        return True
    return False


def init_db():
    with closing(get_db()) as conn:
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
                status TEXT NOT NULL DEFAULT 'in_use',   -- in_use / for_sale / sold / damaged
                sale_date TEXT,
                sale_price REAL,
                custom_fields TEXT DEFAULT '{}',          -- JSON
                notes TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now','localtime'))
            )
            """
        )
        # 待售相关字段：上架时间与挂单价。
        # 不另建表是因为资产本身已经在 products 里，待售只是「处置意图」的一种状态，
        # 拆表会让同一件资产在两处各存一半，售出时还要跨表对齐。
        _ensure_column(conn, "products", "list_date", "TEXT")
        _ensure_column(conn, "products", "list_price", "REAL")

        # 预购清单：独立表。
        # 关键理由——预购还没付钱，不该进入任何成本 / 投入口径，
        # 否则「总投入」会被一堆没买的意向撑虚。转化购买时才落成 products。
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS wishlist (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                brand TEXT DEFAULT '',
                category TEXT DEFAULT '',
                target_price REAL NOT NULL DEFAULT 0,   -- 预期入手价（预算）
                expected_date TEXT,                      -- 计划入手日期
                priority TEXT NOT NULL DEFAULT 'normal', -- high / normal / low
                source TEXT DEFAULT '',                  -- 渠道：京东 / 闲鱼 / 官网…
                status TEXT NOT NULL DEFAULT 'watching', -- watching / ready / converted / dropped
                product_id INTEGER,                      -- 转化后对应的资产 id
                converted_at TEXT,
                custom_fields TEXT DEFAULT '{}',         -- JSON
                notes TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now','localtime'))
            )
            """
        )
        # 预购也要能记「想买的是哪个配置」：8G 还是 16G、哪个版本。
        # 注意必须放在 CREATE TABLE 之后——新库上先加列会撞
        # "no such table: wishlist"，直接让启动挂掉。
        _ensure_column(conn, "wishlist", "config", "TEXT DEFAULT ''")
        # 覆盖列表排序 / 报表分组的常用查询
        cur.execute("CREATE INDEX IF NOT EXISTS idx_products_pdate ON products(purchase_date)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_products_status ON products(status)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_wishlist_status ON wishlist(status)")
        conn.commit()

        # journal_mode 需在事务外设置，且会持久化到数据库文件。
        # 用探针结果决定，而不是无条件开 WAL：网络盘上 WAL 反而会丢写。
        try:
            mode = journal_mode()
            conn.execute(f"PRAGMA journal_mode = {mode.upper()}")
            conn.execute("PRAGMA synchronous = NORMAL" if mode == "wal" else "PRAGMA synchronous = FULL")
        except sqlite3.DatabaseError:
            pass  # 某些网络盘不支持 WAL，退回默认模式也能工作
