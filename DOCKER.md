# Docker 运行方案

本项目除了打包成 exe，也可以作为 Web 服务跑在 Docker 里，适合部署到服务器 / NAS，多设备通过浏览器访问。

## 前置
- 已安装 Docker（或 Docker Desktop）
- 进入项目目录 `asset_tracker/`

## 方式一：docker compose（推荐）
```bash
cd asset_tracker
docker compose up -d --build
```
访问 http://服务器IP:5678

停止：`docker compose down`
数据保存在宿主机 `./data/asset_tracker.db`（已通过卷挂载持久化）。

## 方式二：docker 命令
```bash
cd asset_tracker
docker build -t asset-tracker .
docker run -d --name asset-tracker \
  -p 5678:5678 \
  -v "$PWD/data:/app/data" \
  asset-tracker
```
访问 http://服务器IP:5678

## 环境变量
| 变量 | 默认 | 说明 |
|---|---|---|
| `HEADLESS` | `1`（镜像内置） | 纯服务模式，不开浏览器、无托盘 |
| `DATA_DIR` | `/app/data` | 数据库目录，建议挂载卷 |
| `PORT` | `5678` | 容器内监听端口 |

改端口示例：`docker run -d -p 8090:5678 ...`，然后访问 http://服务器IP:8090。

## 与 exe 版的区别
- exe：单机桌面，自动开浏览器 + 系统托盘图标，数据库在 exe 同级目录。
- Docker：纯 Web 服务（`HEADLESS=1`），无浏览器/托盘，监听 `0.0.0.0`，可被局域网访问，数据库挂载卷持久化。

## 注意
- 服务默认无鉴权，请勿直接暴露公网；局域网使用或加反向代理 + 认证。
- 升级镜像不会丢数据（数据在挂载卷里）；删除 `data/` 目录才会清空。
