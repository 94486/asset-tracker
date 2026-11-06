# 开发指南

> 面向二次开发：怎么加功能、数据怎么存、口径怎么算、怎么测、怎么打包。
> 环境准备：`pip install -r requirements.txt`，然后 `python app.py`。

---

## 1. 代码地图

```
app.py               入口：create_app() + 按 HEADLESS / 冻结状态启动
at/
  __init__.py        应用工厂：蓝图注册、页面路由、错误处理、gzip、健康检查
  config.py          环境变量、资源/数据路径、静态资源版本号
  db.py              连接、WAL 探针、建表与迁移
  validators.py      日期/金额/自定义字段解析、状态常量
  costing.py         成本口径（纯函数）
  reporting.py       Top N 汇总、时间线（纯函数）
  http.py            JSON body 收敛
  ports.py           端口检测与清理
  desktop.py         托盘图标、桌面/开发模式启动
  api/
    products.py      资产 CRUD、出售/损坏、待售、撤销删除
    wishlist.py      预购 CRUD、转化、看板
    reports.py       汇总、折旧排名、待售看板
    data_io.py       导入导出
```

**依赖方向**：`api → db / validators / costing / reporting`，基础层不反向依赖接口层；`costing / reporting` 不 import Flask，也不碰数据库，所以能直接单测。

---

## 2. 请求怎么走

```
浏览器 fetch("/api/products")
  → Flask 路由（at/api/products.py）
  → json_body() 取参数
  → validators 校验
  → get_db() 拿连接（每请求一条，with closing 保证关闭）
  → SQL / compute_cost
  → jsonify（after_request 里按需 gzip）
```

启动时 `init_db()` 只做一次：建表、补列、建索引、设置日志模式。之后不再迁移。

---

## 3. 数据模型

### products（资产）

| 字段 | 说明 |
|---|---|
| `id` | 自增主键；撤销删除时尽量复用原 id |
| `name` / `brand` / `category` | 名称必填（≤120 字），品牌/分类可空 |
| `price` | 购入价，REAL，≥0 |
| `purchase_date` | 购买日期，ISO 字符串，不得晚于今天 |
| `config` / `notes` | 配置、备注 |
| `custom_fields` | JSON 字符串，任意「字段名 → 值」 |
| `status` | `in_use` / `for_sale` / `sold` / `damaged` |
| `sale_date` / `sale_price` | 结算信息，仅 sold/damaged 有值 |
| `list_date` / `list_price` | 待售信息，仅 for_sale 有值 |
| `created_at` | 本地时间字符串 |

状态机：

```
in_use ──/list──▶ for_sale ──/sell──▶ sold / damaged
   ▲                  │
   └─────/unlist──────┘
sold / damaged ──/sell {status:"in_use"}──▶ in_use（清空结算与挂售字段）
```

**不变量**：购买 ≤ 上架 ≤ 售出；`for_sale` 不应有结算字段；`sold` 必须有售价（历史缺价数据按「待补」处理，盈亏留空）。

### wishlist（预购）

独立表，**不计入任何成本口径**（还没付钱）。状态 `watching → ready → converted / dropped`，`converted` 记录保留 `product_id` 与 `converted_at` 作为决策留痕。

---

## 4. 计算口径

| 指标 | 持有中（in_use / for_sale） | 已结算 |
|---|---|---|
| 持有天数 | `today - purchase_date` | `max(sale_date - purchase_date, 1)` |
| 日均成本 | `price / days`（当天买入按 1 天） | `净消耗 / days` |
| 最终持有成本 | — | 售出：`(price - sale_price) / days`；损坏：`price / days` |
| 折旧 | — | `max(price - sale_price, 0)`，售价高于买入价记 0 |
| 盈亏 | — | 售出 `sale_price - price`；损坏 `-price` |

规则都在 `at/costing.py::compute_cost`，改动只需改这一处；前端只做展示，不重复计算口径。

---

## 5. 加一个功能

以「资产备注搜索」为例：

```python
# at/api/products.py
@products_bp.route("/products/search", methods=["GET"])
def search_products():
    q = request.args.get("q", "").strip()
    with closing(get_db()) as conn:
        rows = conn.execute(
            "SELECT * FROM products WHERE notes LIKE ?", (f"%{q}%",)
        ).fetchall()
    return jsonify({"ok": True, "data": [compute_cost(r) for r in rows]})
```

前端：

```js
const res = await api("/api/products/search?q=" + encodeURIComponent(kw));
```

**约定**

1. 参数解析只用 `at/validators.py`，别在路由里手写 `float()` / `strptime`；
2. 金额与日期计算走 `at/costing.py`；
3. 写接口统一 `{"ok": true, ...}` / `{"ok": false, "msg": "..."}`，HTTP 状态码同步（400/404/500）；
4. 需要多步写库时用 `SAVEPOINT`，别留下半截状态（参考 `convert_wish`）；
5. 新加字段用 `_ensure_column(conn, "products", "xxx", "TEXT")`，老库启动会自动补。

---

## 6. 测试

```bash
python qa/test_units.py          # 纯函数单测，毫秒级
python qa/acceptance_test.py     # 接口验收，自动建临时库，不碰 asset_tracker.db
```

加用例的位置：

- 解析/成本口径 → `qa/test_units.py` 的 `TestParse` / `TestCosting`
- 接口行为、状态机、导入导出 → `qa/acceptance_test.py` 对应 `t_*` 函数
- 涉及数据的用例记得自清理（参考 `t_edge`、`t_robustness` 里的 `DELETE`）

验收脚本用 `check(name, cond, detail)` 记录结果，失败不会中断，最后统一汇总；`qa/last_result.json` 是最近一次结果。

---

## 7. 打包

```bash
python build.py            # onedir（默认）
python build.py --onefile  # 单文件（不推荐，易被 SAC/杀软拦截）
```

- 产物：`dist/数码资产持有成本管理/`，分发要复制**整个文件夹**
- `build.py` 会检查 `flask / pystray / PIL / six`，缺依赖直接退出
- 打包前请确认没有实例正在运行，也别在资源管理器/预览面板里打开产物——exe 被占用时会报 `Device or resource busy`，覆盖会失败
- 实在释放不了（找不到占用进程）可以先输出到别处：
  ```bash
  AT_DISTPATH=dist_new python build.py
  ```
  再把 `dist_new/数码资产持有成本管理` 整个挪到 `dist/` 下
- 数据库在 exe 同级；`build.bat` 会自动备份与迁移

---

## 8. 多目标并行开发

三个产物共用同一份核心，只是打包适配层不同：

| 目标 | 入口 | 产物 | 打包脚本 |
|---|---|---|---|
| Windows 桌面 | `app.py` | `dist/数码资产持有成本管理/` | `build.py` |
| Docker | `app.py` | 镜像 `assettracker:<版本>` | `Dockerfile` |
| 飞牛 fnOS | `app.py` | `dist-fpk/assettracker_<版本>_x86.fpk` | `packaging/fnos/build.py` |

**约定**

1. **版本只改 `VERSION`**：`at/config.py` 读它做健康检查，`build.py` 打进 exe，`packaging/fnos/build.py` 注入 manifest 与 compose。
2. **加模块要同步 Dockerfile**：镜像只 COPY 白名单文件，漏了 `at/` 就会在 import 时挂掉；`qa/test_packaging.py` 会拦住这类漂移。
3. **打包层不放业务逻辑**：只做组装、注入、校验。业务改动只动 `at/` 与前端。
4. **每个目标有自己的契约测试**：改完打包配置跑 `python qa/test_packaging.py`；业务改动跑 `qa/acceptance_test.py`。
5. **并行分支**：核心改动走主干；`packaging/*`、`Dockerfile`、`build.py` 可以各自小步提交，冲突面很小。
6. **镜像 tag 由 `VERSION` 决定**：`build-image.sh` 打 `assettracker:$VERSION`，compose 默认值同源；两者不一致时 `build.py` 会读 `docker save` 的 `manifest.json` 报警。

**本机一条龙（WSL Docker）**

```bash
# Windows 双击即可，等价于在 WSL Debian 里跑 build-image.sh --save
packaging\fnos\build-image.bat --save

# 构建 → 冒烟（HEALTHCHECK + 容器内读写）→ 导出 .out/assettracker-image.tar
# 再自动带上镜像打 fpk
packaging\fnos\build-fpk.bat
```

脚本会自己解决这些环境问题：dockerd 没启动、`/mnt/d` 上 9p 构建慢（自动复制到 `/var/tmp`）、
镜像架构不是 amd64（告警）、tag 与包版本不一致（告警 + `install_callback` 补别名）。
所以并行开发时**不要手敲 `docker build`**，否则很容易漏掉冒烟和版本对齐。

CI 矩阵参考（GitHub Actions）：

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pip install -r requirements.txt
      - run: python qa/test_units.py && python qa/acceptance_test.py && python qa/test_packaging.py
  windows-exe:
    needs: test
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - run: pip install -r requirements.txt
      - run: python build.py
  fnos-fpk:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pip install -r requirements.txt
      # 构建 + 容器冒烟 + 导出镜像（runner 自带 docker）
      - run: bash packaging/fnos/build-image.sh --save
      # 带上镜像打离线包，安装时不需要联网拉镜像
      - run: python packaging/fnos/build.py --with-image
      - uses: actions/upload-artifact@v4
        with:
          name: fnos-fpk
          path: dist-fpk/*.fpk
```

---

## 9. 已知边界

| 场景 | 现状 | 建议 |
|---|---|---|
| 5000+ 条数据 | 列表接口返回全量 JSON（约 3MB，gzip 后 ~300KB） | 前端已分页；如需再优化可加 `limit/offset` |
| 多用户并发 | 无认证、无锁粒度的乐观并发 | 适合单机/家庭；多人用请放内网并加反代认证 |
| 时区 | 全部用本机本地时间（`date.today()`） | 跨时区使用需统一到 UTC |
| 导入 10 万行 | 单事务批量插入，内存占用高 | 建议拆分文件；上限 64MB |
| 网络盘 | WAL 探针会自动回退 rollback journal | 仍建议放本地盘 |
