#!/usr/bin/env bash
# 在 WSL / Linux 上构建 assettracker 镜像：构建 → 冒烟测试 → 导出离线镜像
#
# 用法（在 WSL 里）：
#   bash packaging/fnos/build-image.sh                # 构建 + 冒烟
#   bash packaging/fnos/build-image.sh --save         # 另外导出 .out/assettracker-image.tar
#   bash packaging/fnos/build-image.sh --save --no-smoke
#
# Windows 双击 build-image.bat 即可调用本脚本（自动进 Debian）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$SCRIPT_DIR/.out"

VERSION="$(tr -d '\r\n ' < "$ROOT/VERSION")"
TAG="assettracker:$VERSION"
SAVE=0
SMOKE=1
NO_CACHE=0
PORT="${FNOS_SMOKE_PORT:-5799}"
SMOKE_NAME="assettracker-smoke-$$"
SMOKE_DATA=""

if [ -t 1 ]; then
    C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_END=$'\033[0m'
else
    C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_END=""
fi
# 日志一律走 stderr：stdout 只留数据（prepare_context 用 $(...) 取路径，
# 之前日志混进 stdout 会让 docker build 收到带 ANSI 颜色的多行"路径"）
step() { printf '\n%s==> %s%s\n' "$C_DIM" "$*" "$C_END" >&2; }
ok()   { printf '%s  ok%s %s\n' "$C_OK" "$C_END" "$*" >&2; }
warn() { printf '%s  !!%s %s\n' "$C_WARN" "$C_END" "$*" >&2; }
die()  { printf '%s  xx%s %s\n' "$C_ERR" "$C_END" "$*" >&2; exit 1; }

usage() {
    sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'
    cat <<'EOF'

可选参数：
  --save         构建成功后导出 .out/assettracker-image.tar（供 --with-image 使用）
  --no-save      只构建不导出（bat 默认会带 --save，用它覆盖）
  --no-smoke     跳过容器冒烟测试
  --no-cache     构建时不使用缓存
  --tag NAME     自定义镜像 tag（默认 assettracker:<VERSION>）
  --port N       冒烟测试映射到宿主机的端口（默认 5799）
  -h, --help     显示本帮助
EOF
}

cleanup() {
    if [ -n "$SMOKE_DATA" ]; then
        docker rm -f "$SMOKE_NAME" >/dev/null 2>&1 || true
        rm -rf "$SMOKE_DATA" 2>/dev/null || true
    fi
}
trap cleanup EXIT

while [ $# -gt 0 ]; do
    case "$1" in
        --save)     SAVE=1; shift ;;
        --no-save)  SAVE=0; shift ;;
        --no-smoke) SMOKE=0; shift ;;
        --no-cache) NO_CACHE=1; shift ;;
        --tag)      TAG="${2:?--tag 需要参数}"; shift 2 ;;
        --port)     PORT="${2:?--port 需要参数}"; shift 2 ;;
        -h|--help)  usage; exit 0 ;;
        *)          die "未知参数：$1（用 --help 查看用法）" ;;
    esac
done

need_docker() {
    command -v docker >/dev/null 2>&1 || die "未找到 docker。Debian 里先装：apt install -y docker.io"
    docker info >/dev/null 2>&1 && return 0

    step "Docker 守护进程未运行，尝试启动"
    if command -v systemctl >/dev/null 2>&1 && systemctl start docker >/dev/null 2>&1; then
        :
    elif command -v service >/dev/null 2>&1 && service docker start >/dev/null 2>&1; then
        :
    else
        # 无 systemd 的 WSL 常见情况：直接后台拉一个 dockerd
        nohup dockerd >/tmp/dockerd.log 2>&1 &
        warn "已后台启动 dockerd（日志 /tmp/dockerd.log）"
    fi

    for _ in $(seq 1 30); do
        docker info >/dev/null 2>&1 && { ok "Docker 已就绪"; return 0; }
        sleep 1
    done
    die "Docker 启动失败。手动执行：sudo service docker start，或查看 /tmp/dockerd.log"
}

# /mnt/d 这类 9p 路径构建慢且偶发权限问题，先复制到 WSL 本地盘。
# 只往 stdout 写最终路径，日志一律走 stderr —— 否则 $(...) 会把日志当成路径，
# docker 会报 `unable to prepare context: path "..." not found`。
# AT_FORCE_LOCAL_CONTEXT=1 可强制走复制分支（在非 /mnt 环境下复现/测试用）。
prepare_context() {
    local copy=0
    case "$ROOT" in
        /mnt/*) copy=1 ;;
        *) [ "${AT_FORCE_LOCAL_CONTEXT:-0}" = "1" ] && copy=1 ;;
    esac

    if [ "$copy" != 1 ]; then
        printf '%s\n' "$ROOT"
        return 0
    fi

    local ctx="/var/tmp/assettracker-ctx"
    step "复制构建上下文到 WSL 本地盘（避开 /mnt 的 9p 性能损耗）"
    rm -rf "$ctx"; mkdir -p "$ctx"
    tar -C "$ROOT" -cf - \
        --exclude=./dist --exclude=./dist-fpk --exclude=./build \
        --exclude=./.git --exclude=./__pycache__ --exclude='*.pyc' \
        --exclude=./data --exclude='*.db' --exclude='*.fpk' \
        --exclude=./packaging/fnos/.build --exclude=./packaging/fnos/.out \
        . | tar -C "$ctx" -xf -
    ok "上下文：$ctx（$(du -sh "$ctx" | cut -f1)）"
    printf '%s\n' "$ctx"
}

build() {
    local ctx="$1"
    step "构建镜像 $TAG"
    local args=(build -t "$TAG"
        --label "org.opencontainers.image.title=数码资产持有成本管理"
        --label "org.opencontainers.image.version=$VERSION")
    [ "$NO_CACHE" = 1 ] && args+=(--no-cache)
    # 国内网络：用环境变量覆盖基础镜像与 PyPI 源，不必改 Dockerfile
    [ -n "${BASE_IMAGE:-}" ] && args+=(--build-arg "BASE_IMAGE=$BASE_IMAGE")
    [ -n "${PIP_INDEX_URL:-}" ] && args+=(--build-arg "PIP_INDEX_URL=$PIP_INDEX_URL")
    docker "${args[@]}" "$ctx"

    local arch
    arch="$(docker image inspect -f '{{.Architecture}}' "$TAG")"
    local size
    size="$(docker image inspect -f '{{.Size}}' "$TAG")"
    ok "镜像就绪：$TAG（$arch，$(awk -v b="$size" 'BEGIN{printf "%.1f MB", b/1048576}')）"
    [ "$arch" = "amd64" ] || warn "镜像架构是 $arch；飞牛 x86 版本需要 amd64，安装后可能起不来"
}

smoke() {
    step "容器冒烟测试（端口 127.0.0.1:$PORT）"
    SMOKE_DATA="$(mktemp -d)"
    docker rm -f "$SMOKE_NAME" >/dev/null 2>&1 || true
    docker run -d --name "$SMOKE_NAME" \
        -p "127.0.0.1:$PORT:5678" \
        -e DATA_DIR=/data -e HEADLESS=1 -e TZ=Asia/Shanghai \
        -v "$SMOKE_DATA:/data" \
        "$TAG" >/dev/null

    local status=""
    for _ in $(seq 1 60); do
        status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$SMOKE_NAME" 2>/dev/null || echo missing)"
        [ "$status" = "healthy" ] && break
        [ "$status" = "unhealthy" ] && break
        sleep 1
    done
    if [ "$status" != "healthy" ]; then
        docker logs --tail 30 "$SMOKE_NAME" 2>&1 | sed 's/^/      /' || true
        die "健康检查未通过（状态：$status）。容器日志见上"
    fi
    ok "HEALTHCHECK 通过"

    # 在容器内跑一遍真实读写：验证版本注入、SQLite 落盘、接口可用
    docker exec -i "$SMOKE_NAME" python - "$VERSION" <<'PY'
import json, sys, urllib.request

base = "http://127.0.0.1:5678"
expect = sys.argv[1]

def req(path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(base + path, data=data,
                               headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(r, timeout=10).read())

health = req("/api/health")
assert health.get("ok"), f"/api/health 异常：{health}"
assert health.get("version") == expect, f"镜像内版本 {health.get('version')} != VERSION {expect}"

pid = req("/api/products", {"name": "镜像冒烟", "price": 100,
                            "purchase_date": "2026-10-01"})["id"]
items = req("/api/products")["data"]
assert any(x["id"] == pid for x in items), "写入后读不到记录"

summary = req("/api/report/summary")
print(f"      health={health}  记录数={len(items)}  汇总键={sorted(summary)[:4]}")
PY
    ok "接口读写与版本号校验通过"

    [ -f "$SMOKE_DATA/asset_tracker.db" ] || die "数据库没有落到挂载目录（持久化会失效）"
    ok "数据持久化到挂载目录：$(du -h "$SMOKE_DATA/asset_tracker.db" | cut -f1)"

    docker rm -f "$SMOKE_NAME" >/dev/null 2>&1 || true
    SMOKE_DATA_KEEP="$SMOKE_DATA"
    SMOKE_DATA=""
    rm -rf "$SMOKE_DATA_KEEP" 2>/dev/null || true
}

save_image() {
    step "导出离线镜像"
    mkdir -p "$OUT_DIR"
    local tar="$OUT_DIR/assettracker-image.tar"
    rm -f "$tar"
    docker save -o "$tar" "$TAG"
    ok "$tar（$(du -h "$tar" | cut -f1)）"
}

main() {
    printf '%s\n' "项目：$ROOT"
    printf '%s\n' "版本：$VERSION   镜像：$TAG"
    need_docker
    local ctx
    ctx="$(prepare_context)"
    build "$ctx"
    [ "$SMOKE" = 1 ] && smoke
    [ "$SAVE" = 1 ] && save_image

    printf '\n%s构建完成%s\n' "$C_OK" "$C_END"
    if [ "$SAVE" = 1 ]; then
        printf '  下一步：python packaging/fnos/build.py --with-image\n'
        printf '          或在 Windows 上双击 build-fpk.bat\n'
    else
        printf '  想生成离线安装包，重跑并加 --save，或直接双击 build-fpk.bat\n'
    fi
}

main
