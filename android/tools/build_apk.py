# -*- coding: utf-8 -*-
"""
build_apk.py —— 把网页版打包成可安装的 Android APK

不使用 Gradle（本机 maven.google.com 不可达，Gradle 拉不到依赖），
直接用 SDK 自带的命令行工具走标准流水线：

    aapt2 compile -> aapt2 link -> javac -> d8 -> 注入 dex -> zipalign -> apksigner

两个必须遵守的约束（都踩过）：
  1. aapt2 / zipalign 无法处理非 ASCII 路径 -> 全程在临时目录里构建，最后拷回
  2. build-tools 34 的 R8 无法 dex 内部类 / 泛型父接口 -> 宿主代码全用顶层类
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ANDROID_DIR = os.path.dirname(HERE)
PROJECT = os.path.dirname(ANDROID_DIR)
APP_DIR = os.path.join(ANDROID_DIR, "app")

BT_VER = "34.0.0"
PLAT_VER = "android-34"
MIN_SDK = "26"
TARGET_SDK = "34"

ASSET_ITEMS = [
    ("file", "index.html"),
    ("file", "web/style.css"),
    ("file", "web/app.js"),
    ("dir", "core"),
    ("dir", "vendor"),
    # data/ 下只打这两个成品，绝不能整个目录拷进去
    # （data/_raw/ 里躺着 63MB 的 ECDICT 原始 csv，打进去 APK 会白白胖到 24MB）
    ("file", "data/dict.json.gz"),
    ("file", "data/syn.json.gz"),
]

# 无论如何都不许出现在 assets 里的东西
ASSET_DENY_SUFFIX = (".csv", ".part")
ASSET_DENY_DIR = ("_raw",)


def log(s=""):
    try:
        print(s, flush=True)
    except Exception:
        pass


def die(msg):
    log()
    log("  [失败] " + msg)
    log()
    sys.exit(1)


def run(cmd, step):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       universal_newlines=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        log("  [%s] 失败" % step)
        log("  " + " ".join(cmd))
        for line in (p.stdout or "").strip().splitlines()[-30:]:
            log("    " + line)
        die(step + " 步骤失败")
    return p.stdout or ""


def find_java():
    def which(n):
        for d in os.environ.get("PATH", "").split(os.pathsep):
            p = os.path.join(d, n)
            if os.path.isfile(p):
                return p
        return None
    java = which("java.exe") or which("java")
    javac = which("javac.exe") or which("javac")
    keytool = which("keytool.exe") or which("keytool")
    missing = [n for n, v in (("java", java), ("javac", javac), ("keytool", keytool)) if not v]
    if missing:
        die("找不到 JDK 工具：%s" % ", ".join(missing))
    return java, javac, keytool


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sdk-root", default=os.path.join(tempfile.gettempdir(), "wm-android-sdk"))
    ap.add_argument("--clean", action="store_true")
    args = ap.parse_args()

    sdk = os.path.abspath(args.sdk_root)
    bt = os.path.join(sdk, "build-tools", BT_VER)
    android_jar = os.path.join(sdk, "platforms", PLAT_VER, "android.jar")
    aapt2 = os.path.join(bt, "aapt2.exe")

    for label, p in [("aapt2.exe", aapt2), ("android.jar", android_jar)]:
        if not os.path.exists(p):
            die("缺少 %s：%s\n         先运行：python android/tools/fetch_sdk.py" % (label, p))

    java, javac, keytool = find_java()

    # 工作目录必须是纯 ASCII
    work = os.path.join(tempfile.gettempdir(), "wm-apk-build")
    if args.clean and os.path.isdir(work):
        shutil.rmtree(work)
    os.makedirs(work, exist_ok=True)

    log()
    log("  ==========================================")
    log("     词忆 · APK 构建")
    log("  ==========================================")
    log("  项目 : %s" % PROJECT)
    log("  SDK  : %s" % sdk)
    log("  工作 : %s" % work)
    log()

    # ---------- 1) 准备源文件与网页资源 ----------
    log("  [1/8] 准备资源")
    src = os.path.join(work, "src")
    assets = os.path.join(work, "assets")
    for d in (src, assets):
        shutil.rmtree(d, ignore_errors=True)
    os.makedirs(src, exist_ok=True)
    os.makedirs(assets, exist_ok=True)

    shutil.copy2(os.path.join(APP_DIR, "AndroidManifest.xml"), os.path.join(src, "AndroidManifest.xml"))
    shutil.copytree(os.path.join(APP_DIR, "res"), os.path.join(src, "res"))
    shutil.copytree(os.path.join(APP_DIR, "java"), os.path.join(src, "java"))

    for kind, rel in ASSET_ITEMS:
        s = os.path.join(PROJECT, rel)
        if kind == "file":
            if not os.path.isfile(s):
                die("缺少网页文件：" + rel)
            dst = os.path.join(assets, rel.replace("/", os.sep))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(s, dst)
            log("      + %s" % rel)
        else:
            if not os.path.isdir(s):
                die("缺少目录：" + rel)
            shutil.copytree(s, os.path.join(assets, rel))
            n = sum(len(f) for _, _, f in os.walk(os.path.join(assets, rel)))
            log("      + %s/  (%d 个文件)" % (rel, n))

    total = sum(len(f) for _, _, f in os.walk(assets))
    log("      assets 共 %d 个文件" % total)

    # 防呆：原始数据 / 测试 / 构建脚本绝不能被塞进安装包
    bad = []
    for root, dirs, files in os.walk(assets):
        for d in list(dirs):
            if d in ASSET_DENY_DIR:
                bad.append(os.path.join(root, d))
        for f in files:
            if f.lower().endswith(ASSET_DENY_SUFFIX):
                bad.append(os.path.join(root, f))
    if bad:
        die("assets 里混进了不该打包的东西：\n         " + "\n         ".join(
            os.path.relpath(b, assets) for b in bad))

    # ---------- 2) aapt2 compile ----------
    log("  [2/8] aapt2 compile")
    compiled = os.path.join(work, "compiled.zip")
    if os.path.exists(compiled):
        os.remove(compiled)
    run([aapt2, "compile", "--dir", os.path.join(src, "res"), "-o", compiled], "aapt2 compile")

    # ---------- 3) aapt2 link ----------
    log("  [3/8] aapt2 link")
    base_apk = os.path.join(work, "base.apk")
    if os.path.exists(base_apk):
        os.remove(base_apk)
    run([aapt2, "link", "-o", base_apk, "-I", android_jar,
         "--manifest", os.path.join(src, "AndroidManifest.xml"),
         "-R", compiled, "--auto-add-overlay",
         "-A", assets,
         "--min-sdk-version", MIN_SDK, "--target-sdk-version", TARGET_SDK,
         "--version-code", "3", "--version-name", "1.1.2"], "aapt2 link")
    log("      基础 APK %.0f KB" % (os.path.getsize(base_apk) / 1024.0))

    # ---------- 4) javac ----------
    log("  [4/8] javac")
    classes = os.path.join(work, "classes")
    shutil.rmtree(classes, ignore_errors=True)
    os.makedirs(classes)
    sources = []
    for root, _, files in os.walk(os.path.join(src, "java")):
        for f in files:
            if f.endswith(".java"):
                sources.append(os.path.join(root, f))
    run([javac, "--release", "8", "-nowarn", "-cp", android_jar, "-d", classes] + sources, "javac")

    produced = [f for _, _, fs in os.walk(classes) for f in fs if f.endswith(".class")]
    log("      %d 个 class" % len(produced))
    inner = sorted(n for n in produced if "$" in n)
    if inner:
        die("检测到内部类/匿名类，当前 R8 无法 dex：\n         " + ", ".join(inner))

    # ---------- 5) d8 ----------
    log("  [5/8] d8")
    dexdir = os.path.join(work, "dex")
    shutil.rmtree(dexdir, ignore_errors=True)
    os.makedirs(dexdir)
    class_files = [os.path.join(r, f) for r, _, fs in os.walk(classes) for f in fs if f.endswith(".class")]
    run([java, "-Xmx1024M", "-cp", os.path.join(bt, "lib", "d8.jar"), "com.android.tools.r8.D8",
         "--lib", android_jar, "--min-api", MIN_SDK, "--output", dexdir] + class_files, "d8")
    dex = os.path.join(dexdir, "classes.dex")
    if not os.path.exists(dex):
        die("d8 没有产出 classes.dex")
    log("      classes.dex %.1f KB" % (os.path.getsize(dex) / 1024.0))

    # ---------- 6) 注入 dex ----------
    log("  [6/8] 注入 dex")
    tmp = base_apk + ".tmp"
    with zipfile.ZipFile(base_apk, "r") as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            if item.filename == "classes.dex":
                continue
            zi = zipfile.ZipInfo(item.filename, date_time=item.date_time)
            zi.compress_type = item.compress_type
            zi.external_attr = item.external_attr
            zout.writestr(zi, zin.read(item.filename))
        zi = zipfile.ZipInfo("classes.dex", date_time=(2024, 1, 1, 0, 0, 0))
        zi.compress_type = zipfile.ZIP_DEFLATED
        with open(dex, "rb") as f:
            zout.writestr(zi, f.read())
    os.replace(tmp, base_apk)

    # ---------- 7) zipalign ----------
    log("  [7/8] zipalign")
    aligned = os.path.join(work, "aligned.apk")
    if os.path.exists(aligned):
        os.remove(aligned)
    run([os.path.join(bt, "zipalign.exe"), "-f", "-p", "4", base_apk, aligned], "zipalign")

    # ---------- 8) 签名 ----------
    log("  [8/8] apksigner")
    ks = os.path.join(ANDROID_DIR, "keystore", "debug.keystore")
    os.makedirs(os.path.dirname(ks), exist_ok=True)
    local_ks = os.path.join(work, "debug.keystore")
    if os.path.exists(ks):
        shutil.copy2(ks, local_ks)
        log("      复用已有签名密钥")
    else:
        log("      生成签名密钥（调试用）")
        run([keytool, "-genkeypair", "-v", "-keystore", local_ks,
             "-storepass", "android", "-alias", "androiddebugkey", "-keypass", "android",
             "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
             "-dname", "CN=WordMemory,OU=Dev,O=Local,L=NA,ST=NA,C=CN"], "keytool")
        shutil.copy2(local_ks, ks)

    signed = os.path.join(work, "CiYi.apk")
    if os.path.exists(signed):
        os.remove(signed)
    run([java, "-jar", os.path.join(bt, "lib", "apksigner.jar"), "sign",
         "--ks", local_ks, "--ks-pass", "pass:android", "--key-pass", "pass:android",
         "--v1-signing-enabled", "true", "--v2-signing-enabled", "true",
         "--out", signed, aligned], "apksigner")

    # ---------- 验证 ----------
    log()
    log("  ---------- 验证 ----------")
    out = run([java, "-jar", os.path.join(bt, "lib", "apksigner.jar"), "verify", "--print-certs", "-v", signed],
              "verify")
    for line in out.splitlines():
        s = line.strip()
        if s.startswith("Verifies") or "certificate DN" in s:
            log("    " + s)

    badging = run([aapt2, "dump", "badging", signed], "badging")
    for line in badging.splitlines():
        if line.startswith(("package:", "sdkVersion:", "targetSdkVersion:", "application-label:")):
            log("    " + line.strip())

    problems = []
    with zipfile.ZipFile(signed) as z:
        names = z.namelist()
        for key in ["AndroidManifest.xml", "classes.dex", "resources.arsc"]:
            if key not in names:
                problems.append(key)
        assets_n = [n for n in names if n.startswith("assets/")]
        log("    assets 条目 %d 个" % len(assets_n))
        for need in ["assets/index.html", "assets/web/app.js", "assets/core/db.js",
                     "assets/vendor/sql-wasm.wasm", "assets/data/dict.json.gz"]:
            if need not in names:
                problems.append(need)
                log("    [缺失] " + need)
        leaked = [n for n in assets_n if n.startswith(("assets/test/", "assets/android/"))]
        if leaked:
            problems.append("多余目录")
            log("    [多余] %s" % leaked[:3])

    # 交付
    outdir = os.path.join(ANDROID_DIR, "build")
    os.makedirs(outdir, exist_ok=True)
    final = os.path.join(outdir, "词忆.apk")
    shutil.copy2(signed, final)

    log()
    log("  ==========================================")
    if problems:
        log("  构建完成，但有 %d 个问题：%s" % (len(problems), problems))
    else:
        log("  构建成功")
    log("  ==========================================")
    log("  产物: %s" % final)
    log("  大小: %.1f MB" % (os.path.getsize(final) / 1048576.0))
    log()
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
