/**
 * bdp-group.js — 百度网盘群聊文件工具（逆向 mbox API）
 *
 * 已验证可用的完整 API 链路:
 *   1. /mbox/group/list          → 获取所有群组
 *   2. /mbox/group/listshare     → 获取群内分享库（顶层目录）
 *   3. /mbox/msg/shareinfo       → 递归浏览分享库内容（文件/目录）
 *   4. /api/sharedownload        → 直接获取群文件下载直链（sign 留空即可，免转存）
 *
 * 注：/mbox/msg/transfer 转存接口参数虽已逆向（from_uk/msg_id/path/ondup/async/type/gid/fs_ids），
 *     但 2026-08 起百度已拒绝群文件转存（非空目录一律 errno=-10，UI 入口也已移除）。
 *     请用 bdp gdownload 直接下载群文件。
 *
 * 用法:
 *   node bdp-group.js groups                  列出所有群组
 *   node bdp-group.js shares <gid>            列出群内分享库
 *   node bdp-group.js ls <gid> <fs_id>        浏览分享库内容
 *   node bdp-group.js search <gid> <keyword>  搜索群文件名
 *
 * 环境变量:
 *   BDP_BDUSS   — 百度网盘 BDUSS cookie 值（必填）
 *   BDP_STOKEN  — 百度网盘 STOKEN cookie 值（必填）
 *   BDP_BDSTOKEN — bdstoken（可选，自动获取）
 */

const https = require("https");
const { spawnSync } = require("child_process");

const BDUSS = process.env.BDP_BDUSS || "";
const STOKEN = process.env.BDP_STOKEN || "";
const APP_ID = "250528";

let _bdstoken = null;

function httpGet(url) {
  const result = spawnSync("curl", [
    "-s", "-L",
    "-H", `Cookie: BDUSS=${BDUSS}; STOKEN=${STOKEN}`,
    "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "-H", "Referer: https://pan.baidu.com/disk/main",
    "--max-time", "30",
    url,
  ], { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });
  return result.stdout || "";
}

function httpPost(url, body) {
  const result = spawnSync("curl", [
    "-s", "-L", "-X", "POST",
    "-H", `Cookie: BDUSS=${BDUSS}; STOKEN=${STOKEN}`,
    "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "-H", "Referer: https://pan.baidu.com/disk/main",
    "-H", "Content-Type: application/x-www-form-urlencoded",
    "--max-time", "30",
    "-d", body || "",
    url,
  ], { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });
  return result.stdout || "";
}

async function getBdstoken() {
  if (_bdstoken) return _bdstoken;
  const text = httpGet(
    `https://pan.baidu.com/api/gettemplatevariable?clienttype=0&app_id=${APP_ID}&web=1&fields=["bdstoken","token","uk","isdocuser","servertime"]`
  );
  try {
    const data = JSON.parse(text);
    _bdstoken = data?.result?.bdstoken;
  } catch {}
  return _bdstoken;
}

// ── API 函数 ──────────────────────────────────────────

async function getGroupList() {
  const bdstoken = await getBdstoken();
  const text = httpGet(
    `https://pan.baidu.com/mbox/group/list?clienttype=0&app_id=${APP_ID}&web=1&bdstoken=${bdstoken}`
  );
  return JSON.parse(text);
}

async function getGroupShares(gid) {
  const bdstoken = await getBdstoken();
  const text = httpPost(
    `https://pan.baidu.com/mbox/group/listshare?clienttype=0&app_id=${APP_ID}&web=1&type=2&gid=${gid}&limit=50&desc=1&bdstoken=${bdstoken}`,
    ""
  );
  // 清理可能的换行前缀
  const cleaned = text.replace(/^\s+/, "");
  return JSON.parse(cleaned);
}

async function getShareInfo(gid, fromUk, msgId, fsId, page = 1) {
  const bdstoken = await getBdstoken();
  const url = `https://pan.baidu.com/mbox/msg/shareinfo?type=2&from_uk=${fromUk}&msg_id=${msgId}&to_uk=0&num=100&page=${page}&fs_id=${fsId}&gid=${gid}&clienttype=0&app_id=${APP_ID}&web=1&bdstoken=${bdstoken}`;
  const text = httpPost(url, "");
  const cleaned = text.replace(/^\s+/, "");
  return JSON.parse(cleaned);
}

async function searchGroupFiles(gid, keyword, maxDepth = 3) {
  // 先获取群内所有分享库
  const shares = await getGroupShares(gid);
  const results = [];

  if (!shares.records || !shares.records.msg_list) return results;

  // 遍历每个分享
  for (const share of shares.records.msg_list) {
    const fromUk = share.uk;
    const msgId = share.msg_id;
    const topFiles = share.file_list || [];

    for (const topFile of topFiles) {
      const fsId = topFile.fs_id;
      const topName = decodeURIComponent(topFile.path || topFile.server_filename || "");

      // 检查顶层名称是否匹配
      if (topName.toLowerCase().includes(keyword.toLowerCase())) {
        results.push({
          name: topName,
          path: topName,
          isDir: topFile.isdir === "1",
          size: parseInt(topFile.size || "0"),
          fs_id: fsId,
        });
      }

      // 递归搜索第一层子目录
      if (topFile.isdir === "1" && maxDepth > 0) {
        try {
          const info = await getShareInfo(gid, fromUk, msgId, fsId, 1);
          if (info.records && Array.isArray(info.records)) {
            for (const f of info.records) {
              const name = f.server_filename || "";
              const path = decodeURIComponent(f.path || "");

              if (name.toLowerCase().includes(keyword.toLowerCase())) {
                results.push({
                  name: name,
                  path: path,
                  isDir: f.isdir === 1 || f.isdir === "1",
                  size: parseInt(f.size || "0"),
                  fs_id: f.fs_id,
                });
              }
            }
          }
        } catch (e) {}
      }
    }
  }

  return results;
}

// ── 格式化 ────────────────────────────────────────────

function formatSize(bytes) {
  if (bytes === 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

// ── CLI ────────────────────────────────────────────────

async function main() {
  if (!BDUSS || !STOKEN) {
    console.error("[ERROR] Set BDP_BDUSS and BDP_STOKEN env vars");
    console.error("        Example: set BDP_BDUSS=your_bduss_value");
    console.error("                 set BDP_STOKEN=your_stoken_value");
    process.exit(1);
  }

  const cmd = process.argv[2];

  switch (cmd) {
    case "groups": {
      const data = await getGroupList();
      if (data.records) {
        console.log(`Found ${data.records.length} groups:\n`);
        data.records.forEach((g, i) => {
          console.log(`  [${i}] ${g.name}`);
          console.log(`      gid: ${g.gid}`);
        });
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
      break;
    }

    case "shares": {
      const gid = process.argv[3];
      if (!gid) { console.error("Usage: shares <gid>"); process.exit(1); }
      const data = await getGroupShares(gid);
      if (data.errno === 0 && data.records && data.records.msg_list) {
        console.log(`Group ${gid} has ${data.records.msg_count} shares:\n`);
        for (const share of data.records.msg_list) {
          console.log(`  Share by: ${share.uname} (uk: ${share.uk})`);
          console.log(`  msg_id: ${share.msg_id}`);
          for (const f of share.file_list || []) {
            const name = decodeURIComponent(f.path || f.server_filename || "");
            console.log(`    → ${name} ${f.isdir === "1" ? "[DIR]" : ""} (fs_id: ${f.fs_id})`);
          }
          console.log("");
        }
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
      break;
    }

    case "ls": {
      const gid = process.argv[3];
      const fsId = process.argv[4];
      if (!gid || !fsId) {
        console.error("Usage: ls <gid> <fs_id>");
        console.error("       Use 'shares <gid>' first to get fs_id");
        process.exit(1);
      }

      // 需要从 shares 获取 fromUk 和 msgId
      const shares = await getGroupShares(gid);
      let fromUk, msgId, found = false;

      if (shares.records && shares.records.msg_list) {
        for (const share of shares.records.msg_list) {
          for (const f of share.file_list || []) {
            if (f.fs_id === fsId) {
              fromUk = share.uk;
              msgId = share.msg_id;
              found = true;
              break;
            }
          }
          if (found) break;
        }
      }

      if (!found) {
        // 可能是子目录，尝试用每个 share 的 uk/msg_id
        const firstShare = shares.records?.msg_list?.[0];
        fromUk = firstShare?.uk;
        msgId = firstShare?.msg_id;
      }

      const data = await getShareInfo(gid, fromUk, msgId, fsId, 1);
      if (data.errno === 0 && Array.isArray(data.records)) {
        console.log(`Total: ${data.records.length} items${data.has_more ? " (has more)" : ""}\n`);
        data.records.forEach((f) => {
          const name = f.server_filename || "";
          const dir = f.isdir === 1 || f.isdir === "1" ? "[DIR] " : "      ";
          const size = formatSize(parseInt(f.size || "0"));
          console.log(`  ${dir}${name}  ${size}  fs_id:${f.fs_id}`);
        });
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
      break;
    }

    case "search": {
      const gid = process.argv[3];
      const keyword = process.argv[4];
      if (!gid || !keyword) {
        console.error("Usage: search <gid> <keyword>");
        process.exit(1);
      }
      console.log(`Searching for "${keyword}" in group ${gid}...\n`);
      const results = await searchGroupFiles(gid, keyword);
      if (results.length === 0) {
        console.log("No matches found.");
      } else {
        console.log(`Found ${results.length} matches:\n`);
        results.forEach((r) => {
          const dir = r.isDir ? "[DIR] " : "      ";
          console.log(`  ${dir}${r.path}  ${formatSize(r.size)}  fs_id:${r.fs_id}`);
        });
      }
      break;
    }

    default:
      console.log(`bdp-group.js — 百度网盘群聊文件工具

Usage: node bdp-group.js <command>

Commands:
  groups                    List all your groups
  shares <gid>              List share libraries in a group
  ls <gid> <fs_id>          Browse files in a share library
  search <gid> <keyword>    Search file names in a group

Environment:
  BDP_BDUSS    Your BDUSS cookie value (required)
  BDP_STOKEN   Your STOKEN cookie value (required)

Workflow:
  1. node bdp-group.js groups          → get gid
  2. node bdp-group.js shares <gid>    → get fs_id of top-level shares
  3. node bdp-group.js ls <gid> <fs_id>→ browse files inside
  4. node bdp-group.js search <gid> "关键词" → search by name
`);
      break;
  }
}

main().catch((e) => console.error(e));
