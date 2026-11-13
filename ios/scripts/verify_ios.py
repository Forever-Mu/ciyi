# -*- coding: utf-8 -*-
"""
verify_ios.py —— 在没有 Xcode 的机器上，尽可能校验 iOS 工程

能做：plist 语法、YAML 语法、资源清单、网页相对路径自洽性、打包流程试跑
不能做：真正的编译（需要 macOS + Xcode）
"""
import os
import plistlib
import re
import shutil
import sys
import tempfile

# 本文件在 <repo>/ios/scripts/ 下，往上两级是仓库根
IOS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(IOS)

passes, fails = [], []


def check(name, cond, extra=""):
    (passes if cond else fails).append(name)
    print("  %s  %s%s" % ("PASS" if cond else "FAIL", name, "" if cond else "   << " + str(extra)))


def main():
    print()
    print("  ========== iOS 工程静态校验 ==========")
    print()

    # ---------- 文件齐全 ----------
    need = [
        "project.yml",
        "Resources/Info.plist",
        "Sources/AppDelegate.swift",
        "Sources/WebViewController.swift",
        "Sources/AssetSchemeHandler.swift",
        "scripts/prepare-www.sh",
    ]
    for f in need:
        check("存在 %s" % f, os.path.exists(os.path.join(IOS, f)))

    wf = os.path.join(ROOT, ".github", "workflows", "ios.yml")
    check("存在 CI 工作流 .github/workflows/ios.yml", os.path.exists(wf))
    check("存在 .gitignore", os.path.exists(os.path.join(ROOT, ".gitignore")))

    # ---------- Info.plist ----------
    plist_path = os.path.join(IOS, "Resources", "Info.plist")
    plist = None
    try:
        with open(plist_path, "rb") as f:
            plist = plistlib.load(f)
        check("Info.plist 能被解析", True)
    except Exception as e:
        check("Info.plist 能被解析", False, e)

    if plist:
        check("Info.plist 有 CFBundleIdentifier", "CFBundleIdentifier" in plist)
        check("Info.plist 有 CFBundleExecutable", "CFBundleExecutable" in plist)
        check("声明了 UILaunchScreen（iOS14+ 必需）", "UILaunchScreen" in plist)
        check("没有 Scene 清单（本项目走 AppDelegate）",
              "UIApplicationSceneManifest" not in plist)
        check("包类型是 APPL", plist.get("CFBundlePackageType") == "APPL",
              plist.get("CFBundlePackageType"))
        check("限定竖屏", plist.get("UISupportedInterfaceOrientations") ==
              ["UIInterfaceOrientationPortrait"])

    # ---------- YAML ----------
    try:
        import yaml  # noqa
        have_yaml = True
    except ImportError:
        have_yaml = False

    if have_yaml:
        import yaml
        for label, path in [("project.yml", os.path.join(IOS, "project.yml")),
                            ("ios.yml", wf)]:
            try:
                with open(path, encoding="utf-8") as f:
                    yaml.safe_load(f)
                check("%s 是合法 YAML" % label, True)
            except Exception as e:
                check("%s 是合法 YAML" % label, False, e)

        with open(os.path.join(IOS, "project.yml"), encoding="utf-8") as f:
            proj = yaml.safe_load(f)
        tgt = proj.get("targets", {}).get("CiYi", {})
        check("project.yml 定义了 CiYi target", bool(tgt))
        check("target 类型是 application", tgt.get("type") == "application")
        srcs = tgt.get("sources", [])
        paths = [s.get("path") if isinstance(s, dict) else s for s in srcs]
        check("sources 含 Sources", "Sources" in paths, paths)
        check("sources 含 www（folder reference）", "www" in paths, paths)
        www_entry = [s for s in srcs if isinstance(s, dict) and s.get("path") == "www"]
        check("www 声明为 folder 类型",
              bool(www_entry) and www_entry[0].get("type") == "folder", www_entry)
        settings = tgt.get("settings", {}).get("base", {})
        check("关闭代码签名", settings.get("CODE_SIGNING_ALLOWED") == "NO",
              settings.get("CODE_SIGNING_ALLOWED"))
        check("指定 Info.plist 路径", settings.get("INFOPLIST_FILE") == "Resources/Info.plist")
        check("关掉自动生成 Info.plist", settings.get("GENERATE_INFOPLIST_FILE") == "NO")

        with open(wf, encoding="utf-8") as f:
            wfdoc = yaml.safe_load(f)
        wf_text = open(wf, encoding="utf-8").read()
        check("CI 用 macOS runner", "macos-" in str(wfdoc.get("jobs", {}).get("build", {}).get("runs-on")))
        check("CI 安装 xcodegen", "xcodegen" in wf_text)
        check("CI 用 xcodebuild 编译", "xcodebuild" in wf_text)
        check("CI 关闭签名", "CODE_SIGNING_ALLOWED=NO" in wf_text)
        check("CI 打包 Payload 目录", "Payload" in wf_text)
        check("CI 上传 artifact", "upload-artifact" in wf_text)
    else:
        print("  -- 没有 PyYAML，跳过 YAML 校验 --")

    # ---------- Swift 源码基本检查 ----------
    src = os.path.join(IOS, "Sources")
    swift = {}
    for fn in os.listdir(src):
        if fn.endswith(".swift"):
            swift[fn] = open(os.path.join(src, fn), encoding="utf-8").read()

    check("Swift 文件数 = 3", len(swift) == 3, list(swift))
    allswift = "\n".join(swift.values())
    check("有 @main 入口", "@main" in allswift)
    check("实现 WKURLSchemeHandler", "WKURLSchemeHandler" in allswift)
    check("注册了 ciyi scheme", 'scheme = "ciyi"' in allswift)
    check("加载起始地址", "ciyi://localhost/index.html" in allswift)
    check("为 wasm 返回 application/wasm", '"application/wasm"' in allswift)
    # 注意查的是「作为响应头键名」出现，而不是注释里提到的字样
    check(".gz 走 application/gzip（不设 Content-Encoding 响应头）",
          '"application/gzip"' in allswift and '"Content-Encoding":' not in allswift)
    check("防目录穿越", '".."' in allswift)
    check("WebView 用 default data store（IndexedDB 持久化）",
          "websiteDataStore = .default()" in allswift)

    # ---------- 网页资源自洽性 ----------
    idx = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    refs = re.findall(r'(?:src|href)="([^"]+)"', idx)
    external = [r for r in refs if r.startswith(("http://", "https://"))]
    check("index.html 没有外部依赖", not external, external)
    for r in refs:
        if r.startswith(("http", "data:", "//")):
            continue
        check("index.html 引用的 %s 存在" % r, os.path.exists(os.path.join(ROOT, r)))

    appjs = open(os.path.join(ROOT, "web", "app.js"), encoding="utf-8").read()
    imports = re.findall(r"from\s+'([^']+)'", appjs)
    check("web/app.js 有模块导入", len(imports) > 0, imports)
    for imp in imports:
        target = os.path.normpath(os.path.join(ROOT, "web", imp))
        check("app.js 的导入 %s 可解析" % imp, os.path.exists(target), target)

    # core 内部互相导入
    core_dir = os.path.join(ROOT, "core")
    bad_core = []
    for fn in os.listdir(core_dir):
        if not fn.endswith(".js"):
            continue
        text = open(os.path.join(core_dir, fn), encoding="utf-8").read()
        for imp in re.findall(r"from\s+'(\.[^']+)'", text):
            target = os.path.normpath(os.path.join(core_dir, imp))
            if not os.path.exists(target):
                bad_core.append("%s -> %s" % (fn, imp))
    check("core/ 内部导入全部可解析", not bad_core, bad_core)

    # ---------- 模拟打包（prepare-www 的 Python 版）----------
    tmp = os.path.join(tempfile.gettempdir(), "ios-www-verify")
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)

    shutil.copy2(os.path.join(ROOT, "index.html"), os.path.join(tmp, "index.html"))
    for d in ("web", "core", "vendor"):
        shutil.copytree(os.path.join(ROOT, d), os.path.join(tmp, d))
    os.makedirs(os.path.join(tmp, "data"))
    for f in ("dict.json.gz", "syn.json.gz"):
        shutil.copy2(os.path.join(ROOT, "data", f), os.path.join(tmp, "data", f))

    files = []
    for root, _, fs in os.walk(tmp):
        for f in fs:
            files.append(os.path.relpath(os.path.join(root, f), tmp))

    check("打包后文件数 >= 20", len(files) >= 20, len(files))
    check("含 index.html", "index.html" in files)
    check("含 web/app.js", os.path.join("web", "app.js") in files)
    check("含 vendor/sql-wasm.wasm", os.path.join("vendor", "sql-wasm.wasm") in files)
    check("含 data/dict.json.gz", os.path.join("data", "dict.json.gz") in files)
    check("没有 csv", not any(f.endswith(".csv") for f in files))
    check("没有 _raw 目录", not any("_raw" in f for f in files))

    # 模拟 WKURLSchemeHandler 的路径解析
    for p in ("index.html", "web/app.js", "core/db.js", "vendor/sql-wasm.wasm",
              "data/dict.json.gz"):
        check("scheme handler 能解析 /%s" % p, os.path.exists(os.path.join(tmp, p.replace("/", os.sep))))

    shell = open(os.path.join(IOS, "scripts", "prepare-www.sh"), encoding="utf-8").read()
    check("prepare-www.sh 有防呆（拦 csv / _raw）", '"*.csv"' in shell or "'*.csv'" in shell or "*.csv" in shell)
    check("prepare-www.sh 会先清空 www", "rm -rf" in shell)

    shutil.rmtree(tmp, ignore_errors=True)

    # ---------- 结论 ----------
    print()
    print("  ==========================================")
    print("  通过 %d / 失败 %d" % (len(passes), len(fails)))
    if fails:
        print("  失败项：%s" % fails)
    print("  ==========================================")
    print()
    print("  ⚠ 以上只是静态校验，没有真正编译过。")
    print("    真正的验证只有一条：丢到 GitHub 上跑 macOS runner。")
    print()
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
