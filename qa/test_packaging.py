# -*- coding: utf-8 -*-
"""打包契约测试：保证 exe / Docker / fpk 三个目标不会各自漂移

运行：python qa/test_packaging.py
重点防的事故：
  · 加了新模块但 Dockerfile 没 COPY（镜像构建后 import 失败）
  · fpk 的 manifest / ui/config / compose 三处名字对不上
  · Windows 上打出的 fpk 里脚本没有执行位
"""
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tarfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FPK = ROOT / "packaging" / "fnos" / "assettracker"
VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip()

CMD_SCRIPTS = ("main", "install_init", "install_callback", "uninstall_init",
               "uninstall_callback", "upgrade_init", "upgrade_callback",
               "config_init", "config_callback")


class TestVersion(unittest.TestCase):
    def test_semver(self):
        self.assertRegex(VERSION, r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")

    def test_health_uses_version(self):
        src = (ROOT / "at" / "__init__.py").read_text(encoding="utf-8")
        self.assertIn("APP_VERSION", src)


class TestDockerTarget(unittest.TestCase):
    def test_dockerfile_copies_core(self):
        src = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        for line in ("COPY VERSION .", "COPY app.py .", "COPY at ./at",
                     "COPY templates ./templates", "COPY static ./static"):
            self.assertIn(line, src, f"Dockerfile 缺少：{line}")

    def test_dockerignore_keeps_core(self):
        src = (ROOT / ".dockerignore").read_text(encoding="utf-8")
        self.assertNotIn("at/", src)
        self.assertNotIn("VERSION", src)

    def test_dockerfile_allows_mirror(self):
        """国内拉不动时能只换参数、不改文件"""
        src = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("ARG BASE_IMAGE", src)
        self.assertIn("FROM ${BASE_IMAGE}", src)
        self.assertIn("ARG PIP_INDEX_URL", src)


def find_bash():
    """找一个可用的 Git Bash / Linux bash；Windows 自带的 System32\\bash.exe 是 WSL 启动器，跳过"""
    import os
    cand = shutil.which("bash") or os.environ.get("BASH")
    if not cand:
        return None
    if sys.platform == "win32" and "system32" in cand.lower():
        return None
    return cand


class TestFpkTemplate(unittest.TestCase):
    def manifest(self):
        return (FPK / "manifest").read_text(encoding="utf-8")

    def test_manifest_fields(self):
        text = self.manifest()
        for key in ("appname", "version", "display_name", "desc", "platform",
                    "source", "desktop_uidir", "desktop_applaunchname", "service_port"):
            self.assertRegex(text, rf"(?m)^{key}\s*=", f"manifest 缺少 {key}")
        self.assertIn("{{VERSION}}", text, "manifest 应由构建脚本注入版本号")
        self.assertRegex(text, r"(?m)^source\s*=\s*thirdparty")
        self.assertRegex(text, r"(?m)^platform\s*=\s*(x86|arm|all)")

    def test_desktop_entry_matches_manifest(self):
        manifest = self.manifest()
        launch = re.search(r"(?m)^desktop_applaunchname\s*=\s*(\S+)", manifest).group(1)
        ui = json.loads((FPK / "app/ui/config").read_text(encoding="utf-8"))
        self.assertIn(launch, ui[".url"], "ui/config 的入口 ID 与 manifest 不一致")
        entry = ui[".url"][launch]
        # 参照 Motrix 2.3.0 的可用写法：桌面走统一网关（unix socket），
        # 不声明 protocol/port —— 否则 HTTPS 域名会被拼成 http://host:5678，直接 502
        self.assertEqual(entry["type"], "iframe")
        self.assertEqual(entry["gatewaySocket"], "app.sock")
        self.assertEqual(entry["gatewayPrefix"], "/app/assettracker")
        self.assertTrue(entry["url"].startswith("/app/assettracker"))
        self.assertNotIn("protocol", entry)
        self.assertNotIn("port", entry)

    def test_config_json(self):
        priv = json.loads((FPK / "config/privilege").read_text(encoding="utf-8"))
        self.assertEqual(priv["defaults"]["run-as"], "root",
                         "要访问 docker socket，必须以 root 运行")
        self.assertTrue(priv["username"])
        res = json.loads((FPK / "config/resource").read_text(encoding="utf-8"))
        self.assertEqual(res, {},
                         "不能用 docker-project：fnOS 会在生命周期钩子之前就 compose up，"
                         "内置镜像还没 load 就会 No such image")
        self.assertIn("docker-project", (ROOT / "packaging/fnos/README.md").read_text(encoding="utf-8"),
                      "文档要说明为什么不用 docker-project")

    def test_network_mode(self):
        main = (FPK / "cmd/main").read_text(encoding="utf-8")
        # 必须 bridge + 端口映射：Docker 页的「远程访问」按钮依赖发布端口
        self.assertIn('-p "5678:5678"', main)
        self.assertNotIn("--network host", main)
        self.assertIn("-e PORT=5678", main)
        # 不要再引入 wizard_port：那次同时改了端口来源，图标直接失效
        self.assertNotIn("${wizard_port", main, "端口来源必须固定，不要再从向导取")

    def test_main_owns_container_lifecycle(self):
        text = (FPK / "cmd/main").read_text(encoding="utf-8")
        self.assertIn("docker load -i", text, "start 阶段必须自己 load 内置镜像")
        self.assertIn("docker run", text, "start 阶段必须自己起容器")
        self.assertIn("exit 3", text, "status 未运行时返回 3")
        self.assertIn("TRIM_APPDEST", text)
        self.assertIn('{{VERSION}}', text, "镜像 tag 由构建脚本注入")

    def test_compose(self):
        # compose 只作为本地调试参考，fnOS 运行时不使用
        text = (FPK / "app/docker/docker-compose.yaml").read_text(encoding="utf-8")
        self.assertIn("assettracker", text)
        self.assertIn("{{VERSION}}", text)
        self.assertIn("/data", text)
        self.assertIn("DATA_DIR=/data", text)
        self.assertIn("HEADLESS=1", text)

    def test_scripts(self):
        for name in CMD_SCRIPTS:
            p = FPK / "cmd" / name
            self.assertTrue(p.exists(), f"缺少 cmd/{name}")
            text = p.read_text(encoding="utf-8")
            self.assertTrue(text.startswith("#!/bin/bash"), f"cmd/{name} 缺 shebang")
            self.assertIn("exit", text)

    @unittest.skipUnless(find_bash(), "没有可用的 Git Bash / Linux bash，跳过语法检查")
    def test_scripts_syntax(self):
        bash = find_bash()
        for name in CMD_SCRIPTS:
            r = subprocess.run([bash, "-n", str(FPK / "cmd" / name)],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, f"cmd/{name} 语法错误：{r.stderr}")

    def test_build_script_compiles(self):
        src = (ROOT / "packaging/fnos/build.py").read_text(encoding="utf-8")
        compile(src, "build.py", "exec")
        self.assertIn("fix_permissions", src, "必须修正 Windows 打包缺失的执行位")


class TestImagePipeline(unittest.TestCase):
    """镜像构建 → 导出 → 打进 fpk 的契约，防止路径/文件名各自漂移"""

    def setUp(self):
        self.fnos = ROOT / "packaging" / "fnos"
        self.shell = (self.fnos / "build-image.sh").read_text(encoding="utf-8")
        self.build = (self.fnos / "build.py").read_text(encoding="utf-8")
        self.callback = (self.fnos / "assettracker/cmd/install_callback").read_text(encoding="utf-8")

    def test_shell_script_exists(self):
        self.assertTrue((self.fnos / "build-image.sh").exists())
        self.assertIn('build -t "$TAG"', self.shell)
        self.assertIn("docker save", self.shell)
        self.assertIn("--save", self.shell)
        self.assertIn("State.Health", self.shell, "冒烟必须等 HEALTHCHECK 变 healthy")

    def test_shell_matches_version_source(self):
        self.assertIn('VERSION', self.shell)
        self.assertIn("assettracker:$VERSION", self.shell, "镜像 tag 必须来自 VERSION")

    def test_output_path_contract(self):
        # build-image.sh --save 的产物 == build.py 自动发现的位置 == install_callback 的导入路径
        self.assertIn('OUT_DIR="$SCRIPT_DIR/.out"', self.shell)
        self.assertIn("assettracker-image.tar", self.shell)
        self.assertIn('IMAGE_DIR = HERE / ".out"', self.build)
        self.assertIn("assettracker-image.tar", self.build)
        self.assertIn('TAR="${TRIM_APPDEST}/docker/assettracker-image.tar"', self.callback)
        self.assertIn('STAGE / "app/docker/assettracker-image.tar"', self.build)

    def test_callback_loads_compressed(self):
        self.assertIn("gunzip", self.callback, "docker load 失败时要能用 gunzip 兜底")
        self.assertIn("docker tag", self.callback, "tag 不一致时应补别名")

    def test_bat_wrappers(self):
        for name, needle in (("build-image.bat", "build-image.sh"),
                             ("build-fpk.bat", "build.py")):
            p = self.fnos / name
            self.assertTrue(p.exists(), f"缺少 {name}")
            text = p.read_text(encoding="utf-8")
            self.assertIn("wsl.exe" if name == "build-image.bat" else "python", text.lower())
            self.assertIn(needle, text)

    @unittest.skipUnless(find_bash(), "没有可用的 Git Bash / Linux bash，跳过语法检查")
    def test_shell_syntax(self):
        r = subprocess.run([find_bash(), "-n", str(self.fnos / "build-image.sh")],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)


class TestWindowsLaunchers(unittest.TestCase):
    """cmd.exe 按 OEM 代码页逐行解析 .bat：必须 CRLF，fnos 的脚本必须纯 ASCII

    踩过的坑：用编辑器存成 UTF-8 + LF 后，`if (...)` 多行块直接解析失败，
    双击窗口一闪而过，什么都看不到。
    """

    def fnos_bats(self):
        return sorted((ROOT / "packaging" / "fnos").glob("*.bat"))

    def test_crlf(self):
        for p in self.fnos_bats() + [ROOT / "build.bat"]:
            b = p.read_bytes()
            self.assertEqual(b.count(b"\r\n"), b.count(b"\n"),
                             f"{p.name} 存在裸 LF，cmd 会解析失败")

    def test_fnos_bats_ascii_only(self):
        for p in self.fnos_bats():
            b = p.read_bytes()
            offsets = [i for i, x in enumerate(b) if x > 127]
            self.assertFalse(offsets, f"{p.name} 含非 ASCII 字节（偏移 {offsets[:3]}），"
                                      "中文提示请放在 .sh / .py 里输出")

    def test_no_parenthesised_blocks(self):
        # 括号块在编码/换行异常时最容易崩，这里用 goto 写法，顺带守住风格
        for p in self.fnos_bats():
            text = p.read_text(encoding="ascii")
            self.assertNotIn("if errorlevel 1 (", text)
            self.assertNotIn("if not errorlevel 1 (", text)

    def test_goto_labels_exist(self):
        import re as _re

        for p in self.fnos_bats():
            text = p.read_text(encoding="ascii")
            targets = set(_re.findall(r"(?mi)^\s*goto\s+(\w+)", text))
            labels = set(_re.findall(r"(?mi)^\s*:(\w+)", text))
            missing = targets - labels
            self.assertFalse(missing, f"{p.name} 的 goto 目标不存在：{sorted(missing)}")

    def test_make_fpk_is_one_click(self):
        text = (ROOT / "packaging/fnos/make-fpk.bat").read_text(encoding="ascii")
        self.assertIn("build-image.sh --save", text, "必须先构建并导出镜像")
        self.assertIn("build.py --with-image", text, "必须把镜像打进 fpk")
        self.assertIn("goto build_failed", text, "镜像构建失败不能继续打包")

    def test_image_bat_calls_shell_script(self):
        text = (ROOT / "packaging/fnos/build-image.bat").read_text(encoding="ascii")
        self.assertIn("wsl.exe", text.lower())
        self.assertIn("build-image.sh", text)
        self.assertIn("FNOS_WSL_DISTRO", text)


class TestContextPath(unittest.TestCase):
    """回归：prepare_context 只允许把路径写 stdout，日志必须走 stderr

    踩过的坑：ok()/step() 写 stdout，被 $(prepare_context) 一起捕获，
    docker build 收到 "\n\x1b[2m==> 复制…/var/tmp/assettracker-ctx"，
    报 `unable to prepare context: path "..." not found`。
    """

    def script(self):
        return ROOT / "packaging" / "fnos" / "build-image.sh"

    def test_log_helpers_use_stderr(self):
        text = self.script().read_text(encoding="utf-8")
        for fn in ("step()", "ok()", "warn()", "die()"):
            line = next(l for l in text.splitlines() if l.startswith(fn))
            self.assertIn(">&2", line, f"{fn} 必须输出到 stderr，否则会被 $(...) 当成返回值")

    @unittest.skipIf(sys.platform == "win32", "Windows 下 fake docker 的 PATH 解析不可靠，交给 CI")
    def test_context_path_is_clean(self):
        import os
        import tempfile

        bash = find_bash()
        if not bash:
            self.skipTest("没有 bash")
        tmp = Path(tempfile.mkdtemp(prefix="ctx_probe_"))
        probe = tmp / "arg.txt"
        shim = tmp / "docker"
        shim.write_text(
            "#!/usr/bin/env bash\n"
            'case "$1" in\n'
            '  info) exit 0 ;;\n'
            '  build) printf "%s" "${@: -1}" > "$PROBE_OUT"; exit 0 ;;\n'
            '  image) case "$*" in *Architecture*) echo amd64 ;; *Size*) echo 1 ;; esac ;;\n'
            '  *) exit 0 ;;\n'
            "esac\n",
            encoding="utf-8",
        )
        shim.chmod(0o755)
        env = dict(os.environ,
                   PATH=f"{tmp}{os.pathsep}{os.environ.get('PATH', '')}",
                   PROBE_OUT=str(probe),
                   AT_FORCE_LOCAL_CONTEXT="1")
        r = subprocess.run([bash, "build-image.sh", "--no-smoke", "--no-save"],
                           cwd=ROOT / "packaging" / "fnos",
                           capture_output=True, text=True, env=env, timeout=180)
        self.assertEqual(r.returncode, 0, r.stderr)
        arg = probe.read_text(encoding="utf-8")
        self.assertEqual(arg, "/var/tmp/assettracker-ctx",
                         f"docker 收到的上下文路径不干净：{arg!r}")


class TestBuiltFpk(unittest.TestCase):
    """有产物时顺带验一遍真包；没有就跳过（CI 里先跑 build 再跑测试）"""

    def latest(self):
        d = ROOT / "dist-fpk"
        if not d.exists():
            return None
        files = sorted(d.glob("assettracker_*.fpk"))
        return files[-1] if files else None

    def test_package(self):
        fpk = self.latest()
        if fpk is None:
            self.skipTest("还没有 dist-fpk，先运行 packaging/fnos/build.py")
        with tarfile.open(fpk, "r:gz") as tf:
            names = tf.getnames()
            for required in ("manifest", "app.tgz", "cmd/main", "config/privilege",
                             "config/resource", "ICON.PNG", "ICON_256.PNG"):
                self.assertIn(required, names)
            manifest = tf.extractfile("manifest").read().decode("utf-8")
            app_tgz = tf.extractfile("app.tgz").read()
            self.assertRegex(manifest, rf"(?m)^version\s*=\s*{re.escape(VERSION)}\s*$")
            digest = re.search(r"(?m)^checksum\s*=\s*([0-9a-f]{32})", manifest).group(1)
            self.assertEqual(hashlib.md5(app_tgz).hexdigest(), digest, "checksum 不匹配")
            for script in ("cmd/main", "cmd/install_init", "cmd/uninstall_init"):
                mode = tf.getmember(script).mode
                self.assertTrue(mode & 0o111, f"{script} 缺执行位：{oct(mode)}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
