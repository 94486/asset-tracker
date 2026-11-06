# 数码资产持有成本管理系统

一个用于记录数码产品购入、计算每日持有成本、登记出售/损坏并分析折旧的本地桌面小工具。

- 数据完全本地化：SQLite 单文件存储，不依赖网络、不上传云端
- 双形态运行：打包 exe（单机桌面 + 系统托盘）或 Docker（局域网 Web 服务）
- 双主题界面：深色 / 浅色一键切换并自动记忆，统一设计令牌 + 线性 SVG 图标，分区信息架构、响应式与可访问性
- 自带程序图标：托盘、任务栏、窗口、页面 favicon 使用同一套图标（`asset.ico` 已嵌入 exe）

## 文档

- [开发指南](docs/DEVELOPMENT.md)：代码分层、数据模型、计算口径、加接口的套路、测试与打包
- [变更记录](CHANGELOG.md)：每个版本改了什么、修了哪些 bug
- [验收报告](qa/验收报告.md)：用例覆盖、缺陷清单与复测结果

## 快速开始

### 方式一：直接运行 exe（推荐）

双击运行 `dist/数码资产持有成本管理/数码资产持有成本管理.exe`，会自动在浏览器打开（地址 `http://127.0.0.1:5678`）。
首次运行会在 exe 同级目录生成 `asset_tracker.db`（SQLite 数据库），所有数据都存在这里。

> **分发时要复制整个 `数码资产持有成本管理` 文件夹**，只拷 exe 无法运行（依赖在 `_internal` 里）。
> 采用文件夹模式而不是单文件，是为了避免 onefile 自解压到临时目录时被 Windows 智能应用控制（SAC）/杀软拦截。

> 提示：如果浏览器没有自动弹出，手动访问 http://127.0.0.1:5678 即可。

**托盘图标**（仅 exe 模式）：

| 操作 | 功能 |
|---|---|
| 单击图标 | 打开浏览器页面 |
| 双击图标 | 打开浏览器页面 |
| 右键菜单 | 打开页面 / 退出程序 |

### 方式二：Python 源码运行

```bash
pip install -r requirements.txt
python app.py
```

服务启动在 http://127.0.0.1:5678，支持 Ctrl+C 优雅退出。

### 方式三：Docker 部署

详见 [DOCKER.md](DOCKER.md)，适合部署到服务器 / NAS 多设备访问。

### 方式四：飞牛 fnOS（.fpk）

详见 [packaging/fnos/README.md](packaging/fnos/README.md)。一条命令（Windows 双击，内部走 WSL Debian 的 Docker）：

```
packaging\fnos\make-fpk.bat
```

它会构建镜像 → 容器冒烟 → 把镜像打进 fpk，产出**自包含**的 `dist-fpk/assettracker_1.0.0_x86.fpk`（约 60MB），
装到飞牛上不需要再 build 镜像、不需要联网。然后在飞牛桌面 → 应用中心 → 右上角设置 → 手动安装应用 → 选该 fpk。

只想打 20KB 的壳（NAS 上已有镜像）就单独跑 `build-fpk.bat`。

## 功能

### 资产管理
1. **录入资产**：名称、品牌、分类、购买价格、购买时间、配置，支持任意「自定义选项」（字段名 + 值）；品牌与分类输入框带历史值联想。
2. **实时成本预览**：录入表单顶部随输入即时显示「每日持有成本 / 已持有天数 / 年化开销」，不用先保存再看结果。
3. **每日持有成本**：`购买价格 ÷ 已持有天数`，列表实时显示，按状态着色：
   - 使用中 → 绿色 `#35d69b`
   - 已售出 → 金色 `#f0b64a`
   - 已损坏 → 红色 `#ff6b6b`
4. **登记出售 / 损坏**：
   - 弹窗顶部展示该资产的购入价、购买日与已持有天数，先看清再操作。
   - 用「处理结果」分段选择明确 **已售出 / 已损坏**；选「已售出」时才显示出售价格并做必填校验。
   - 处理日期不可早于购买日期（前后端双重校验，避免持有天数为负）。
   - **结算实时预览**：填价格的同时算出持有天数、最终日均成本、折旧金额与盈亏。
   - 已售出：`最终持有成本 =（购买价 − 出售价）÷ 持有天数`；已损坏：视为全额损失。
   - 已处理的资产可随时「恢复」为使用中。
5. **KPI 条**：列表页顶部一屏概览持有资产总额、当前每日成本（含年化）、累计投入、已结算盈亏。
6. **强大表格**：
   - 列排序（点击表头切换升/降序，当前排序写入 URL，刷新后保留）
   - 状态 chips 快筛（带各状态件数）+ 品牌 / 分类下拉 + 关键词搜索（160ms 防抖）
   - **可见的筛选状态**：已生效条件以标签形式列出，可逐个移除或一键清除
   - 表头吸顶 + 汇总行吸底（长列表滚动时列名与合计始终可见）
   - 汇总行（当前筛选结果的投入合计、每日成本合计、盈亏合计）
   - 操作列图标化（处理/恢复为主操作，编辑/删除为图标按钮 + 悬浮提示）
   - 名称前品类图标胶囊：常见数码品类（手机 / 平板 / 笔记本 / 显示器 / 耳机 / 手表 / 相机 / 键鼠 / 游戏 / 电视投影 / 音箱 / 充电电源 / 智能眼镜 / NAS / 主板芯片等）各有专属线性图标
   - 行展开详情（配置、自定义字段、备注、折旧率进度条），展开状态写入 URL
   - **加载骨架屏**与**失败重试**：请求期间显示占位骨架，失败时给出可重试提示
   - 智能空状态：区分「还没有数据」与「筛选无结果」，后者提供一键清除筛选
   - **删除可撤销**：删除后提示条保留 6 秒，点「撤销」原样恢复记录
   - **移动端卡片式表格**：窄屏下每行自动重排为「名称 / 价格 / 日均 / 盈亏 / 操作」的信息卡，不再横向溢出

### 报表分析
> 报表页按「总览 → 智能洞察 → 趣味排行 → 数据图表」分区组织，并支持 **全部 / 近 12 个月 / 本年** 三种统计范围，所有卡片与图表同步跟随。

- **统计卡片**（4 张）：
  - 持有资产总额（仅使用中，含件数）
  - 每日持有成本合计（含年化与均件成本）
  - 结算结果（售出回血 / 盈亏合计双数字 + 盈利与亏损件数）
  - 总投入与资产数（按状态细分）
- **智能洞察**（双列卡片，基于当前数据自动生成 3–5 条情境化提示）：
  - 按在用资产每日成本推算的年化 / 月均持有开销
  - 当下最烧钱的在用单品
  - 折旧率 ≥ 60% 的高损耗预警
  - 售出盈利 / 几乎零损耗的保值亮点
  - 最划算的在用资产（日均成本最低）
  - 品牌 / 分类缺失的数据完整度提醒
- **趣味排行榜**（8 张）：
  - 败家之王、最强钉子户、跳水冠军、性价比之王、最保值产品、年度败家王、最新入手、品类之最
- **7 张图表**：
  - 累计投入走势（面积图）
  - 每日持有成本排名（柱状图）
  - 资产折旧排行（含折旧率、最终持有成本）
  - 品牌投入分布（环形图）
  - 分类投入分布（玫瑰图）
  - 月度投入趋势（渐变柱状图）
  - 资产画像散点图（持有天数 vs 每日成本，气泡大小 = 购入价）
  - 图表配色随主题自动切换，无数据时显示「暂无数据」而非空白画布

### 数据导入导出
- **导出**：下拉菜单选择 JSON（完整字段，含自定义选项）或 CSV（带 UTF-8 BOM，Excel 直接打开不乱码），文件名自动带时间戳。
- **导入**：支持 JSON / CSV 文件（自动识别 UTF-8 / GBK 编码，正确处理引号包裹的逗号与换行），两种模式：
  - **追加导入**：保留现有数据，按「名称 + 价格 + 购买日期」自动去重，重复跳过
  - **覆盖导入**：清空现有数据后导入（导入前会提示将清空的记录数并二次确认）
- 导入完成后自动刷新资产列表与报表图表。

### 界面体验
- **双主题**：深色 / 浅色完整令牌化，首屏无闪白，选择持久化到 localStorage；首次访问跟随系统偏好
- **统一设计系统**：间距、圆角、字阶、色板、阴影全部令牌化，视觉语言一致
- **线性 SVG 图标**：内置图标精灵，界面控件统一用描边图标（趣味排行保留 emoji 作为刻意的轻松点缀）
- **分段式顶部导航** + 报表页分区标题，信息层级清晰
- **数据流一致的配色**：使用中绿 / 已售出金 / 已损坏红，盈亏绿涨红跌，图表与表格同源
- **响应式**：宽屏多列、窄屏单列、移动端卡片式表格三层适配
- **语义化层级**：表面由深到浅四级，圆角与描边克制收敛，避免过度装饰

### 交互增强
- **自定义对话框**：删除、导入模式、结果提示、出售/损坏等全部改为风格统一的模态框，替代原生 `confirm` / `alert`
- **导入模式三选一**：追加 / 覆盖 / 取消 明确选择，覆盖前二次确认
- **键盘快捷键**：
  | 键 | 功能 |
  |---|---|
  | `N` | 新增资产 |
  | `/` | 聚焦搜索 |
  | `R` / `L` | 切换到报表 / 资产页 |
  | `E` | 打开导出菜单 |
  | `T` | 切换明暗主题 |
  | `Esc` | 逐级关闭（对话框 → 弹窗 → 抽屉 → 菜单） |
- **搜索防抖**：输入 160ms 后才重绘，减少无谓刷新
- **语义化 toast**：成功（绿）/ 失败（红）即时反馈，删除操作附带「撤销」
- **按钮加载态**：保存、登记、删除等异步操作期间按钮显示 spinner 并禁用，防止重复提交；导入过程显示常驻「正在导入…」提示
- **表单校验反馈**：必填项校验失败时输入框描红并自动聚焦，后端错误消息直接透传到提示条
- **深链路由**：当前页签、排序方式、展开行写入 URL hash，刷新或分享链接可还原视图；手动改地址栏、浏览器前进/后退、外部链接跳转都会实时同步页面（`hashchange`）
- **GitHub 入口**：顶栏右侧提供项目地址按钮，一键在新标签打开仓库
- **可访问性**：键盘 `:focus-visible` 焦点环、`prefers-reduced-motion` 自动降级动效、图标按钮 `aria-label`、表头 `aria-sort`、筛选与图表标签可达

## 技术架构

- 后端：Python + Flask（`werkzeug.make_server`，无外网依赖）
- 数据库：SQLite（`asset_tracker.db`，持久化在数据目录，含 `purchase_date` / `status` 索引）
- 前端：原生 HTML/CSS/JS + ECharts（本地离线加载），无构建步骤
- 托盘：pystray + PIL（仅桌面 exe 模式）
- 打包：PyInstaller（**onedir 文件夹模式**，免安装 Python；不做单文件自解压，避免被 SAC / 杀软拦截）

### 代码分层

| 层 | 位置 | 职责 | 依赖规则 |
|---|---|---|---|
| 入口 | `app.py` | 创建 app、按 HEADLESS/冻结状态选择启动方式 | 只依赖 `at/`，不写业务 |
| 装配 | `at/__init__.py` | Flask 配置、注册蓝图、页面路由、DB 异常兜底 | 可依赖所有下层 |
| 接口 | `at/api/*.py` | 路由 + 参数校验 + SQL + 返回 JSON | 只能依赖 db / validators / costing / reporting |
| 领域 | `at/costing.py`、`at/reporting.py` | 成本口径、Top N 汇总等纯函数 | **不碰 Flask、不碰数据库**，可单测 |
| 基础 | `at/db.py`、`at/config.py`、`at/validators.py` | 连接、路径、解析 | 最底层，不反向依赖 |

**新增一个接口的固定套路**（以「资产备注搜索」为例）：

1. 在对应蓝图文件里加路由，例如 `at/api/products.py`：

   ```python
   @products_bp.route("/products/search", methods=["GET"])
   def search_products():
       q = request.args.get("q", "").strip()
       with closing(get_db()) as conn:
           rows = conn.execute(
               "SELECT * FROM products WHERE notes LIKE ?", (f"%{q}%",)
           ).fetchall()
       return jsonify({"ok": True, "data": [compute_cost(r) for r in rows]})
   ```

2. 参数解析只用 `at/validators.py` 里的函数，别在路由里手写 `float()`；
3. 金额/日期计算一律走 `at/costing.py`，不要在路由或前端各算一套；
4. 前端在 `static/js/app.js` 里用 `api("/api/products/search?q=...")` 调用；
5. 补两条用例到 `qa/acceptance_test.py`，跑一遍 `python qa/acceptance_test.py`。

**判断该放哪一层**：能写成 `输入 → 输出` 的纯计算就放 `costing/reporting`；需要读写库、需要 request 的放 `at/api/`；两者之间的常量与解析放 `validators`。

### API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/products` | 全部资产（含成本计算字段） |
| POST | `/api/products` | 新增资产 |
| PUT | `/api/products/<id>` | 更新基本信息（不含状态与结算字段） |
| DELETE | `/api/products/<id>` | 删除，返回被删记录供撤销 |
| POST | `/api/products/restore` | 撤销删除，按原记录写回 |
| POST | `/api/products/<id>/sell` | 登记出售 / 损坏 / 恢复为使用中 |
| POST | `/api/products/<id>/list` | 把在用资产转入待售清单（校验购买 ≤ 上架 ≤ 今天） |
| POST | `/api/products/<id>/unlist` | 从待售清单下架，退回使用中（清空上架信息） |
| PATCH | `/api/products/<id>/ask` | 只改挂单价，返回改后的预期盈亏 |
| GET/POST | `/api/wishlist` | 预购清单查询 / 新增 |
| PUT/DELETE | `/api/wishlist/<id>` | 编辑 / 删除预购 |
| PATCH | `/api/wishlist/<id>/price` | 只改心理价（已转化不可改） |
| POST | `/api/wishlist/<id>/convert` | 预购 → 资产（SAVEPOINT 保证原子） |
| POST | `/api/wishlist/<id>/drop`、`/restore` | 标记放弃 / 从放弃恢复 |
| GET | `/api/wishlist/board` | 预购看板：预算、待下手、转化率、计划月份 |
| GET | `/api/forsale/board` | 待售看板：压货成本、挂单报价、预期盈亏、挂单时长分布 |
| GET | `/api/report/summary` | 汇总指标、品牌/分类/状态分布、月度与年度聚合（分组走 SQL `GROUP BY`） |
| GET | `/api/report/depreciation?limit=15` | 每日成本 Top N、折旧 Top N、按日聚合的投入时间线；`daily_others` / `dep_others` 汇总被截断的部分，合计不会丢 |
| GET | `/api/export?format=json\|csv` | 导出数据（CSV 对 `= + - @` 开头的单元格加前导单引号，防公式注入） |
| POST | `/api/import` | 导入数据（`mode=append\|replace`，单事务批量写入；覆盖前自动备份） |
| GET | `/api/health` | 健康检查：`{ok, db, version}`，可用于 Docker healthcheck / 探活 |

> 所有写接口均做服务端校验（名称非空、价格非负且可解析、日期合法、**购买日期不得晚于今天**、处理日期不早于购买日期），错误信息通过 `{"ok":false,"msg":"..."}` 返回，前端直接展示。

### 数据层要点

| 机制 | 说明 |
|---|---|
| 连接生命周期 | 所有 handler 用 `with closing(get_db())`，异常路径也能关闭连接，不再泄漏 |
| 并发写 | `busy_timeout` + 启动时**真并发探针**决定日志模式：本地盘用 WAL（读写互不阻塞），网络盘自动退回 rollback journal（WAL 在 SMB 上会丢写） |
| 聚合下推 | 品牌 / 分类 / 月度 / 年度分布在 SQLite 里 `GROUP BY`，Python 只算需要日期运算的单条成本 |
| 索引 | `purchase_date`、`status` 建索引，覆盖列表排序与状态筛选 |
| 排名限流 | 报表排名接口只返回 Top N，避免几千条记录撑出几百 KB 无用负载 |
| 传输压缩 | ≥1KB 的 JSON/HTML/CSS/CSV 按 `Accept-Encoding` 走 gzip，1200 条列表 793KB → 约 90KB |
| 覆盖导入保护 | 先整份校验再清空；无有效行直接拒绝；清空前用 SQLite `backup()` 写一份 `.backup` |
| 错误口径 | `/api/*` 的 404/405/413/500 统一返回 JSON，上传上限 64MB |
| 端口清理 | 启动时只结束本程序 / `python` 进程，不误杀占用 5678 的其它服务 |
| 折旧口径 | 折旧与折旧率恒 ≥ 0 且不超过 100%；售价高于买入价的溢价只计入盈亏，不记为负折旧 |

### 前端渲染要点

| 机制 | 说明 |
|---|---|
| 分页 | 默认每页 50 条（可选 50/100/200 并持久化）。5000 条数据从「渲染 20 万个 DOM 节点」降到 50 行 |
| 页脚合计 | 始终按「筛选后的全部记录」计算，翻页不会让合计变小 |
| 批量操作 | 表头全选当前页（支持 indeterminate 半选），批量处理 / 批量删除 / 取消选择 |
| 列配置 | 品牌、购买时间、已持有、状态四列可隐藏，选择持久化；页脚 `colspan` 随可见列数重算 |
| 图表联动 | 点击品牌 / 分类饼图跳到列表并按该维度筛选；点击散点定位到具体资产并展开详情 |
| 筛选持久化 | 关键词、状态、品牌、分类、排序写入 localStorage，刷新或重开程序仍在原视图 |
| 清单页布局 | 预购 / 待售两页按「**清单优先**」排：页头 → KPI → 物品清单 → 看板。清单是干活的地方（比价、改价、卖出），报表是事后复盘，所以放下面 |
| 就地改价 | 心理价 / 挂单价点一下即变输入框，回车保存、Esc 取消、失焦提交；保存后 KPI、看板、合计一起刷新 |

### 预购与待售：为什么是两套模型

两条清单长得像，但存储方式**故意不同**，原因是「还没买」和「已经买了」在会计上不是一回事。

| | 预购清单 | 待售清单 |
|---|---|---|
| 存储 | **独立 `wishlist` 表** | `products` 上的一个状态 `for_sale` |
| 理由 | 还没付钱，是意向不是资产。塞进 `products` 会撑虚「总投入」和「持有资产」，报表直接失真 | 东西已经在 `products` 里了。拆表会让同一件资产在两处各存一半，售出时还要跨表对齐 |
| 是否计入成本 | **完全不计** | **照常计**：钱还压在里面，每日成本继续累加 |
| 状态机 | `watching` → `ready` → `converted`（转资产）/ `dropped`（放弃） | `in_use` → `for_sale` → `sold` / `damaged`；`for_sale` → `in_use`（下架） |
| 接缝 | `POST /convert`：成交价覆盖预算价，回写 `product_id`，原预购记录留痕 | `POST /sell`：复用原有结算路径 |
| 不变量 | 已转化不可再改价、不可重复转化 | 购买 ≤ 上架 ≤ 售出；只有 `for_sale` 能改挂单价 |

**留痕与口径**（用户最容易踩的预期）：

- 已售出 / 已损坏的资产**不删除**，一直留在资产库，所以「累计投入」是真实的历史总额，不会因为卖掉就变小。
- 损坏按**全额损失**计（`profit_loss = -购入价`），售出按 `成交价 - 购入价` 计。
- 已结算资产移出「持有资产总额」和「每日持有成本」，但盈亏计入「累计盈亏」。
- 预购转化时若没另填规格，沿用预购阶段记下的**参数**（8G/16G、版本），不会到这一步丢掉。

## 目录结构

```
asset_tracker/
├── app.py                  # 入口：装配 create_app() 并按模式启动
├── at/                     # 后端包（按职责分层）
│   ├── __init__.py         # 应用工厂：注册蓝图、页面路由、DB 异常兜底
│   ├── config.py           # 环境变量 / 路径解析 / 静态资源版本
│   ├── db.py               # 连接、WAL 探针、建表与迁移
│   ├── validators.py       # 日期 / 金额 / 自定义字段解析、状态常量
│   ├── costing.py          # 成本口径（纯函数，可单测）
│   ├── reporting.py        # Top N 汇总、时间线（纯函数）
│   ├── http.py             # JSON body 统一收敛为 dict
│   ├── ports.py            # 端口占用检测与清理
│   ├── desktop.py          # 托盘图标、桌面/开发模式启动
│   └── api/                # 蓝图，统一挂 /api
│       ├── products.py     # 资产 CRUD / 出售 / 待售 / 撤销删除
│       ├── wishlist.py     # 预购清单与转化
│       ├── reports.py      # 汇总、折旧排名、待售看板
│       └── data_io.py      # 导入导出（JSON/CSV）
├── build.py                # PyInstaller 打包逻辑（默认 onedir）
├── build.bat               # 一键打包脚本（含数据库备份/迁移）
├── make_icon.py            # 生成多尺寸 asset.ico（exe 图标）
├── asset.ico               # 程序图标（16/24/32/48/64/128/256）
├── requirements.txt        # 运行依赖
├── .gitignore              # Git 忽略规则
├── templates/
│   └── index.html          # 页面（资产列表 + 报表 + 抽屉/弹窗 + 图标精灵）
├── static/
│   ├── css/style.css       # 设计令牌 + 组件样式 + 响应式 + 明暗主题
│   └── js/
│       ├── util.js         # 通用工具：选择器 / 格式化 / 日期 / 请求封装
│       ├── app.js          # 业务逻辑（表格 / 图表 / 导入导出 / 排行 / 主题）
│       └── echarts.min.js  # 图表库（离线可用）
├── qa/
│   ├── acceptance_test.py  # 接口验收（149 用例，临时库隔离）
│   ├── test_units.py       # 核心逻辑单测（18 用例，stdlib unittest）
│   ├── test_packaging.py   # 打包契约（18 用例：Docker/fpk/镜像链路一致性）
│   └── 验收报告.md
├── packaging/fnos/         # 飞牛 fnOS fpk 工程
│   ├── assettracker/       # manifest / cmd / config / app / ui
│   ├── build-image.sh      # 构建镜像 + 容器冒烟 + 导出离线镜像（WSL/Linux）
│   ├── build-image.bat     # ↑ 的 Windows 双击入口（走 WSL）
│   ├── build-fpk.bat       # 带上离线镜像打 fpk
│   ├── build.py            # 组装 + 图标 + 版本注入 + fnpack + 校验
│   ├── bin/                # fnpack 缓存（自动下载，不入库）
│   ├── .out/               # 导出的镜像 tar（不入库）
│   └── README.md
├── VERSION                 # 版本唯一来源（exe / Docker / fpk 共用）
├── docs/
│   └── DEVELOPMENT.md      # 开发指南：分层、数据模型、口径、测试、打包
├── CHANGELOG.md            # 变更记录
├── dist-fpk/               # fpk 产物（不入库）
├── dist/                   # 打包产物（文件夹模式）
│   └── 数码资产持有成本管理/
│       ├── 数码资产持有成本管理.exe
│       ├── _internal/      # 依赖、templates、static
│       └── asset_tracker.db
├── Dockerfile              # Docker 部署
├── docker-compose.yml
└── DOCKER.md               # Docker 使用说明
```

### 源文件与生成产物

**纳入版本库的源文件**（手工维护，唯一需要提交的内容）：

- `app.py`、`at/`、`templates/`、`static/`（含离线 `echarts.min.js`）
- `qa/`（验收脚本、单测、打包契约、验收报告）、`docs/DEVELOPMENT.md`、`CHANGELOG.md`
- `packaging/fnos/`（fpk 模板与打包脚本，不含 `bin/` 与 `.build/`）
- `VERSION`
- `build.py`、`build.bat`、`make_icon.py`、`asset.ico`
- `Dockerfile`、`docker-compose.yml`、`.dockerignore`、`DOCKER.md`
- `requirements.txt`、`requirements-docker.txt`、`README.md`、`.gitignore`

**自动生成 / 本地数据，已被 `.gitignore` 忽略，不要提交**：

| 路径 | 说明 | 处理 |
|---|---|---|
| `dist/` | 打包输出（onedir 文件夹） | 每次打包生成；分发用 GitHub Release，不入库 |
| `build/` | PyInstaller 中间缓存 | 可安全删除，打包时自动重建 |
| `数码资产持有成本管理.spec` | PyInstaller 生成的配置 | 打包时自动重建 |
| `asset_tracker.db` | 本地数据库（用户数据） | 严禁提交；迁移请复制该文件或用「JSON 导出」 |
| `asset_tracker.db.backup*` | 打包脚本的临时备份 | 可删除 |
| `__pycache__/`、`*.pyc` | Python 字节码缓存 | 可删除 |
| `.venv/`、`venv/` | 虚拟环境 | 不入库 |

> 正常情况下 `git status` 只应显示上面「源文件」的改动。若看到 `dist/`、`build/`、`*.db`、`*.spec` 出现在待提交列表，通常是历史遗留的**已跟踪**文件（`.gitignore` 对已跟踪文件无效），用 `git rm --cached <路径>` 取消跟踪、保留本地文件即可。

## 数据存储与备份

- 所有数据保存在 `asset_tracker.db`（SQLite 单文件），**删除该文件即清空所有记录**。
- 数据库位置优先级：
  1. `DATA_DIR` 环境变量（Docker 卷挂载时）
  2. exe 同级目录（打包后，即 `dist/数码资产持有成本管理/`） / 项目根目录（源码运行时）
- **打包自动保护数据**：`build.py` 在调用 PyInstaller 前会把数据库复制到临时目录，构建完（或构建失败）自动放回，所以「双击 build.bat」和「命令行跑 build.py」都不会丢数据；无数据库时首次运行自动新建。
- **从旧版单文件升级**：`build.bat` 会自动把 `dist/asset_tracker.db` 迁移到 `dist/数码资产持有成本管理/asset_tracker.db`，并删除旧的单文件 exe。
- **覆盖导入前自动备份**：清空数据前用 SQLite `backup()` 写一份 `asset_tracker.db.backup`（滚动一份）；备份失败会取消这次导入。
- 建议定期用「JSON 导出」功能备份数据，或直接复制 `asset_tracker.db` 文件。

## 重新打包

### 方式一：双击脚本（推荐）

双击 `build.bat`，自动完成 6 步流程：

```
[1/6] 检查 Python 环境
[2/6] 安装项目依赖
[3/6] 清理旧构建文件（备份并保留数据库）
[4/6] 执行打包（onedir 文件夹模式，约 1-3 分钟）
[5/6] 迁移数据库（沿用原有数据）
[6/6] 打包完成
```

产物在 `dist/数码资产持有成本管理/`，启动文件是该目录下的 `数码资产持有成本管理.exe`。

> **为什么用文件夹模式**：onefile 每次启动都要把自己解压到 `%TEMP%` 再执行，这个行为是 Windows 智能应用控制（SAC）和杀软的高危特征，容易被直接拦截；onedir 不解压、启动更快，也不容易被误判。
>
> 需要单文件时：`python build.py --onefile`（不推荐，可能重新触发 SAC 拦截）。

> 打包失败也会自动尝试恢复数据库，数据万无一失。
>
> **打包前必须装齐依赖**（`pystray`、`Pillow` 缺一不可）：`build.py` 会先检查这几个模块，缺了直接报错退出，避免打出一个「没有托盘图标」的 exe。
>
> exe 图标由 `asset.ico` 提供（`build.py` 会通过 `--icon` 嵌入；若图标缺失会自动调用 `make_icon.py` 重新生成）。修改图标样式后删除 `asset.ico` 再打包即可。

### 方式二：命令行

```bash
pip install -r requirements.txt
python build.py
```

## 配置项

通过环境变量配置（源码运行或 Docker 均支持）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `5678` | 监听端口 |
| `HEADLESS` | 空 | 设为 `1` / `true` 时纯服务模式：不开浏览器、无托盘（Docker 内置） |
| `DATA_DIR` | 自动 | 数据库目录（Docker 卷挂载用） |

## 自定义主题

界面配色全部收敛在 `static/css/style.css` 顶部的设计令牌里，改一处全站生效：

- 深色令牌定义在 `:root`，浅色覆盖在 `[data-theme="light"]`
- 语义色：`--green`（使用中）、`--gold`（已售出）、`--red`（已损坏 / 亏损）、`--accent`（主色）
- 图表配色从 `--c1` 到 `--c8` 读取，JS 在每次渲染前读取计算样式，因此换色后图表自动跟随
- 新增资产品类图标：在 `index.html` 图标精灵里加 `<symbol id="ic-cat-xxx">`，并在 `app.js` 的 `CATEGORY_RULES` 中登记关键词即可

## 测试

```bash
python qa/test_units.py          # 18 个核心逻辑单测（日期/金额/成本口径/报表辅助）
python qa/acceptance_test.py     # 149 个接口验收用例（自动使用临时数据库，不碰 asset_tracker.db）
python qa/test_packaging.py      # 18 个打包契约用例（Dockerfile / fpk 结构 / 镜像链路 / 版本一致性）
```

验收脚本覆盖：CRUD 与 9 类入参校验、结算/折旧/盈亏口径、待售状态机、预购转化、报表守恒、导入导出（含 GBK 与公式注入）、并发写、旧库迁移、1200 条性能、脏数据与误操作防护。结果写入 `qa/last_result.json`。

## 多目标打包与并行开发

三个产物共享同一套核心代码，只是打包适配层不同：

| 目标 | 打包入口 | 产物 | 依赖 |
|---|---|---|---|
| Windows 桌面 | `python build.py` | `dist/数码资产持有成本管理/` | PyInstaller + pystray/Pillow |
| Docker | `docker build -t assettracker:<版本> .` | 镜像 | Docker |
| 飞牛 fnOS | `python packaging/fnos/build.py` | `dist-fpk/assettracker_<版本>_x86.fpk` | 预构建镜像 + fnpack |

**协作规则**

1. **版本只改 `VERSION`**：exe 打进包、`/api/health` 返回、fpk 的 `manifest` 与 compose 都由它注入，不要各处手写。
2. **加模块必须同步 Dockerfile 的 COPY**：`COPY at ./at` 这类语句漏了，镜像会在 import 阶段挂掉 —— `qa/test_packaging.py` 会拦住。
3. **每个目标都有契约测试**：改完包装层跑 `python qa/test_packaging.py`；业务改动仍跑 `qa/acceptance_test.py`。
4. **打包脚本里不写业务逻辑**：`build.py` / `packaging/fnos/build.py` 只做组装、注入版本、校验，不复制代码。
5. **分支建议**：核心（`at/`、前端、`qa/`）走主干；`packaging/*` 与 `Dockerfile` 各自小步提交，互不阻塞。

## 常见问题

**Q：重新打包会损坏已录入的数据吗？**
不会。PyInstaller 带 `--noconfirm` 时会整个重建产物目录，`build.py` 会在构建前把 `dist/数码资产持有成本管理/asset_tracker.db` 复制到临时目录，构建完成后自动放回（构建失败也会放回）。日志里会打印 `[db] 已备份数据库：N 条记录` / `[db] 已恢复数据库`。

**Q：端口被占用 / 页面打不开？**
程序启动时会自动检测 5678 端口，发现旧进程占用会自动清理后重启。若手动访问无响应，检查是否有其他程序占用 5678 端口。

**Q：exe 模式下数据存在哪里？**
与 exe 同目录的 `asset_tracker.db`（即 `dist/数码资产持有成本管理/` 文件夹内）。迁移时把**整个文件夹**复制过去即可，只拷 exe 会缺少 `_internal` 依赖。

**Q：双击 exe 提示被系统阻止 / SAC 拦截？**
本项目已改用 onedir 文件夹模式规避；若仍被拦截，在文件属性里勾选「解除锁定」，或在 Windows 安全中心把该文件夹加入排除项。不要使用 onefile 版本。

**Q：托盘（状态栏）图标不见了？**
按顺序排查：
1. Windows 11 默认把新图标折叠进任务栏的「^」里，点开把图标拖到任务栏即可常驻；
2. 看 exe 同级的 `tray_error.log`——有内容说明托盘初始化失败，文件里是具体异常；
3. 最常见原因是打包时没装 `pystray` / `Pillow`（依赖没进包）。执行 `pip install -r requirements.txt` 后重新打包即可，`build.py` 现在会提前拦截这种情况。

**Q：如何彻底删除数据？**
删除 `asset_tracker.db` 文件（建议先 JSON 导出备份）。

## 安全说明

- 服务默认只监听本机 `127.0.0.1:5678`，不对外网开放（Docker 模式除外，见 DOCKER.md）。
- 所有数据仅存本地，无任何上传、遥测或联网行为。
