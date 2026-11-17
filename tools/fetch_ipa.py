# -*- coding: utf-8 -*-
"""
fetch_ipa.py —— 从 GitHub Actions 下载最新的 iOS 安装包，覆盖写到 ios/build/CiYi.ipa

用法：
    python tools/fetch_ipa.py <token_file>
    python tools/fetch_ipa.py <token_file> --run 123456789

不指定 --run 就取 main 分支最近一次成功的 "Build unsigned IPA"。
产物文件名固定为 CiYi.ipa，不带版本号、不带 unsigned 字样。

注意两个坑：
  1. artifact 的下载地址会 302 到 *.blob.core.windows.net 的签名地址，
     重定向时**不能带 Authorization 头**，否则 401。
  2. api.github.com 和 github.com 是两个域名，网络不稳时可能一个通一个不通。
"""
import io
import json
import os
import sys
import urllib.error
import urllib.request
import zipfile

REPO = "Forever-Mu/ciyi"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "ios", "build", "CiYi.ipa")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api(url, token):
    req = urllib.request.Request(url, headers={
        "User-Agent": "dsh",
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + token,
    })
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode("utf-8"))


def latest_successful_run(token):
    data = api("https://api.github.com/repos/%s/actions/runs?per_page=20" % REPO, token)
    for r in data["workflow_runs"]:
        if "IPA" in r["name"] and r["status"] == "completed" and r["conclusion"] == "success":
            return r
    return None


def main():
    if len(sys.argv) < 2:
        print("用法: python tools/fetch_ipa.py <token_file> [--run ID]")
        return 1

    token = open(sys.argv[1], encoding="ascii").read().strip()
    run_id = None
    if "--run" in sys.argv:
        run_id = sys.argv[sys.argv.index("--run") + 1]

    if run_id:
        run = api("https://api.github.com/repos/%s/actions/runs/%s" % (REPO, run_id), token)
    else:
        run = latest_successful_run(token)
        if not run:
            print("  没找到成功的构建")
            return 1

    print("  run=%s  sha=%s  %s" % (run["id"], run["head_sha"][:7], run["conclusion"]))
    if run.get("conclusion") != "success":
        print("  这个 run 没有成功，换一个")
        return 1

    arts = api("https://api.github.com/repos/%s/actions/runs/%s/artifacts" % (REPO, run["id"]), token)
    if not arts["artifacts"]:
        print("  这个 run 没有产物")
        return 1
    a = arts["artifacts"][0]
    print("  artifact: %s  %.2f MB" % (a["name"], a["size_in_bytes"] / 1048576.0))

    # 第一步：拿 302 的 Location，不跟跳转
    opener = urllib.request.build_opener(NoRedirect)
    req = urllib.request.Request(a["archive_download_url"], headers={
        "User-Agent": "dsh",
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + token,
    })
    try:
        opener.open(req, timeout=90)
        print("  意外：没有发生跳转")
        return 1
    except urllib.error.HTTPError as e:
        if e.code not in (301, 302, 303, 307, 308):
            print("  取跳转失败 HTTP %s" % e.code)
            return 1
        location = e.headers.get("Location")
    if not location:
        print("  没有 Location 头")
        return 1

    # 第二步：用签名地址下载，不带 Authorization
    req2 = urllib.request.Request(location, headers={"User-Agent": "dsh"})
    with urllib.request.urlopen(req2, timeout=300) as r:
        blob = r.read()
    print("  下载完成 %.2f MB" % (len(blob) / 1048576.0))

    z = zipfile.ZipFile(io.BytesIO(blob))
    ipa_names = [n for n in z.namelist() if n.endswith(".ipa")]
    if not ipa_names:
        print("  压缩包里没有 .ipa")
        return 1
    data = z.read(ipa_names[0])

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as f:
        f.write(data)
    print("  已覆盖 %s  %.2f MB" % (OUT, len(data) / 1048576.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
