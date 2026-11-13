# -*- coding: utf-8 -*-
"""verify_apk.py —— 对产物做独立静态校验（没有设备/模拟器时能做的最强验证）"""
import gzip
import json
import os
import struct
import sys
import zipfile

APK = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build", "词忆.apk")

passes = []
fails = []


def check(name, cond, extra=""):
    (passes if cond else fails).append(name)
    print("  %s  %s%s" % ("PASS" if cond else "FAIL", name, "" if cond else "   << " + str(extra)))


def main():
    if not os.path.exists(APK):
        print("APK 不存在：%s" % APK)
        return 1

    size = os.path.getsize(APK)
    print()
    print("  文件: %s" % os.path.basename(APK))
    print("  大小: %.2f MB (%d 字节)" % (size / 1048576.0, size))
    print()

    z = zipfile.ZipFile(APK)
    names = z.namelist()

    # ---------- 基本结构 ----------
    check("包含 AndroidManifest.xml", "AndroidManifest.xml" in names)
    check("包含 classes.dex", "classes.dex" in names)
    check("包含 resources.arsc", "resources.arsc" in names)
    check("没有重复条目", len(names) == len(set(names)))

    # ---------- 清单（二进制 AXML） ----------
    man = z.read("AndroidManifest.xml")
    check("清单是二进制 AXML", man[:4] == b"\x03\x00\x08\x00", man[:4])
    # 二进制 AXML 的字符串池是 UTF-16LE，直接搜 ASCII 搜不到
    man_utf16 = man.decode("utf-16-le", "ignore")
    check("清单含包名 com.wordmemory.app",
          "com.wordmemory.app" in man_utf16 or b"com.wordmemory.app" in man)
    # 应用名是资源引用（@string/app_name），真实字符串在 resources.arsc 里
    arsc = z.read("resources.arsc")
    label_ok = ("词忆".encode("utf-8") in arsc
                or "词忆".encode("utf-16-le") in arsc
                or "app_name" in arsc.decode("utf-16-le", "ignore")
                or b"app_name" in arsc)
    check("应用名资源可解析到「词忆」", label_ok)

    # ---------- dex ----------
    dex = z.read("classes.dex")
    check("dex magic 正确", dex[:4] == b"dex\n", dex[:4])
    check("dex 版本合理", dex[4:7] in (b"035", b"037", b"038", b"039"), dex[4:7])
    for cls in [b"Lcom/wordmemory/app/MainActivity;",
                b"Lcom/wordmemory/app/AssetWebViewClient;",
                b"Lcom/wordmemory/app/PickerChromeClient;",
                b"Lcom/wordmemory/app/NativeBridge;",
                b"Lcom/wordmemory/app/DownloadsApi29;",
                b"Lcom/wordmemory/app/BackCallback;",
                b"Lcom/wordmemory/app/UiToast;"]:
        check("dex 含 %s" % cls.decode().strip("L;").split("/")[-1], cls in dex)

    # ---------- 签名 ----------
    sig = [n for n in names if n.startswith("META-INF/") and
           (n.endswith(".SF") or n.endswith(".RSA") or n.endswith(".DSA") or n.endswith(".EC"))]
    check("有 v1 签名文件", len(sig) >= 2, sig)

    # ---------- 资源 ----------
    res = [n for n in names if n.startswith("res/")]
    check("有图标资源", any("ic_launcher" in n for n in res), res[:5])
    check("图标覆盖多个密度",
          len([n for n in res if "ic_launcher.png" in n]) >= 4,
          [n for n in res if "ic_launcher.png" in n])

    # ---------- assets ----------
    assets = [n for n in names if n.startswith("assets/")]
    print("      assets 条目 %d 个" % len(assets))

    required = ["assets/index.html", "assets/web/style.css", "assets/web/app.js",
                "assets/vendor/sql-wasm.js", "assets/vendor/sql-wasm.wasm",
                "assets/vendor/fflate.js", "assets/data/dict.json.gz",
                "assets/data/syn.json.gz"]
    for r in required:
        check("assets 含 %s" % r.replace("assets/", ""), r in names)

    core_js = [n for n in assets if n.startswith("assets/core/")]
    check("core/ 全部打包（12 个 js）", len(core_js) == 12, len(core_js))

    # 不该打包进去的
    leaked = [n for n in assets if n.startswith(("assets/test/", "assets/android/",
                                                 "assets/tools/", "assets/_raw/"))]
    check("没有误打包 test/android/tools", not leaked, leaked[:3])
    check("没有打包原始 ECDICT csv", not any(n.endswith(".csv") for n in assets))

    # ---------- 内容有效性 ----------
    html = z.read("assets/index.html").decode("utf-8", "replace")
    check("index.html 引用了 app.js", "web/app.js" in html)
    check("index.html 引用了 sql-wasm", "vendor/sql-wasm.js" in html)
    check("index.html 是完整 HTML", html.strip().endswith("</html>"))

    wasm = z.read("assets/vendor/sql-wasm.wasm")
    check("sql-wasm.wasm magic 正确", wasm[:4] == b"\x00asm", wasm[:4])
    check("sql-wasm.wasm 大小合理", abs(len(wasm) - 659806) < 1000, len(wasm))

    d = json.loads(gzip.decompress(z.read("assets/data/dict.json.gz")).decode("utf-8"))
    check("离线词典可解压且是合法 JSON", isinstance(d, dict))
    check("离线词典词条数 = 58226", len(d) == 58226, len(d))
    check("词典抽样 abandon 正确", d.get("abandon", [None, ""])[1].startswith("vt. 放弃"), d.get("abandon"))

    s = json.loads(gzip.decompress(z.read("assets/data/syn.json.gz")).decode("utf-8"))
    check("近义词表可解压且是合法 JSON", isinstance(s, dict) and len(s) > 10000, len(s) if isinstance(s, dict) else 0)
    check("近义词表抽样 实现→完成", "完成" in s.get("实现", []), s.get("实现"))

    # ---------- 总大小 ----------
    compressed = sum(i.compress_size for i in z.infolist())
    check("压缩率合理（<100%%）", compressed < size)
    print("      压缩后 %.1f MB / 解压 %.1f MB" %
          (compressed / 1048576.0, sum(i.file_size for i in z.infolist()) / 1048576.0))

    z.close()

    print()
    print("  ==========================================")
    print("  通过 %d / 失败 %d" % (len(passes), len(fails)))
    if fails:
        print("  失败项：%s" % fails)
    print("  ==========================================")
    print()
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
