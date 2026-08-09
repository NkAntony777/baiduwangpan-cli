#!/usr/bin/env python3
"""
bdp-tools: 百度网盘 Agent 友好工具集
依赖: BaiduPCS-Go (需已登录)
功能: 全盘搜索 + 免下载读取文件内容 (cat/head/tail/grep/peek)

原理:
  1. BaiduPCS-Go locate <path> → 获取 CDN 直链 (dlink)
  2. curl/wget + Range header → 只读取需要的字节，输出到 stdout
  3. 百度 CDN 支持 HTTP 206 Partial Content
"""

import subprocess
import sys
import os
import re
import tempfile
import argparse
import shutil

# ── 配置 ──────────────────────────────────────────────
BAIDU_PCS_CMD = os.environ.get("BAIDUPCS_CMD", "BaiduPCS-Go")
NETDISK_UA = os.environ.get(
    "NETDISK_UA",
    "netdisk;P2SP;3.0.0.8;netdisk;11.12.3;ANG-AN00;android-android;10.0;JSbridge4.4.0;jointBridge;1.1.0;",
)
# 读取 cat 时的最大字节数 (1MB)，防止误读超大文件
MAX_CAT_BYTES = int(os.environ.get("BDP_MAX_CAT_BYTES", 1048576))
# head/tail 默认行数
DEFAULT_LINES = 20
# ──────────────────────────────────────────────────────


def run_pcs(args: list[str]) -> str:
    """执行 BaiduPCS-Go 命令并返回输出"""
    cmd = [BAIDU_PCS_CMD] + args
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0 and result.stderr:
        print(f"[ERROR] {result.stderr.strip()}", file=sys.stderr)
    return result.stdout


def get_dlink(remote_path: str) -> str | None:
    """通过 BaiduPCS-Go locate 获取文件直链"""
    output = run_pcs(["locate", remote_path])
    # locate 输出包含 URL 行
    for line in output.strip().split("\n"):
        line = line.strip()
        if line.startswith("http") and "baidupcs" in line or "baidu" in line:
            return line
    # 尝试另一种输出格式 (可能直接输出URL)
    urls = re.findall(r"https?://\S+baidupcs\.com/\S+", output)
    if urls:
        return urls[0]
    urls = re.findall(r"https?://\S+baidu\.com/\S+", output)
    if urls:
        return urls[0]
    return None


def get_file_size(remote_path: str) -> int | None:
    """通过 BaiduPCS-Go meta 获取文件大小"""
    output = run_pcs(["meta", remote_path])
    match = re.search(r"大小:\s*([\d,]+)\s*字节?", output)
    if match:
        return int(match.group(1).replace(",", ""))
    match = re.search(r"size[\":\s]+(\d+)", output)
    if match:
        return int(match.group(1))
    return None


def fetch_range(url: str, start: int = 0, end: int | None = None) -> bytes:
    """用 curl + Range 请求获取部分内容"""
    if end is not None:
        range_header = f"bytes={start}-{end}"
    else:
        range_header = f"bytes={start}-"

    curl_path = shutil.which("curl")
    if not curl_path:
        # Windows 上尝试常见路径
        curl_path = shutil.which("curl.exe")
    if not curl_path:
        print("[ERROR] curl not found. Please install curl.", file=sys.stderr)
        sys.exit(1)

    cmd = [
        curl_path,
        "-s",                   # silent
        "-L",                   # follow redirects (d.pcs.baidu.com → CDN)
        "-r", f"{start}-{end if end is not None else ''}",
        "-H", f"User-Agent: {NETDISK_UA}",
        "-H", f"Range: {range_header}",
        "--max-time", "30",
        url,
    ]

    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace")
        print(f"[ERROR] curl failed: {stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    return result.stdout


def decode_text(data: bytes) -> str:
    """尝试多种编码解码"""
    for enc in ["utf-8", "gbk", "gb2312", "latin-1"]:
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", errors="replace")


# ── 命令实现 ───────────────────────────────────────────

def cmd_cat(args):
    """读取整个文件内容 (限制 MAX_CAT_BYTES)"""
    size = get_file_size(args.path)
    if size and size > 50 * 1024 * 1024:
        print(f"[WARN] File is {size // 1024 // 1024}MB, truncating to {MAX_CAT_BYTES // 1024}KB", file=sys.stderr)

    dlink = get_dlink(args.path)
    if not dlink:
        print(f"[ERROR] Cannot get dlink for: {args.path}", file=sys.stderr)
        sys.exit(1)

    read_bytes = min(size or MAX_CAT_BYTES, MAX_CAT_BYTES) - 1
    data = fetch_range(dlink, 0, read_bytes)
    text = decode_text(data)

    if args.number:
        for i, line in enumerate(text.split("\n"), 1):
            print(f"     {i}  {line}")
    else:
        print(text, end="")


def cmd_head(args):
    """读取文件前 N 行"""
    dlink = get_dlink(args.path)
    if not dlink:
        print(f"[ERROR] Cannot get dlink for: {args.path}", file=sys.stderr)
        sys.exit(1)

    n = args.lines
    chunk_size = min(n * 4096 + 1024, MAX_CAT_BYTES)  # 估算读取量
    data = fetch_range(dlink, 0, chunk_size - 1)
    text = decode_text(data)
    lines = text.split("\n")

    for line in lines[:n]:
        print(line)


def cmd_tail(args):
    """读取文件后 N 行"""
    size = get_file_size(args.path)
    if not size:
        print(f"[ERROR] Cannot get file size for: {args.path}", file=sys.stderr)
        sys.exit(1)

    dlink = get_dlink(args.path)
    if not dlink:
        print(f"[ERROR] Cannot get dlink for: {args.path}", file=sys.stderr)
        sys.exit(1)

    n = args.lines
    chunk_size = min(n * 4096 + 1024, MAX_CAT_BYTES, size)
    start = max(0, size - chunk_size)
    data = fetch_range(dlink, start, size - 1)
    text = decode_text(data)
    lines = text.split("\n")

    for line in lines[-n:]:
        print(line)


def cmd_grep(args):
    """在文件内容中搜索关键词"""
    dlink = get_dlink(args.path)
    if not dlink:
        print(f"[ERROR] Cannot get dlink for: {args.path}", file=sys.stderr)
        sys.exit(1)

    data = fetch_range(dlink, 0, MAX_CAT_BYTES - 1)
    text = decode_text(data)

    pattern = re.compile(args.pattern, re.IGNORECASE if args.ignore_case else 0)
    for i, line in enumerate(text.split("\n"), 1):
        if pattern.search(line):
            if args.line_number:
                print(f"{args.path}:{i}:{line}")
            else:
                print(line)


def cmd_peek(args):
    """预览文件信息: 大小、前几行、文件类型判断"""
    size = get_file_size(args.path)
    dlink = get_dlink(args.path)

    print(f"Path:   {args.path}")
    print(f"Size:   {size:,} bytes ({(size or 0) / 1024:.1f} KB)" if size else "Size:   unknown")
    print(f"Dlink:  {'✅ available' if dlink else '❌ not available'}")

    if dlink:
        preview_bytes = min(512, size or 512) - 1
        data = fetch_range(dlink, 0, preview_bytes)
        text = decode_text(data)

        is_binary = any(b < 9 or (13 < b < 32) for b in data[:200])
        if is_binary:
            print("Type:   Binary file (preview skipped)")
        else:
            preview_lines = text.split("\n")[:10]
            print(f"\n── Preview (first {len(preview_lines)} lines) ──")
            for line in preview_lines:
                print(line)


def cmd_search(args):
    """全盘搜索文件 (直接调用 BaiduPCS-Go search)"""
    output = run_pcs(["search", "-path=" + args.path, "-r", args.keyword])
    print(output, end="")


def cmd_ls(args):
    """列出目录 (直接调用 BaiduPCS-Go ls)"""
    output = run_pcs(["ls", args.path])
    print(output, end="")


def cmd_download(args):
    """下载文件到临时目录并输出路径 (agent 友好)"""
    tmpdir = tempfile.mkdtemp(prefix="bdp_")
    output = run_pcs(["d", args.path, "--saveto", tmpdir])
    # 找到下载的文件
    files = os.listdir(tmpdir)
    if files:
        local_path = os.path.join(tmpdir, files[0])
        print(local_path)
    else:
        print(f"[ERROR] Download failed", file=sys.stderr)
        sys.exit(1)


# ── CLI ────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        prog="bdp",
        description="百度网盘 Agent 友好工具 - 免下载读取文件内容",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  bdp search -k "报告"              # 全盘搜索文件名
  bdp ls /                          # 列出根目录
  bdp cat /文档/报告.txt            # 读取文件内容 (不下载)
  bdp head -n 50 /文档/日志.log     # 读取前50行
  bdp tail -n 30 /文档/日志.log     # 读取后30行
  bdp grep "错误" /文档/日志.log    # 在文件中搜索关键词
  bdp peek /文档/report.pdf         # 预览文件信息
  bdp get /文档/data.json           # 下载文件，输出本地路径
        """,
    )
    sub = parser.add_subparsers(dest="command", help="命令")

    # search
    p = sub.add_parser("search", help="全盘搜索文件名")
    p.add_argument("-k", "--keyword", required=True, help="搜索关键词")
    p.add_argument("-p", "--path", default="/", help="搜索目录 (默认 /)")
    p.set_defaults(func=cmd_search)

    # ls
    p = sub.add_parser("ls", help="列出目录")
    p.add_argument("path", nargs="?", default="/", help="目录路径")
    p.set_defaults(func=cmd_ls)

    # cat
    p = sub.add_parser("cat", help="读取文件内容 (不下载, 限1MB)")
    p.add_argument("path", help="网盘文件路径")
    p.add_argument("-n", "--number", action="store_true", help="显示行号")
    p.set_defaults(func=cmd_cat)

    # head
    p = sub.add_parser("head", help="读取文件前 N 行")
    p.add_argument("path", help="网盘文件路径")
    p.add_argument("-n", "--lines", type=int, default=DEFAULT_LINES, help=f"行数 (默认 {DEFAULT_LINES})")
    p.set_defaults(func=cmd_head)

    # tail
    p = sub.add_parser("tail", help="读取文件后 N 行")
    p.add_argument("path", help="网盘文件路径")
    p.add_argument("-n", "--lines", type=int, default=DEFAULT_LINES, help=f"行数 (默认 {DEFAULT_LINES})")
    p.set_defaults(func=cmd_tail)

    # grep
    p = sub.add_parser("grep", help="在文件内容中搜索关键词")
    p.add_argument("pattern", help="正则表达式")
    p.add_argument("path", help="网盘文件路径")
    p.add_argument("-i", "--ignore-case", action="store_true", help="忽略大小写")
    p.add_argument("-n", "--line-number", action="store_true", help="显示行号")
    p.set_defaults(func=cmd_grep)

    # peek
    p = sub.add_parser("peek", help="预览文件信息")
    p.add_argument("path", help="网盘文件路径")
    p.set_defaults(func=cmd_peek)

    # get (download)
    p = sub.add_parser("get", help="下载文件到临时目录, 输出本地路径")
    p.add_argument("path", help="网盘文件路径")
    p.set_defaults(func=cmd_download)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(0)

    args.func(args)


if __name__ == "__main__":
    main()
