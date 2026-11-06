# -*- coding: utf-8 -*-
"""把 asset_tracker 打成飞牛 fnOS 的 .fpk（Docker 模式）

用法：
    python packaging/fnos/build.py                 # 联网自动下载 fnpack（首次）
    python packaging/fnos/build.py --with-image image.tar
    FNPACK_BIN=/path/to/fnpack python packaging/fnos/build.py

产物：dist-fpk/assettracker_<version>_x86.fpk
"""
import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "assettracker"
STAGE = HERE / ".build" / "assettracker"
BIN_DIR = HERE / "bin"
IMAGE_DIR = HERE / ".out"
OUT_DIR = ROOT / "dist-fpk"
FNPACK_VERSION = "1.2.3"
FNPACK_URLS = {
    ("Windows", "AMD64"): f"https://static2.fnnas.com/fnpack/fnpack-{FNPACK_VERSION}-windows-amd64",
    ("Linux", "x86_64"): f"https://static2.fnnas.com/fnpack/fnpack-{FNPACK_VERSION}-linux-amd64",
    ("Darwin", "x86_64"): f"https://static2.fnnas.com/fnpack/fnpack-{FNPACK_VERSION}-darwin-amd64",
    ("Darwin", "arm64"): f"https://static2.fnnas.com/fnpack/fnpack-{FNPACK_VERSION}-darwin-arm64",
}


def read_version():
    v = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", v):
        raise SystemExit(f"VERSION 格式不合法：{v!r}（飞牛要求 X.Y.Z）")
    return v


def render_files(version):
    for p in STAGE.rglob("*"):
        if not p.is_file() or p.suffix.lower() in (".png", ".ico", ".tar"):
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if "{{VERSION}}" in text:
            p.write_text(text.replace("{{VERSION}}", version), encoding="utf-8", newline="\n")


def make_icons():
    from PIL import Image

    src = ROOT / "asset.ico"
    if not src.exists():
        raise SystemExit("找不到 asset.ico，无法生成应用图标")
    image = Image.open(src)
    image.load()
    targets = {
        STAGE / "ICON.PNG": 64,
        STAGE / "ICON_256.PNG": 256,
        STAGE / "app/ui/images/icon_64.png": 64,
        STAGE / "app/ui/images/icon_256.png": 256,
    }
    for path, size in targets.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        image.resize((size, size), Image.LANCZOS).save(path, "PNG")
    return {p.name: p.stat().st_size for p in targets}


def find_fnpack():
    env = os.environ.get("FNPACK_BIN")
    if env:
        p = Path(env)
        if not p.exists():
            raise SystemExit(f"FNPACK_BIN 指向的文件不存在：{p}")
        return p

    exe = "fnpack.exe" if os.name == "nt" else "fnpack"
    cached = BIN_DIR / exe
    if cached.exists():
        print(f"[1/5] 使用已缓存的 fnpack：{cached}")
        return cached

    key = (platform.system(), platform.machine())
    url = FNPACK_URLS.get(key)
    if not url:
        raise SystemExit(f"没有适配 {key} 的 fnpack，请手动设置 FNPACK_BIN")
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[1/5] 下载 fnpack {FNPACK_VERSION}（{platform.system()}/{platform.machine()}）...")
    urllib.request.urlretrieve(url, cached)
    try:
        cached.chmod(0o755)
    except OSError:
        pass
    return cached


def resolve_image_tar(value):
    """把 --with-image 的取值归一成路径；"auto" 时去 .out 下找 build-image.sh 的产物"""
    if not value:
        return None
    if value != "auto":
        p = Path(value).expanduser()
        if not p.exists():
            raise SystemExit(f"离线镜像不存在：{p}")
        return p

    for name in ("assettracker-image.tar", "assettracker-image.tar.gz",
                 "assettracker-image.tgz", "image.tar"):
        p = IMAGE_DIR / name
        if p.exists():
            return p
    raise SystemExit(
        "没有找到离线镜像。先在 WSL/Linux 里构建并导出：\n"
        "  bash packaging/fnos/build-image.sh --save\n"
        "或手动指定：--with-image 路径/到/image.tar"
    )


def inspect_image_tar(path, version):
    """读 docker save 产物里的 manifest.json，确认镜像 tag 与本包版本一致

    这一步专治「包里的镜像 tag 写成 1.0.1、manifest 却是 1.0.0」——装完起不来，
    而且报错只在容器日志里，很难查。读不出来就返回 None，只做提示不阻断。
    """
    try:
        with tarfile.open(path, "r:*") as tf:
            member = None
            for m in tf:
                if m.name in ("manifest.json", "./manifest.json"):
                    member = m
                    break
            if member is None:
                return None
            data = json.loads(tf.extractfile(member).read().decode("utf-8"))
    except (tarfile.TarError, OSError, ValueError, EOFError):
        return None

    tags = []
    for item in data if isinstance(data, list) else []:
        tags.extend(item.get("RepoTags") or [])
    return tags


def build_stage(version, image_tar=None):
    if STAGE.exists():
        shutil.rmtree(STAGE)
    shutil.copytree(TEMPLATE, STAGE)
    (STAGE / "wizard/.gitkeep").unlink(missing_ok=True)
    render_files(version)
    icons = make_icons()

    if image_tar:
        tar_path = Path(image_tar).resolve()
        dst = STAGE / "app/docker/assettracker-image.tar"
        shutil.copy2(tar_path, dst)
        size = dst.stat().st_size
        print(f"      附带离线镜像：{human(size)}（{tar_path.name}）")

        tags = inspect_image_tar(tar_path, version)
        expected = f"assettracker:{version}"
        if tags is None:
            print("      提示：读不到镜像 manifest.json，跳过 tag 校验")
        elif tags and expected not in tags:
            print(f"      [警告] 镜像 tag 是 {', '.join(tags)}，与 {expected} 不一致；"
                  "安装后应用中心会提示找不到镜像")
        else:
            print(f"      镜像 tag 校验通过：{expected}")

        if size > 1536 * 1024 * 1024:
            print("      [警告] 离线镜像超过 1.5 GB，飞牛上的安装会明显变慢")
    return icons


def run_fnpack(fnpack):
    print("[4/5] 调用 fnpack 打包 ...")
    r = subprocess.run([str(fnpack), "build"], cwd=STAGE, capture_output=True, text=True)
    out = (r.stdout or "") + (r.stderr or "")
    print("      " + out.strip().replace("\n", "\n      "))
    if r.returncode != 0:
        raise SystemExit(f"fnpack 打包失败（exit {r.returncode}）")
    fpk = STAGE / "assettracker.fpk"
    if not fpk.exists():
        raise SystemExit("fnpack 未生成 assettracker.fpk")
    return fpk


def fix_permissions(fpk):
    """重写包内权限：Windows 上打包时 tar 里没有执行位

    fnOS 会直接执行 cmd/ 下的脚本，缺 +x 可能启动失败。
    这里统一把 cmd/* 设为 0755、其余 0644，与 Linux 下打包的结果一致。
    """
    tmp = fpk.with_name(fpk.name + ".tmp")
    with tarfile.open(fpk, "r:gz") as src, tarfile.open(tmp, "w:gz") as dst:
        for m in src.getmembers():
            if m.isdir() or m.name.startswith("cmd/"):
                m.mode = 0o755
            else:
                m.mode = 0o644
            fh = src.extractfile(m) if m.isfile() else None
            dst.addfile(m, fh)
    tmp.replace(fpk)


def verify(fpk, version):
    """校验包结构 + manifest 里的 checksum 是否等于 app.tgz 的 MD5"""
    problems = []
    with tarfile.open(fpk, "r:gz") as tf:
        names = tf.getnames()
        for required in ("manifest", "app.tgz", "cmd/main", "config/privilege",
                         "config/resource", "ICON.PNG", "ICON_256.PNG"):
            if required not in names:
                problems.append(f"缺少 {required}")
        manifest = tf.extractfile("manifest").read().decode("utf-8")
        app_tgz = tf.extractfile("app.tgz").read() if "app.tgz" in names else b""
        for script in ("cmd/main", "cmd/install_init", "cmd/uninstall_init"):
            if script in names:
                mode = tf.getmember(script).mode
                if not mode & 0o111:
                    problems.append(f"{script} 缺少执行权限（{oct(mode)}）")

    if not re.search(rf"^version\s*=\s*{re.escape(version)}\s*$", manifest, re.M):
        problems.append("manifest 版本号与 VERSION 不一致")

    m = re.search(r"checksum\s*=\s*([0-9a-f]{32})", manifest)
    if not m:
        problems.append("manifest 缺少 checksum")
    elif hashlib.md5(app_tgz).hexdigest() != m.group(1):
        problems.append("checksum 与 app.tgz 不匹配")

    if problems:
        raise SystemExit("包校验失败：\n  - " + "\n  - ".join(problems))
    return len(app_tgz)


def human(n):
    return f"{n / 1024 / 1024:.1f} MB" if n >= 1024 * 1024 else f"{n / 1024:.0f} KB"


def archive_old_versions(target):
    """把 dist-fpk 里其它版本的 fpk 挪进 old/，主目录只留当前版

    fpk 是自包含大文件（40+ MB），堆在主目录既占眼又容易装错旧版。
    本包不做处理；挪不动的（被占用等）只告警不阻断。
    """
    old_dir = OUT_DIR / "old"
    for p in OUT_DIR.glob("assettracker_*.fpk"):
        if p == target:
            continue
        old_dir.mkdir(exist_ok=True)
        try:
            shutil.move(str(p), str(old_dir / p.name))
            print(f"     已归档旧版本：old/{p.name}")
        except OSError as exc:
            print(f"     [警告] 归档 {p.name} 失败（{exc}），留在原处")


def main():
    ap = argparse.ArgumentParser(description="打包飞牛 fnOS fpk（Docker 模式）")
    ap.add_argument("--with-image", nargs="?", const="auto", metavar="TAR",
                    help="附带 docker save 的镜像 tar（离线安装）；不带值则自动找 .out/ 下的镜像")
    ap.add_argument("--keep-stage", action="store_true", help="保留 .build 目录便于检查")
    args = ap.parse_args()

    version = read_version()
    print(f"[0/5] 版本：{version}")

    image_tar = resolve_image_tar(args.with_image)
    fnpack = find_fnpack()

    print("[2/5] 组装打包目录、生成图标 ...")
    build_stage(version, image_tar)

    fpk = run_fnpack(fnpack)
    fix_permissions(fpk)

    print("[5/5] 校验包结构 ...")
    app_size = verify(fpk, version)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    target = OUT_DIR / f"assettracker_{version}_x86.fpk"
    shutil.copy2(fpk, target)
    size = target.stat().st_size
    archive_old_versions(target)

    if not args.keep_stage:
        shutil.rmtree(STAGE, ignore_errors=True)

    print(f"\n[ok] {target}")
    print(f"     包体积 {human(size)}（app.tgz 解压后 {human(app_size)}）")
    print("     安装：飞牛桌面 → 应用中心 → 右上角设置 → 手动安装应用 → 选择该 fpk")
    if image_tar:
        print(f"     镜像：已内置 assettracker:{version}，安装时自动 docker load，无需联网")
    else:
        print(f"     镜像：assettracker:{version}（需先在 NAS 上 docker build，"
              "或加 --with-image 打离线包）")


if __name__ == "__main__":
    sys.exit(main())
