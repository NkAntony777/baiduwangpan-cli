#!/usr/bin/env python3
"""构建 baiduwangpan-skill.zip —— 把 skills/baiduwangpan 打包成可分发的 skill 包。

用法（仓库根目录）：
    python scripts/build-skill-zip.py

产物：baiduwangpan-skill.zip（仓库根目录，已被 .gitignore 的 *.zip 规则
豁免——用 git add -f 强制跟踪）。
"""
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "skills", "baiduwangpan")
OUT = os.path.join(ROOT, "baiduwangpan-skill.zip")
PREFIX = "baiduwangpan"

# 固定顺序，保证构建可复现
ORDER = [
    "README.md",
    "SKILL.md",
    "reference/authentication.md",
    "reference/commands.md",
    "reference/examples.md",
    "reference/troubleshooting.md",
    "scripts/setup.ps1",
    "scripts/setup.sh",
]


def collect():
    files = []
    for rel in ORDER:
        p = os.path.join(SRC, rel.replace("/", os.sep))
        if not os.path.isfile(p):
            print("SKIP (missing): %s" % rel, file=sys.stderr)
            continue
        files.append(rel)
    # 兜底：把 ORDER 之外的新文件也带上（避免新增文档忘记打包）
    known = set(ORDER)
    for dirpath, _dirnames, filenames in os.walk(SRC):
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, SRC).replace(os.sep, "/")
            if rel not in known:
                files.append(rel)
                print("+ extra file: %s" % rel)
    return files


def main():
    files = collect()
    if os.path.exists(OUT):
        os.remove(OUT)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        # 目录条目（与历史构建保持一致）
        z.writestr(PREFIX + "/", "")
        z.writestr(PREFIX + "/reference/", "")
        z.writestr(PREFIX + "/scripts/", "")
        for rel in files:
            z.write(os.path.join(SRC, rel.replace("/", os.sep)), PREFIX + "/" + rel)
    size = os.path.getsize(OUT)
    print("built %s (%d files, %d bytes)" % (OUT, len(files), size))


if __name__ == "__main__":
    main()
