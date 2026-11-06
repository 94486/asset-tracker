# 变更记录

## 2026-11-06 · v1.1.0：XSS 修复 / 焦点陷阱 / 数码蓝配色改版

- **前端修复 13 项**：趣味排行分类名 XSS（esc 后进 innerHTML）、失败重试面板恢复可见、
  筛选标签走 `renderTableFromFirstPage` 并持久化、KPI 图标对齐精灵图、hash 深链串味、
  挂售预览除零、for_sale 售出预览、fmt 小数、焦点陷阱（6 个弹窗 Tab 循环）、主题切换冗余调用等。
- **配色改版（unslop）**：强调色黄铜 → 科技蓝（暗色 `#5b8cff`、浅色 `#2f5fd6`，与 favicon/托盘同源）；
  深色表面换 Ink 冷蓝调；图表色板蓝主系列 + 冷色台阶；琥珀色全文件清零。语义色（绿=在持/金=已售/红=亏损）保留。
- **fpk 版本管理**：版本号升 1.1.0（VERSION 唯一来源），镜像 tag / manifest / compose / health 四处同源注入；
  `dist-fpk/old/` 归档旧版本包，主目录只留当前版 `assettracker_1.1.0_x86.fpk`。
- 验证：验收 156 + 单测 20 全绿；镜像容器冒烟通过（health v1.1.0、读写、落盘）；产物内抽查新配色与新 JS 均已烧入。
- 构建备注：WSL 容器直连 pypi.org 不通，需 `PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple`。

## 2026-11-05 · 综合优化：对比度 / 密度 / KPI 联动 / 快捷键帮助

- **对比度达 WCAG AA**：暗色 `--text-3` #6f6a64→#85806f（3.44→4.66）；
  浅色 `--text-3` #8391ab→#66748e（3.18→4.72）、`--green`→#0a7d5a、`--red`→#c93a3a、`--gold`→#96660f。
- **字重统一**：残留的 650/700 全部归到 600；`.detail-label`/`.cp-label` 字距残留清零。
- **行密度切换**：顶栏新增按钮（或按 `D`），紧凑模式压低行高/图标/徽标，`localStorage` 持久化，头部脚本尽早应用避免闪动。
- **KPI 卡联动**：统计卡可点击——持有总额→筛选"使用中"、累计投入→清空状态、已结算盈亏→筛选"已售出"、每日成本→直达报表；支持键盘 Enter/空格。
- **快捷键帮助**：按 `?` 呼出快捷键速查面板（Esc 或再按 `?` 关闭）；`D` 密度键入册。
- **动效降级**：新增 `prefers-reduced-motion` 全局关闭动画/过渡。
- 文案审计：空态/toast 文案早前已口语化，本轮无需再改。
- 测试全绿：验收 156 + 单元 20 + 打包契约 29。
- 已知环境项：WSL 里旧的 5792 演示服务缓存旧模板，与本仓库无关；本机预览改用 5793。

## 2026-11-05 · 界面去 AI 味（unslop 风格改造）

- 参照 unslop 设计原则重做视觉层：**一个强调色（黄铜 #c19a5b / 浅色主题 #8a6420）**，
  只用于主操作、选中态与关键数字；删除紫蓝渐变、氛围光晕、backdrop-filter、彩色阴影。
- 字重 650/680 降为 500，去掉全部 `letter-spacing` 与 `text-transform: uppercase`。
- 图表配色收敛为一个强调色 + 中性台阶（--c1..--c8），柱状图渐变填充改实色；
  折线面积淡出（单色）按数据可视化惯例保留。
- 趣味榜单等 9 处 emoji 替换为内联 SVG 线性图标（money/hourglass/trend-down/star/flag/calendar 等）。
- 已在浏览器实测暗色/浅色两主题：列表、报表、趣味排行、图表渲染全部正常。
- 测试全绿：验收 156 + 单元 20 + 打包契约 29。

## 2026-11-05 · 定版：bridge + 发布 5678

- 实测结论：`-p "5678:5678"`（bridge）时，桌面图标（网关 socket）与 Docker 页的「远程访问」按钮**同时出现**，
  host 网络下两者只有图标、没有按钮。上一版图标失效的元凶是 `wizard_port`，不是 bridge。
- `cmd/main` 定稿：`-p "5678:5678"` + `-e PORT=5678`，端口不再从向导取。
- 产物：主包 `assettracker_1.0.0_x86.fpk`（bridge）；备选 `assettracker_1.0.0_x86_host.fpk`（无按钮，图标可用）。
- 契约测试改为锁 bridge：出现 `--network host`、或引入 `${wizard_port` 都判失败。

## 2026-11-05 · 回退 bridge/向导端口（导致图标打不开）

- 现象：能用的那版（host 网络）正常；改成 bridge + `-p` 并加 `wizard_port` 向导项后，
  图标点了没反应，只有 docker/端口能访问。
- 回退：`cmd/main` 恢复 `--network host` + `-e PORT="$PORT"`，端口只取 `TRIM_SERVICE_PORT`（缺省 5678）；
  删除 `wizard/config|install|upgrade`（不再提供端口设置）；移除启动后的 socket `chmod`（已知可用版本没有它）。
- 结论：**host 网络 + 统一网关 socket 是本项目唯一验证通过的组合**，不要再引入端口映射或向导端口。
  `qa/test_packaging.py::test_network_mode` 会拦住"host 网络却又带 `-p`"的写法。

## 2026-11-05 · 网络模式与可配置端口

- 容器从 `--network host` 改回 **bridge + `-p "$PORT:5678"`**：容器内固定 5678，宿主机端口可配，内外解耦。
  接入统一网关后不再需要 host 网络来"对齐端口"。
- 新增安装向导/应用设置项 `wizard_port`（默认 5678），`cmd/main` 的端口优先级为
  `wizard_port` > `TRIM_SERVICE_PORT` > 5678。改完重启应用生效。
- 桌面图标走网关 socket，**与端口无关**——改端口不影响入口。
- 契约测试 28 → 30：向导字段存在且带校验规则、`cmd/main` 必须使用 `wizard_port` 且映射形如 `${PORT}:5678`。

## 2026-11-05 · 接入 fnOS 统一网关（FN Connect 远程访问）

- 参照官方可用包 `Motrix-2.3.0-fnos-x64.fpk` 确认：第三方应用桌面入口走 **unix socket 统一网关**，
  `ui/config` 必须 `type: iframe` + `gatewaySocket: "app.sock"` + `gatewayPrefix`；`manifest` 带 `micro_app = true`。
  之前用 `type: url` + `port`，在 FN Connect（HTTPS 域名）下必然 502。
- 应用侧：
  - 新增 `at/gateway.py`：在 `${TRIM_APPDEST}/app.sock` 上监听，把连接原样中继到本机 `PORT`（双向管道，chmod 666）。
  - 新增 `PrefixMiddleware`：命中 `/app/assettracker` 前缀时剥掉并设置 `SCRIPT_NAME`，`url_for` / `request.script_root` 自动带前缀；也可用 `BASE_PATH` 指定。
  - 模板加 `<base href="{{ request.script_root }}/">`，静态资源改相对路径；`util.js` 增加 `BASE`，`api()` 与导入用的 `fetch` 都拼前缀。
  - `GATEWAY_SOCKET` 未设置或平台不支持 `AF_UNIX` 时只告警，不影响普通端口启动。
- `cmd/main`：容器加 `-v "${TRIM_APPDEST}:/gw"`、`-e GATEWAY_SOCKET=/gw/app.sock`，socket 落在宿主机应用目录。
- 验证：`test_client` 覆盖 `/app/assettracker/`、`/api/health`、`/static/js/util.js`（156 用例）；
  中继逻辑用 TCP 回环实测转发成功；Windows 无 `AF_UNIX` 时服务仍正常启动并告警。
- ⚠️ 应用代码有改动，**必须重新构建镜像**（`make-fpk.bat`）后再安装。

## 2026-11-05 · 桌面入口 502（域名访问）

- 现象：容器跑起来了、`docker` 里能访问，但点桌面图标是 `HTTP ERROR 502`（`assettracker.evo2-john.fnos.net`）。
- **根因在 `ui/config`**：fnOS 拼桌面地址的规则是 `{protocol}://{当前浏览器 hostname}:{port}{url}`。
  原配置写了 `"protocol": "http"` + `"port": "{port}"`，在 HTTPS 域名下就变成 `http://…fnos.net:5678`，协议降级且端口不可达 → 502。
  官方说明：走域名/HTTPS 时**不要声明 protocol 与 port**，交给 fnOS Nginx 反代。
- 改为 `type: url` + 仅 `url: "/"` + `allUsers: true`，不再声明 protocol / port。
- 只改了 `ui/config`（属于 `app.tgz`），**镜像不需要重建**，本地重打 fpk 即可。
- 契约测试补两条断言：入口不得含 `protocol`、不得含 `port`，防止回归。

## 2026-11-05 · 桌面入口 502（网关连不上上游）

- 现象：应用装好、桌面图标能点，但打开是 `HTTP ERROR 502`（`assettracker.evo2-john.fnos.net`）。
- 处理：`cmd/main` 的 `docker run` 改为 **`--network host`** 并让应用监听 `$PORT`，去掉 `-p "$PORT:5678"`
  —— 端口映射在 `TRIM_SERVICE_PORT` 与 manifest `service_port` 不一致时会让网关连到无人监听的端口，表现就是 502。
- 启动增加**健康探测**：轮询 `http://127.0.0.1:$PORT/api/health`（最多 20 秒），只有真的应答才算启动成功，
  避免"容器在跑但进程已崩"被当成正常。
- 失败时把 `docker logs --tail 40` 追加到 `main.log`，并记录 `TRIM_*` 环境变量，便于定位。
- 实测（假 docker + 真实 HTTP 探针）：`--network host`、`PORT=5799`、`health ready=1`、`started ok`、`status exit 0`。

## 2026-11-05 · 安装时报 No such image（改用 native 形态自管容器）

- **根因**：`config/resource` 里声明了 `docker-project`，fnOS 会在安装阶段**先** `compose up`、**后**跑生命周期钩子。
  内置镜像还没来得及 `docker load`，于是 `Container assettracker Error ... No such image: assettracker:1.0.0`，安装中止。
- 改为「native 形态 + 自管容器」：
  - `config/resource` → `{}`（不再声明 docker-project）
  - `config/privilege` → `run-as: root`（需要 docker socket）
  - `cmd/main` 接管完整生命周期：start = 按需 `docker load` 内置 tar + `docker run`；stop = `docker stop/rm`；status = `docker inspect`，未运行返回 3
  - 加载用 tar 的「大小_修改时间」做标记，避免 fnOS 频繁轮询 status 导致重复 load
  - 数据目录改为 `${TRIM_PKGVAR}/data`（默认 `/vol1/@appdata/assettracker/data`）
- `manifest` 增加 `checkport = false`：端口由容器映射，fnOS 的端口预检不适用。
- `app/docker/docker-compose.yaml` 保留但仅作本地调试参考，运行时不执行。
- 实测：用假 docker 跑通 `cmd/main` 的 start（load+run）、status 运行 0 / 停止 3、stop、缺镜像报错四条分支；
  包内 `cmd/main` 的版本号已正确注入，`resource` 为 `{}`、`run-as` 为 `root`。
- 契约测试 27 → 28 用例：`resource` 必须为空、`run-as` 必须 root、`cmd/main` 必须自己 load+run、manifest 必须 `checkport=false`。

## 2026-11-05 · 空壳包装不上（Pulling timeout）

- 现象：装 20KB 的「壳」包时，fnOS 按 compose 的 `image` 去 Docker Hub 拉 `assettracker:1.0.0`，
  超时后**整个安装中止**（`assettracker Pulling … Client.Timeout`）。空壳包在不能访问 Docker Hub 的 NAS 上等于不可用。
- `docker-compose.yaml` 增加 `pull_policy: never`：镜像随包提供时不再尝试联网拉取，安装只走 `docker load`。
- `cmd/install_callback` 在缺镜像时把**原因和处理办法**写进安装日志（原来只写一句"未找到镜像"，用户实际看到的是启动时的 registry 报错，很难对上）。
- 契约测试补 `pull_policy: never` 断言。
- 结论：分发给别人的包必须用 `make-fpk.bat` 打成自包含版本。

## 2026-11-05 · 修复镜像构建失败（context 路径被日志污染）

- **根因**：`prepare_context` 用 `ctx="$(prepare_context)"` 取返回值，但 `step`/`ok` 把日志写到了 stdout，路径变成
  `"\n\x1b[2m==> 复制构建上下文…/var/tmp/assettracker-ctx"`，docker 报 `unable to prepare context: path ... not found`。
- 修复：所有日志函数（`step`/`ok`/`warn`/`die`）改为写 **stderr**，stdout 只留数据；`prepare_context` 重构为 `copy` 标志分支，更易读。
- 新增 `AT_FORCE_LOCAL_CONTEXT=1`：在非 `/mnt` 环境下强制走"复制到本地盘"分支，便于复现与测试。
- **国内网络**：`Dockerfile` 增加 `ARG BASE_IMAGE` 与 `ARG PIP_INDEX_URL`；`build-image.sh` 支持用同名环境变量透传 `--build-arg`，
  拉不动 `python:3.12-slim` 或 PyPI 超时时不必改文件。
- 测试：`qa/test_packaging.py` 24 → 26 用例（日志必须走 stderr；上下文路径必须干净；Dockerfile 必须允许覆盖镜像源）。

## 2026-11-05 · 一键出成品包（make-fpk.bat）

- 新增 `packaging/fnos/make-fpk.bat`：一次双击完成「构建镜像 → 容器冒烟 → 导出 tar → 打进 fpk」，产出**自包含**的 `.fpk`（约 60MB），装到飞牛上无需再 build 镜像、无需联网。
- 镜像构建失败会停在第一步并给出排查命令，不会再产出「缺镜像的包」——那种包装上去只会在应用中心提示找不到镜像，等于白装。
- 分步脚本保留：`build-image.bat`（只构建/导出）、`build-fpk.bat`（只打包，自动判断有没有离线镜像）。
- `build-image.sh` 新增 `--no-save`，用于覆盖 bat 默认附加的 `--save`。
- `qa/test_packaging.py` 23 → 24 用例：校验一键脚本必须 `build-image.sh --save` → `build.py --with-image`，且构建失败不能继续打包。
- 实测：用假镜像端到端跑通「一键 → 带镜像 fpk → 打印路径」，随后清理假镜像并重打正式包。

## 2026-11-05 · 修复 .bat 无法运行

- **根因**：两个 fnos 批处理被写成 **UTF-8 + 纯 LF**。cmd.exe 按系统 OEM 代码页（中文 936）逐行解析批处理，LF 换行会让 `if (...)` 多行块直接失效，双击窗口一闪而过。根目录 `build.bat` 之所以正常，是因为它是 UTF-8 + **CRLF** 且 `chcp 65001` 在开头。
- 重写 `build-image.bat` / `build-fpk.bat`：**纯 ASCII + CRLF**，去掉所有括号块改用 `goto` 标签，中文提示交给 `build-image.sh` / `build.py` 输出（批处理里 `chcp 65001`）。
- `build-fpk.bat` 现在会检测 `.out/` 有没有离线镜像：没有就只打 20KB 的壳并提示，不会再直接报错退出。
- 新增 `.gitattributes`：`*.bat` 强制 CRLF、`*.sh` 强制 LF，避免并行开发 / CI 检出时把换行符改坏。
- `qa/test_packaging.py` 18 → 23 用例：bat 必须 CRLF、fnos bat 必须纯 ASCII、禁止括号块、`goto` 目标必须存在、必须调用 `build-image.sh`。
- 实测：`build-image.bat` 用「去掉 wsl 调用」的副本在 cmd 下跑通解析与成功分支；`build-fpk.bat` 真实调用 Python 打出 20 KB 包。

## 2026-11-05 · 端口占用与数据保护

- **`build.py` 自带数据库备份/恢复**：PyInstaller `--noconfirm` 会整个删掉 `dist/数码资产持有成本管理/`，里面的 `asset_tracker.db` 会被一并删除。以前只有 `build.bat` 做了备份，命令行直接跑 `build.py` 就会丢数据（本轮实测确认，已恢复 9 条记录）。现在脚本内部备份、构建成功或失败都自动放回。
- **端口清理能认出自己**：`_allowed_names()` 只匹配 `python.exe`，源码运行时认不出上一次双击启动的 `数码资产持有成本管理.exe`，旧实例会一直占着 5678，新实例只抛一个 `OSError`。现在把发行 exe 名纳入白名单（仍不碰其它进程）。
- **端口清不掉时明确报错**：HEADLESS 模式打印中文原因并 `exit 1`；桌面模式弹系统对话框（windowed exe 没有控制台，否则用户只看到「双击没反应」）。
- **镜像冒烟脚本实测通过**：`build-image.sh` 里那段内联 Python 在真实服务上跑通（health/版本/写入/汇总），并用假 docker 跑通 shell 全流程（构建 → 健康等待 → 导出 → 提示）。
- 新增 2 个单测（`TestPortGuard`）：白名单必须包含本程序 exe、必须不含 `svchost/chrome` 等。

## 2026-11-05 · 镜像构建链路（WSL Docker → 离线 fpk）

- 新增 `packaging/fnos/build-image.sh`：构建镜像的同时做**容器冒烟**——等 `HEALTHCHECK` 变 healthy、在容器内校验 `/api/health` 的版本号、写一条资产再读回、确认数据库落在挂载目录；`--save` 导出 `.out/assettracker-image.tar`。
- 脚本自愈几个常见环境问题：dockerd 没启动时依次尝试 `systemctl` / `service` / 后台 `dockerd`；构建上下文在 `/mnt/*` 时先复制到 `/var/tmp`（9p 上构建慢 3~5 倍）；镜像架构非 amd64 时告警。
- 新增 `packaging/fnos/build-image.bat` 与 `build-fpk.bat`：Windows 双击即可（内部走 WSL，可用 `FNOS_WSL_DISTRO` 换发行版）。
- `build.py --with-image` 可省略路径，自动在 `.out/` 里找镜像；并读取 `docker save` 产物里的 `manifest.json` 核对 tag 与 `VERSION` 是否一致（不一致只告警，但装到 NAS 上会找不到镜像）。
- `cmd/install_callback`：`docker load` 失败时用 `gunzip | docker load` 兜底；load 完 tag 不匹配则从已有 `assettracker:*` 补别名，避免「装上了但起不来」。
- `qa/test_packaging.py` 12 → 18 用例：新增镜像链路契约（产物路径三处一致、冒烟必须等 HEALTHCHECK、bat 包装、shell 语法）。
- 文档：`packaging/fnos/README.md` 补 WSL 构建流程与排错表，`docs/DEVELOPMENT.md` 补「本机一条龙」与带镜像的 CI 示例。

## 2026-11-05 · 飞牛 fnOS 打包（.fpk）

- 新增 `packaging/fnos/`：Docker 模式的 fpk 工程（manifest / cmd 生命周期 / config / ui / compose）与打包脚本。
- `build.py` 自动下载官方 `fnpack 1.2.3`、注入版本号、从 `asset.ico` 生成 64/256 图标、调用 fnpack、**修正 Windows 下缺失的执行位**、校验结构与 `checksum == md5(app.tgz)`。
- 新增 `VERSION` 作为版本唯一来源：exe 打包、`/api/health`、fpk 的 manifest 与 compose 都读它。
- **修复 Dockerfile**：重构后漏了 `COPY at ./at` 与 `VERSION`，镜像构建会在 import 阶段失败；同时补了 healthcheck。
- 新增 `qa/test_packaging.py`（12 用例）：Dockerfile 拷贝清单、manifest / ui / compose 三处名称一致、脚本 shebang 与语法、包内 checksum 与执行位。
- README / 开发指南补充「多目标打包与并行开发」约定与 CI 矩阵示例。

## 2026-11-05 · 健壮性专项

### 修复

- **覆盖导入会误删数据**：导入文件里一行有效数据都没有时，旧逻辑会先 `DELETE` 再插入 0 条，等于清空资产库。现在先校验完整份文件、确认有可写入的行才允许清空；否则返回 400 并保留原数据。
- **出售不填价格被当成全额损失**：`status=sold` 且售价为空时，旧逻辑落到「损坏」分支，凭空产生一笔 `-购入价` 的亏损。现在接口强制填写售价；历史/导入数据里缺售价的记录，盈亏与折旧留空（不再计入已结算金额）。
- **预购列表被脏日期打挂**：`expected_date` 被外部写成非 ISO 格式时，`/api/wishlist` 直接 500。现在统一走容错解析，解析不了就置空。
- **撤销删除接受未来购买日期**：`restore` 只校验格式不校验上限，恢复出一条 `2099-01-01` 的记录会让日均成本失真。现在与新增接口同口径，并校验「购买 ≤ 上架/处理」。
- **端口清理会误杀他人进程**：启动时发现 5678 被占用就 `taskkill`，不管对方是谁。现在只结束本程序或 `python/pythonw` 进程，其它进程打印警告后跳过。

### 增强

- **覆盖导入前自动备份**：用 SQLite `backup()` 生成 `asset_tracker.db.backup`（滚动一份，WAL 下也能拿到一致快照）；备份失败则取消导入。
- **API 统一 JSON 错误**：404 / 405 / 413 / 500 在 `/api/*` 下不再返回 HTML 错误页。
- **响应 gzip**：≥1KB 的 JSON/HTML/CSS/CSV 按 `Accept-Encoding` 压缩，1200 条列表从 793KB 降到约 90KB。
- **健康检查** `/api/health`：返回 `{ok, db, version}`，可用于 Docker healthcheck / 外部探活。
- **上传上限 64MB**：超限返回 413 与中文提示，避免超大文件吃满内存。
- **日期解析容错**：兼容 `2026-01-02`、`2026/1/2`、`2026.1.2`、`2026年1月2日` 与带时间写法（Excel 导出的 CSV 常见斜杠格式）。
- **数值字段归一化**：`price / sale_price / list_price` 在 `compute_cost` 里统一成 float 回写，报表直接求和不会再被 TEXT 脏值打断。

### 变更

- 出售接口现在**要求填写售价**（此前服务端允许留空，与前端必填校验不一致）。
- 测试规模：验收用例 136 → **149**，单测 17 → **18**。

---

## 2026-11-05 · 打包与架构

- 打包从 `--onefile` 改为 **`--onedir`**：不再自解压到 `%TEMP%`，规避 Windows 智能应用控制（SAC）与杀软误判；`build.py` 仍支持 `--onefile` 回退，并新增 `--noupx`。
- `build.py` 增加依赖自检：缺 `flask / pystray / PIL / six` 直接报错，避免打出「没有托盘图标」的 exe。
- 托盘初始化失败时写 `tray_error.log`（数据库同级），不再静默降级。
- 后端从 1748 行单文件拆为 **入口 + `at/` 包**：`config / db / validators / costing / reporting / http / ports / desktop` + `api/` 四个蓝图（products / wishlist / reports / data_io）。
- 前端通用工具抽到 `static/js/util.js`，静态资源版本号覆盖两个脚本。
- 新增 `qa/acceptance_test.py`（接口验收）、`qa/test_units.py`（核心逻辑单测）、`qa/验收报告.md`。
- 修复验收发现的 5 个缺陷（restore 校验、类型收敛、sell 状态收窄、JSON body、导入未来日期）。

---

## 更早

- 资产 CRUD、每日持有成本、出售/损坏结算、报表与图表、导入导出、双主题与响应式表格。
- 待售清单（`products.status=for_sale`）与预购清单（独立 `wishlist` 表）两套模型。
- WAL 日志模式探针（网络盘自动回退 rollback journal）、`busy_timeout`、并发写保护。
