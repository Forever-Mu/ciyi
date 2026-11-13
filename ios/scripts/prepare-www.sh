#!/bin/bash
# prepare-www.sh —— 把网页资源复制进 ios/www，供 Xcode 作为 folder reference 打进 .app
#
# 只复制运行必需的文件，不要把 data/_raw（63MB 原始 ECDICT csv）和 test/ 带进去。

set -euo pipefail

IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$IOS_DIR/.." && pwd)"
WWW="$IOS_DIR/www"

echo "  仓库根目录: $REPO_ROOT"
echo "  输出目录  : $WWW"

rm -rf "$WWW"
mkdir -p "$WWW"

# 单个文件
for f in index.html; do
  if [ ! -f "$REPO_ROOT/$f" ]; then
    echo "  缺少 $f" >&2
    exit 1
  fi
  cp "$REPO_ROOT/$f" "$WWW/"
  echo "    + $f"
done

# 整个目录
for d in web core vendor; do
  if [ ! -d "$REPO_ROOT/$d" ]; then
    echo "  缺少目录 $d" >&2
    exit 1
  fi
  cp -R "$REPO_ROOT/$d" "$WWW/"
  echo "    + $d/  ($(find "$WWW/$d" -type f | wc -l | tr -d ' ') 个文件)"
done

# data/ 只取两个成品
mkdir -p "$WWW/data"
for f in dict.json.gz syn.json.gz; do
  if [ ! -f "$REPO_ROOT/data/$f" ]; then
    echo "  缺少 data/$f" >&2
    exit 1
  fi
  cp "$REPO_ROOT/data/$f" "$WWW/data/"
  echo "    + data/$f"
done

# 防呆：不许把原始数据、测试、构建脚本带进包
BAD="$(find "$WWW" \( -name '*.csv' -o -path '*/_raw/*' -o -path '*/test/*' \) -print 2>/dev/null || true)"
if [ -n "$BAD" ]; then
  echo "  [失败] www 里混进了不该打包的东西：" >&2
  echo "$BAD" >&2
  exit 1
fi

TOTAL=$(find "$WWW" -type f | wc -l | tr -d ' ')
SIZE=$(du -sh "$WWW" | cut -f1)
echo "  完成：$TOTAL 个文件，共 $SIZE"
