# -*- coding: utf-8 -*-
"""
prepare.py — 下载第三方库并构建离线英汉词典子集

产物：
  vendor/sql-wasm.js, vendor/sql-wasm.wasm   SQLite(WASM) 引擎
  vendor/fflate.js                           解压 docx 用
  data/dict.json.gz                          离线英汉词典子集（ECDICT）

ECDICT 是开源(MIT)英汉词典数据集：https://github.com/skywind3000/ECDICT
完整版 66MB / 约 77 万词条，塞不进 APK，因此按「常用度」筛选出子集。
"""
import csv
import gzip
import io
import json
import os
import re
import sys
import urllib.request

ROOT = r"D:\personal\学习\英文单词记忆"
VENDOR = os.path.join(ROOT, "vendor")
DATA = os.path.join(ROOT, "data")
RAW = os.path.join(DATA, "_raw")

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36"

VENDOR_FILES = [
    ("https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/sql-wasm.js", "sql-wasm.js"),
    ("https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/sql-wasm.wasm", "sql-wasm.wasm"),
    ("https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js", "fflate.js"),
]

ECDICT_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv"


def log(s=""):
    try:
        print(s, flush=True)
    except Exception:
        pass


def download(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        log("    已存在，跳过：%s" % os.path.basename(dest))
        return
    tmp = dest + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = r.read(1024 * 512)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if total and done % (8 * 1024 * 1024) < 512 * 1024:
                log("    %s  %d%%  (%.0f/%.0f MB)" % (
                    os.path.basename(dest), done * 100 // total,
                    done / 1048576.0, total / 1048576.0))
    os.replace(tmp, dest)
    log("    完成：%s  %.1f MB" % (os.path.basename(dest), os.path.getsize(dest) / 1048576.0))


# ---------------------------------------------------------------- 词性抽取
POS_PATTERNS = [
    ("n", r"\bn\.|名词"),
    ("v", r"\bv\.|vt\.|vi\.|动词"),
    ("adj", r"\badj\.|a\.|形容词"),
    ("adv", r"\badv\.|副词"),
    ("prep", r"\bprep\.|介词"),
    ("conj", r"\bconj\.|连词"),
    ("pron", r"\bpron\.|代词"),
    ("num", r"\bnum\.|数词"),
    ("art", r"\bart\.|冠词"),
    ("int", r"\bint\.|感叹词"),
]


def extract_pos(translation):
    """从中文释义文本里推断词性（ECDICT 的 pos 字段是数字编码，不可靠）"""
    found = []
    for code, pat in POS_PATTERNS:
        if re.search(pat, translation):
            found.append(code)
    return found


def clean_translation(t):
    """把长释义压成一行，去掉 [网络]/[医]/[化] 这类专业标注，保留核心词义"""
    if not t:
        return ""
    t = t.replace("\\n", "\n")
    out = []
    for line in t.split("\n"):
        line = line.strip()
        if not line:
            continue
        # 跳过「[网络]」「[医]」等次要标注行，除非没有别的内容
        if re.match(r"^\[[^\]]{1,6}\]", line):
            continue
        out.append(line)
    if not out:
        out = [t.split("\n")[0].strip()]
    s = "；".join(out)
    s = re.sub(r"\s+", " ", s)
    return s[:220]


def build_dict():
    src = os.path.join(RAW, "ecdict.csv")
    if not os.path.exists(src):
        log("  [错误] 找不到 %s" % src)
        return 1

    log("  解析 ECDICT ...")
    entries = {}
    total = 0
    kept = 0

    with open(src, "r", encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            total += 1
            word = (row.get("word") or "").strip()
            if not word or len(word) > 32:
                continue
            # 只保留单个英文单词（含连字符/撇号），过滤短语和词根标记
            if not re.match(r"^[A-Za-z][A-Za-z'\-]*$", word):
                continue
            trans = clean_translation(row.get("translation") or "")
            if not trans:
                continue

            collins = row.get("collins") or "0"
            oxford = row.get("oxford") or "0"
            tag = (row.get("tag") or "").strip()
            try:
                frq = int(row.get("frq") or 0)
                bnc = int(row.get("bnc") or 0)
                col = int(collins or 0)
            except ValueError:
                frq = bnc = col = 0

            important = bool(tag) or col > 0 or oxford == "1" or frq > 0 or bnc > 0
            if not important:
                continue

            key = word.lower()
            phonetic = (row.get("phonetic") or "").strip()
            pos = extract_pos(trans)
            prev = entries.get(key)
            if prev:
                # 同一词再次出现：合并词性，保留信息更全的释义
                for p in pos:
                    if p not in prev[2]:
                        prev[2].append(p)
                if len(trans) > len(prev[1]) and not phonetic:
                    pass
                continue
            entries[key] = [phonetic, trans, pos]
            kept += 1

    log("    读入 %d 行，保留 %d 个词条" % (total, kept))

    out = {}
    for w, (ph, tr, pos) in entries.items():
        rec = [ph, tr]
        if pos:
            rec.append(pos)
        out[w] = rec

    raw_json = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    log("    未压缩 JSON：%.1f MB" % (len(raw_json.encode("utf-8")) / 1048576.0))

    dst = os.path.join(DATA, "dict.json.gz")
    with gzip.open(dst, "wb", compresslevel=9) as g:
        g.write(raw_json.encode("utf-8"))
    log("    -> data/dict.json.gz  %.1f MB (gzip)" % (os.path.getsize(dst) / 1048576.0))

    # 抽查
    log("  抽查：")
    for w in ["abandon", "accurate", "charge", "apple", "achieve"]:
        if w in out:
            log("    %-10s %s" % (w, str(out[w])[:96]))
        else:
            log("    %-10s 未收录" % w)
    return 0


def main():
    for d in (VENDOR, DATA, RAW):
        os.makedirs(d, exist_ok=True)

    log()
    log("  1) 下载运行库")
    for url, name in VENDOR_FILES:
        download(url, os.path.join(VENDOR, name))

    log()
    log("  2) 下载 ECDICT 全量词典（66MB，仅首次）")
    download(ECDICT_URL, os.path.join(RAW, "ecdict.csv"))

    log()
    log("  3) 构建离线词典子集")
    return build_dict()


if __name__ == "__main__":
    sys.exit(main())
