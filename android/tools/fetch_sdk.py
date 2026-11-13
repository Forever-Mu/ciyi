# -*- coding: utf-8 -*-
"""fetch_sdk.py —— 下载构建 APK 所需的最小 Android SDK（绕过 sdkmanager，避免 Gradle 依赖）"""
import os
import shutil
import sys
import tempfile
import time
import urllib.request
import zipfile

REPO = "https://dl.google.com/android/repository/"
COMPONENTS = [
    ("build-tools", REPO + "build-tools_r34-windows.zip", "34.0.0"),
    ("platform", REPO + "platform-34-ext7_r03.zip", "android-34"),
]
UA = "Mozilla/5.0 (compatible; WordMemoryBuild/1.0)"


def log(s=""):
    try:
        print(s, flush=True)
    except Exception:
        pass


def sdk_root():
    return os.path.join(tempfile.gettempdir(), "wm-android-sdk")


def download(url, dest, tries=8):
    """带重试的下载。dl.google.com 偶尔会中途断开连接。"""
    if os.path.exists(dest) and os.path.getsize(dest) > 1024 * 1024:
        log("    已存在：%s (%.1f MB)" % (os.path.basename(dest), os.path.getsize(dest) / 1048576.0))
        return
    last = None
    for attempt in range(tries):
        tmp = dest + ".part"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r, open(tmp, "wb") as f:
                total = int(r.headers.get("Content-Length") or 0)
                done = 0
                while True:
                    c = r.read(1024 * 256)
                    if not c:
                        break
                    f.write(c)
                    done += len(c)
                    if total and done % (10 * 1024 * 1024) < 256 * 1024:
                        log("      %d%% (%.0f/%.0f MB)" % (done * 100 // total, done / 1048576, total / 1048576))
            # 校验完整性
            if total and os.path.getsize(tmp) != total:
                raise IOError("大小不符 %d/%d" % (os.path.getsize(tmp), total))
            os.replace(tmp, dest)
            log("    完成 %.1f MB" % (os.path.getsize(dest) / 1048576.0))
            return
        except Exception as e:
            last = e
            log("    第 %d/%d 次失败：%s" % (attempt + 1, tries, type(e).__name__))
            if os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass
            time.sleep(2 + attempt * 2)
    raise RuntimeError("下载失败：%s（%s）" % (url, last))


def extract(zip_path, target):
    if os.path.isdir(target) and os.listdir(target):
        log("    已解压：%s" % target)
        return
    staging = target + "__st"
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(staging)
    entries = [e for e in os.listdir(staging) if not e.startswith("__")]
    src = os.path.join(staging, entries[0]) if len(entries) == 1 else staging
    shutil.rmtree(target, ignore_errors=True)
    if src == staging:
        os.replace(staging, target)
    else:
        os.replace(src, target)
        shutil.rmtree(staging, ignore_errors=True)


def main():
    sdk = sdk_root()
    cache = os.path.join(sdk, ".downloads")
    os.makedirs(cache, exist_ok=True)
    log()
    log("  SDK 目录: %s" % sdk)
    for name, url, ver in COMPONENTS:
        log("  [%s]" % name)
        z = os.path.join(cache, os.path.basename(url))
        download(url, z)
        target = os.path.join(sdk, "build-tools" if name == "build-tools" else "platforms", ver)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        extract(z, target)

    bt = os.path.join(sdk, "build-tools", COMPONENTS[0][2])
    jar = os.path.join(sdk, "platforms", COMPONENTS[1][2], "android.jar")
    checks = [("aapt2.exe", os.path.join(bt, "aapt2.exe")),
              ("zipalign.exe", os.path.join(bt, "zipalign.exe")),
              ("d8.jar", os.path.join(bt, "lib", "d8.jar")),
              ("apksigner.jar", os.path.join(bt, "lib", "apksigner.jar")),
              ("android.jar", jar)]
    bad = []
    log()
    for label, p in checks:
        exists = os.path.exists(p)
        log("    %-16s %s" % (label, "OK" if exists else "缺失"))
        if not exists:
            bad.append(label)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
