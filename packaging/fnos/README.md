# 飞牛 fnOS 打包方案（.fpk）

面向本项目的**完整实现文档**：怎么选型、包长什么样、装上去之后每一步发生什么、出问题查哪里。
按这个文档可以从零重新打出一个可安装的 `dist-fpk/assettracker_<VERSION>_x86.fpk`。

适用版本：fnOS 1.x / `fnpack 1.2.3`，应用 `assettracker`，架构 x86（amd64）。

---

## 0. 一页速览

```bash
# Windows：一次双击，产出约 46MB 的自包含安装包
packaging\fnos\make-fpk.bat

# 等价的手工流程
bash packaging/fnos/build-image.sh --save      # 构建镜像 + 容器冒烟 + 导出 .out/assettracker-image.tar
python packaging/fnos/build.py --with-image    # 把镜像打进 fpk
```

| 项 | 值 |
|---|---|
| 产物 | `dist-fpk/assettracker_<VERSION>_x86.fpk`（内置镜像，约 46MB） |
| 安装 | 应用中心 → 设置 → 手动安装应用 → 选该 fpk |
| 桌面入口 | `https://<appname>.<nas>.fnos.net/app/assettracker/`（统一网关，走 unix socket） |
| 局域网入口 | `http://<NAS IP>:<端口>`，默认 5678，可在应用设置改 |
| 数据 | `${TRIM_PKGVAR}/data/asset_tracker.db`（默认 `/vol1/@appdata/assettracker/data`） |
| 日志 | `${TRIM_PKGVAR}/main.log` |

---

## 1. 选型：为什么是这个形态

### 1.1 三种可选形态

| 形态 | 做法 | 结论 |
|---|---|---|
| 原生（跑宿主 Python） | 把 `.py` 放进 `app/`，靠 NAS 的 python3 | ✗ 依赖 NAS 的 Python 与 pip，版本不可控 |
| **Docker + docker-project** | `config/resource` 声明 compose 工程，交给 fnOS 托管 | ✗ 安装阶段就 `compose up`，镜像还没 load → `No such image`，安装中止 |
| **Docker + native 形态自管容器** | `resource = {}`，`cmd/main` 自己 `docker load` + `docker run` | ✓ 本方案 |

Docker 保留了两个好处：Python 环境固定在镜像里、升级只换镜像；native 形态则解决了"钩子晚于 compose up"的顺序问题。

### 1.2 最终架构

```
                 ┌───────────────────────────── 飞牛桌面 / FN Connect ─────────────────────────────┐
                 │  https://assettracker.<nas>.fnos.net/app/assettracker/                           │
                 │        │  fnOS 网关（校验登录态）                                              │
                 │        ▼                                                                        │
                 │  unix socket:  ${TRIM_APPDEST}/app.sock   ← 由容器写入（挂载 /gw）                │
                 └────────┼────────────────────────────────────────────────────────────────────────┘
                          │  原样中继（at/gateway.py）
                          ▼
             容器 assettracker（bridge）  127.0.0.1:5678
                  Flask + PrefixMiddleware（剥掉 /app/assettracker）
                          ▲
                          │ -p ${PORT}:5678        局域网 http://NAS:PORT
                 ┌────────┴────────┐
                 │  cmd/main start │  按需 docker load 内置 tar，再 docker run
                 └─────────────────┘
```

要点：**桌面入口不经过端口**，端口只服务局域网直连，两条链路互不影响。

---

## 2. 包结构

```
assettracker/
├── manifest                     # 应用身份（见附录 A）
├── ICON.PNG / ICON_256.PNG      # 64 / 256 图标（构建时从 asset.ico 生成）
├── app.tgz                      # 打包后由 app/ 压缩而成，含：
│   ├── docker/
│   │   ├── docker-compose.yaml  # 仅本地调试参考，fnOS 运行时不执行
│   │   └── assettracker-image.tar   # --with-image 时内置的镜像
│   ├── ui/
│   │   ├── config               # 桌面入口（见附录 B）
│   │   └── images/icon_{64,256}.png
├── cmd/                         # 生命周期脚本（fnpack 放在包顶层）
│   ├── main                     # ★ 真正的入口：load 镜像 + run 容器
│   ├── install_init / install_callback
│   ├── uninstall_init / uninstall_callback
│   ├── upgrade_init / upgrade_callback
│   └── config_init / config_callback
├── config/
│   ├── privilege                # run-as: root（要访问 docker socket）
│   └── resource                 # {}
└── wizard/
    ├── config                   # 应用设置里的可改项（端口）
    ├── install                  # 安装向导
    └── upgrade                  # 升级向导
```

### 2.1 `cmd/main` 的四个动作

| 动作 | 行为 | 退出码 |
|---|---|---|
| `start` | 已在运行→直接返回；否则 `docker rm -f` 残留 → 必要时 `docker load` 内置 tar → `docker run -d` → 轮询 `/api/health` 最多 20s | 0 成功 / 1 失败 |
| `stop` | `docker stop` + `docker rm -f` | 0 |
| `status` | `docker inspect -f '{{.State.Running}}'` | 0 运行 / 3 未运行 |

细节：
- 镜像加载用 tar 的「大小_修改时间」做标记（`${TRIM_PKGVAR}/image.marker`），避免 fnOS 频繁轮询 status 时重复 load。
- 加载后仍找不到 tag 时，从已有 `assettracker:*` 里补一个别名（防止打包时 tag 与版本不一致）。
- 失败时把 `docker logs --tail 40` 追加进 `main.log`，并写一行摘要到 `$TRIM_TEMP_LOGFILE`（应用中心可见）。

### 2.2 容器参数

```bash
docker run -d --name assettracker --restart unless-stopped \
  -p "5678:5678" \
  -e DATA_DIR=/data -e HEADLESS=1 -e PORT=5678 \
  -e GATEWAY_SOCKET=/gw/app.sock -e TZ=Asia/Shanghai \
  -v "${TRIM_PKGVAR}/data:/data" \
  -v "${TRIM_APPDEST}:/gw" \
  assettracker:${VERSION}
```

- **bridge + `-p 5678:5678`**：容器内固定 5678，发布到宿主机 5678。
  这个组合同时满足两个入口：图标走网关 socket，Docker 页的「远程访问」按钮需要有发布端口才会出现。
  host 网络虽然图标也正常，但没有发布端口，按钮不出现，所以不采用。
- `/gw` 挂载是网关 socket 的落地位置，`GATEWAY_SOCKET` 指向其中的 `app.sock`。

---

## 3. 运行机制（装完之后发生了什么）

```
① 安装：解包 → 校验 checksum → 写入 config/ → 执行 install_init / install_callback
         （本方案两个钩子都不碰镜像，镜像留给 start 处理）

② 启动：应用中心调用 cmd/main start
         ├─ docker load .out 里的 tar（首次）→ 标记 marker
         ├─ mkdir -p ${TRIM_PKGVAR}/data
         ├─ docker run（bridge + 发布 5678 + 两个挂载）
         └─ 轮询 http://127.0.0.1:${PORT}/api/health，20s 内 ready 才算成功

③ 访问：
   局域网  → http://NAS:${PORT}                        （容器端口映射）
   桌面/远程 → https://xxx.fnos.net/app/assettracker/   （网关 → app.sock → 容器 5678）

④ 停止：cmd/main stop → docker stop + rm（镜像保留，重启不再 load）

⑤ 升级：覆盖安装 → VERSION 变化 → 新包自带新 tag → 下次 start 发现镜像不存在 → load 新镜像
```

---

## 4. 六条硬约束（都是踩出来的）

### 4.1 不能用 `docker-project`

`config/resource` 一旦声明 docker-project，fnOS 会在**生命周期钩子之前**执行 `compose up`。
那时内置镜像还没 load，安装直接以 `Container assettracker Error ... No such image` 中止。
所以 `config/resource` 必须是 `{}`，容器生命周期完全由 `cmd/main` 接管。

### 4.2 桌面入口必须走统一网关（FN Connect 必须）

`ui/config` 的 `type` 只能是 `iframe` + `gatewaySocket`，**绝不能写 `protocol` / `port`**：

```json
{ "type": "iframe", "gatewaySocket": "app.sock",
  "gatewayPrefix": "/app/assettracker", "url": "/app/assettracker/" }
```

fnOS 拼桌面地址的规则是 `{protocol}://{当前浏览器 hostname}:{port}{url}`。
一旦声明 `http` + `5678`，在 HTTPS 域名下会变成 `http://xxx.fnos.net:5678` —— 协议降级且端口不可达，表现为 502。

应用侧配套三件事：
1. `at/gateway.py` 在 socket 上监听，把连接原样中继到容器内 5678（HTTP 是请求/响应流，搬字节即可）。
2. `PrefixMiddleware` 剥掉 `/app/assettracker` 并设置 `SCRIPT_NAME`，`url_for` / `request.script_root` 自动带前缀。
3. 前端 `<base href="{{ request.script_root }}/">` + 相对路径 + `util.js` 的 `BASE`（所有 `api()` 与导入请求都拼前缀）。

### 4.3 镜像 tag 必须等于 `VERSION`

`manifest.version`、compose 的 `image`、`cmd/main` 的 `IMAGE`、内置 tar 的 tag，四处同源。
`build.py` 会读 `docker save` 产物里的 `manifest.json` 核对；不一致只告警，但装上去就是"找不到镜像"。

### 4.4 `install_callback` 不承担 load

它可能在容器创建之后才执行（旧版 docker-project 形态正是如此）。镜像准备放在 `start` 里，时机才确定。

### 4.5 `.bat` 必须纯 ASCII + CRLF

cmd.exe 按系统 OEM 代码页逐行解析批处理。UTF-8 / 纯 LF 会让 `if (...)` 多行块失效，双击窗口一闪而过。
`qa/test_packaging.py::TestWindowsLaunchers` 会检查 ASCII、CRLF、无括号块、goto 标签存在。

### 4.6 端口分层，不要混用

| 层 | 端口 | 说明 |
|---|---|---|
| 容器内 | 固定 5678 | 镜像约定，不改 |
| 宿主机 | 5678 | 固定发布，`-p 5678:5678` |
| 网关 | 不经过端口 | 改端口不影响桌面图标 |

---

## 5. 构建

### 5.1 三条路

| 方式 | 命令 | 适用 |
|---|---|---|
| 一次双击（推荐） | `packaging\fnos\make-fpk.bat` | Windows + WSL Docker，出成品包 |
| 分步 | `build-image.bat` → `build-fpk.bat` | 想单独控制构建/打包 |
| 纯 Linux | `bash packaging/fnos/build-image.sh --save` → `python packaging/fnos/build.py --with-image` | CI、NAS 本机 |

`make-fpk.bat` 的行为：构建镜像 → 容器冒烟 → 导出 tar → 打进 fpk → 打印路径并打开 `dist-fpk`。
镜像构建失败会停在第一步，不会产出缺镜像的包。

### 5.2 构建镜像（`build-image.sh`）

1. 检查 Docker；守护进程没起来时依次尝试 `systemctl` / `service` / 后台 `dockerd`
2. 构建上下文在 `/mnt/*` 时先复制到 `/var/tmp`（9p 上构建慢 3~5 倍）
3. `docker build`，tag 取 `VERSION`，写 OCI 版本标签
4. **容器冒烟**：起临时容器 → 等 `HEALTHCHECK` 变 healthy → 容器内校验 `/api/health` 的版本号 →
   `POST /api/products` 写一条再读回 → 确认 sqlite 落在挂载目录 → 清理
5. `--save` 导出 `packaging/fnos/.out/assettracker-image.tar`

参数：`--save` / `--no-save` / `--no-smoke` / `--no-cache` / `--tag` / `--port`。

国内网络两个开关（不必改文件）：

```bat
set BASE_IMAGE=docker.m.daocloud.io/library/python:3.12-slim
set PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
packaging\fnos\make-fpk.bat
```

### 5.3 打 fpk（`build.py`）

1. 首次运行下载官方 `fnpack` 到 `packaging/fnos/bin/`（`FNPACK_BIN` 可覆盖）
2. 复制模板到 `.build/`，把 `VERSION` 注入 `manifest` / compose / `cmd/main` / `install_callback`
3. 从 `asset.ico` 生成 64/256 图标
4. `fnpack build`
5. **修正包内权限**：Windows 打包默认没有执行位，统一把 `cmd/*` 改为 755
6. 校验：结构齐全、版本一致、`checksum == md5(app.tgz)`、脚本可执行位、镜像 tag
7. 复制到 `dist-fpk/assettracker_<VERSION>_x86.fpk`

`--with-image` 不带值时自动在 `.out/` 找 `assettracker-image.tar`。

---

## 6. 安装、访问与数据

### 6.1 安装

应用中心 → 右上角设置 → 手动安装应用 → 选择 `.fpk`。
首次启动约 10~40 秒（`docker load` 46MB 镜像）。安装向导里可改局域网端口。

### 6.2 三条访问路径

| 场景 | 地址 | 备注 |
|---|---|---|
| 局域网 | `http://<NAS IP>:<端口>` | 默认 5678 |
| 容器内 | `http://127.0.0.1:5678` | bridge 下是容器自己的回环 |
| 桌面 / 远程 | `https://assettracker.<nas>.fnos.net/app/assettracker/` | 走网关 socket，不占端口 |
| Docker 页「远程访问」按钮 | `http://<NAS IP>:5678` | 需要有发布端口（bridge）；**首次点击要等十几秒**，冷启动/网关预热，不是故障 |

### 6.3 数据

- 路径：`${TRIM_PKGVAR}/data/asset_tracker.db`
- 迁移：把旧 `asset_tracker.db` 复制进去，重启应用
- 升级：数据目录不动；只有镜像与包被替换
- 卸载：容器删除，数据目录默认保留

---

## 7. 排错

按阶段查，先定位在哪一层。

### 7.1 构建期（WSL）

| 现象 | 处理 |
|---|---|
| `unable to prepare context: path "..." not found` | 日志混进了 `$(prepare_context)`，已修复（日志改走 stderr）；`TestContextPath` 守住 |
| 拉 `python:3.12-slim` 超时 | 设 `BASE_IMAGE` 指向镜像源 |
| pip 装 flask 慢/超时 | 设 `PIP_INDEX_URL` |
| `Cannot connect to the Docker daemon` | 手动 `sudo service docker start`，或看 `/tmp/dockerd.log` |
| 双击 bat 一闪而过 | 在 cmd 里 `cd /d ...` 后执行，错误会留在窗口；多为 bat 被存成 UTF-8/LF |

### 7.2 安装期

| 现象 | 原因 |
|---|---|
| `assettracker Pulling … Client.Timeout` | 装的是 20KB 空壳包，NAS 去 Docker Hub 拉取超时 |
| `No such image: assettracker:1.0.0` + 旧版本 | 曾是 docker-project 形态，安装阶段就 compose up |
| 安装完成后图标点不开（502） | `ui/config` 写了 `protocol`/`port`，远程域名下被拼成 `http://host:5678` |

### 7.3 启动期

```bash
grep '=== start ===' /vol1/@appdata/assettracker/main.log   # 看 apdest/pkgvar/端口
docker ps -a --filter name=assettracker
docker logs --tail 50 assettracker
```

`main.log` 里能看到：`docker load` 退出码、`docker run` 输出、`health ready=0/1`。

### 7.4 访问期

```bash
# 局域网链路
curl -s http://127.0.0.1:5678/api/health

# 网关链路
ls -l /vol1/@appcenter/assettracker/app/app.sock        # 应为 srw-rw-rw-
python3 - <<'EOF'
import socket
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect("/vol1/@appcenter/assettracker/app/app.sock")
s.sendall(b"GET /app/assettracker/api/health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
print(s.recv(4096).decode(errors="ignore"))
EOF
```

- 两个都 200 → 正常
- 端口 200、socket 连不上 → 镜像不含 `at/gateway.py`（没重建镜像）或 `/gw` 未挂载
- 两个都不通 → 容器没起来，回 7.3

---

## 8. 验证与测试

```bash
python qa/test_packaging.py     # 30 条打包契约
python qa/acceptance_test.py    # 156 条接口 + 7 条子路径
python qa/test_units.py         # 20 条核心逻辑
```

契约测试盯的是"跨文件的约定"，不是业务：

| 用例 | 防的事故 |
|---|---|
| `TestDockerTarget` | Dockerfile 漏 `COPY at`、镜像源不可覆盖 |
| `TestFpkTemplate.test_config_json` | `resource` 被写回 docker-project、`run-as` 不是 root |
| `test_main_owns_container_lifecycle` | `cmd/main` 退化成只做状态探测 |
| `test_desktop_entry_matches_manifest` | 入口 ID 不一致、写成 `type: url` + `port` |
| `test_network_mode` | 误改回 host 网络（按钮消失）或引入 `${wizard_port` |
| `TestWindowsLaunchers` | bat 被存成 UTF-8/LF、括号块、goto 悬空 |
| `TestContextPath` | 日志混进 `$(...)`（曾导致 docker 收到带颜色的"路径"） |
| `TestBuiltFpk` | 产物结构、checksum、执行位 |

手工验收清单（装机后）：

- [ ] 应用中心显示运行中，图标能打开
- [ ] `https://.../app/assettracker/api/health` 返回 `{"ok":true,"version":"<VERSION>"}`
- [ ] 局域网 `http://NAS:端口` 页面正常、图表渲染、能新增一条资产
- [ ] 改端口后重启，桌面图标仍能打开（验证端口无关）
- [ ] 卸载后数据目录仍在

---

## 9. 已知限制

| 项 | 现状 | 后续 |
|---|---|---|
| 架构 | 只出 x86（amd64）镜像 | ARM 机型需构建 arm64 并改 `platform = arm` |
| 分发 | 内置镜像约 46MB | 也可走私有 registry，改 compose 的 `ASSET_TRACKER_IMAGE` |
| 访问控制 | 无登录，靠 fnOS 账号 + 网关 | 局域网多人用建议加反代认证 |
| 端口 | 单端口 | 如需 HTTPS 直连，需自行加反代 |
| 应用商店 | `source = thirdparty` | 上架需开发者账号与签名 |

---

## 附录 A：`manifest` 字段

```ini
appname               = assettracker          # 必须与目录名、入口 key 前缀一致
version               = {{VERSION}}           # 构建时注入，必须 X.Y.Z
display_name          = 数码资产持有成本管理
desc                  = <p>…</p>              # 支持简单 HTML
platform              = x86
source                = thirdparty
maintainer            = 94486
maintainer_url        = …
distributor           = 94486
desktop_uidir         = ui
desktop_applaunchname = assettracker.Application   # 与 ui/config 的 key 一致
service_port          = 5678
checkport             = false                 # 端口由容器映射，不做预检
micro_app             = true                  # 桌面内嵌（iframe）
ctl_stop              = true                  # 应用中心可停止
checksum              = <md5(app.tgz)>        # fnpack 自动写入
```

## 附录 B：`ui/config`

```json
{
  ".url": {
    "assettracker.Application": {
      "title": "数码资产持有成本管理",
      "icon": "images/icon_{0}.png",
      "type": "iframe",
      "gatewayPrefix": "/app/assettracker",
      "gatewaySocket": "app.sock",
      "url": "/app/assettracker/",
      "allUsers": true
    }
  }
}
```

`{0}` 由系统替换为 64/256；`gatewaySocket` 相对 `${TRIM_APPDEST}`。

## 附录 C：`wizard/`（当前留空）

向导文件格式为数组（每个元素一个步骤），官方 `Motrix` 包里可见 `config` / `install` / `uninstall` / `upgrade` 四份。
**本包目前不放入口项**：端口尚未验证为「安装时可配」，加了只会让用户填一个不生效的值。
需要时按 Motrix 的结构加 `wizard/config`，字段名以 `wizard_` 开头，fnOS 会注入同名环境变量。

## 附录 D：环境变量

| 变量 | 来源 | 用途 |
|---|---|---|
| `TRIM_APPDEST` | fnOS | 应用安装目录，socket 落在这里 |
| `TRIM_PKGVAR` | fnOS | 应用数据目录（含 `main.log`、`image.marker`） |
| `TRIM_SERVICE_PORT` | fnOS | 端口兜底值 |
| `TRIM_SYS_ARCH` | fnOS | 架构（`x86` / `arm`），暂未用于选镜像 |
| `TRIM_TEMP_LOGFILE` | fnOS | 安装/启动失败摘要，应用中心可见 |
| `DATA_DIR` / `PORT` / `HEADLESS` | 容器内 | 应用自身配置 |
| `GATEWAY_SOCKET` | 容器内 | 统一网关 socket 路径 |

## 附录 E：与官方参考包对照

以 `Motrix-2.3.0-fnos-x64.fpk`（可正常安装/远程访问）为基准：

| 项 | Motrix | 本包 |
|---|---|---|
| 形态 | native（自带 Node 运行时） | Docker 自管容器 |
| `config/resource` | `data-share` + `api-scope` | `{}` |
| `config/privilege` | `run-as: root` | 同 |
| `ui/config` | `iframe` + `gatewaySocket` + `gatewayPrefix` | 同 |
| `manifest` | `micro_app = true`、`checkport = false`、`ctl_stop = true` | 同 |
| 生命周期 | `cmd/main` 起 Node 进程 | `cmd/main` load 镜像 + run 容器 |
| 镜像 | 无（原生） | 内置 tar，首次 start 时 load |
