# -*- coding: utf-8 -*-
"""
build_syn.py —— 从 ECDICT 自身推导中文近义词表

问题：判断「英译中」是否准确时，纯字符重叠解决不了同义改写。
      例如 achieve 词典给的是「完成/达到」，而用户写「实现」——
      字符零重叠，会被误判成错译。

办法：用英汉对应关系反推中文近义。
      若两个中文义项被多个相同的英文单词共用（如 accomplish 同时译作
      「完成」和「实现」），它们在这个语料里就互为近义。

产物：data/syn.json.gz   { 中文义项: [近义义项...] }
"""
import csv
import gzip
import json
import os
import re
import sys

ROOT = r"D:\personal\学习\英文单词记忆"
DATA = os.path.join(ROOT, "data")
SRC = os.path.join(DATA, "_raw", "ecdict.csv")

MAX_ATOM_LEN = 8        # 只保留短义项，长句不适合做同义判断
MIN_COOC = 2            # 至少被 2 个英文词共用才算近义
TOP_PER_ATOM = 6        # 每个义项最多保留几个近义


def split_atoms(translation):
    if not translation:
        return []
    t = translation.replace("\\n", "\n").replace("\r", "")
    parts = re.split(r"[;；\n]", t)
    atoms = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        p = re.sub(r"^\[[^\]]{0,8}\]", "", p).strip()
        if not p:
            continue
        for a in re.split(r"[,，、]", p):
            a = a.strip()
            a = re.sub(r"^(vt|vi|v|n|adj|adv|prep|conj|pron|num|art|int|a)\.?\s*", "", a, flags=re.I)
            a = a.strip()
            if not a or len(a) > MAX_ATOM_LEN:
                continue
            if not re.search(r"[\u4e00-\u9fff]", a):
                continue
            atoms.append(a)
    # 去重保序
    seen = set()
    out = []
    for a in atoms:
        if a not in seen:
            seen.add(a)
            out.append(a)
    return out


def main():
    if not os.path.exists(SRC):
        print("找不到 %s，请先运行 prepare.py" % SRC)
        return 1

    print("  扫描 ECDICT 建立中文义项共现 ...")
    cooc = {}          # (a,b) -> count  (a<b 字典序)
    word_atoms = 0
    total = 0

    with open(SRC, "r", encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            total += 1
            atoms = split_atoms(row.get("translation") or "")
            if len(atoms) < 2:
                continue
            word_atoms += 1
            n = len(atoms)
            for i in range(n):
                for j in range(i + 1, n):
                    a, b = atoms[i], atoms[j]
                    if a == b:
                        continue
                    key = (a, b) if a < b else (b, a)
                    cooc[key] = cooc.get(key, 0) + 1

    print("    读入 %d 行，其中 %d 个词含多个义项" % (total, word_atoms))
    print("    共现对不同义项 %d 个" % len(cooc))

    # 过滤低共现
    kept = {k: v for k, v in cooc.items() if v >= MIN_COOC}
    print("    共现 >=%d 的近义对：%d" % (MIN_COOC, len(kept)))

    # 每个义项保留 top-N 近义
    bucket = {}
    for (a, b), c in kept.items():
        bucket.setdefault(a, []).append((b, c))
        bucket.setdefault(b, []).append((a, c))

    syn = {}
    for atom, lst in bucket.items():
        lst.sort(key=lambda x: -x[1])
        syn[atom] = [w for w, _ in lst[:TOP_PER_ATOM]]

    raw = json.dumps(syn, ensure_ascii=False, separators=(",", ":"))
    dst = os.path.join(DATA, "syn.json.gz")
    with gzip.open(dst, "wb", compresslevel=9) as g:
        g.write(raw.encode("utf-8"))

    print("    义项数 %d" % len(syn))
    print("    未压缩 %.1f MB -> %s %.1f MB" %
          (len(raw.encode("utf-8")) / 1048576.0, os.path.basename(dst),
           os.path.getsize(dst) / 1048576.0))

    # 抽查关键用例
    print("  抽查：")
    for w in ["实现", "完成", "准确的", "正确的", "充电", "收费", "放弃"]:
        print("    %-6s -> %s" % (w, "、".join(syn.get(w, []))[:60] or "（无）"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
