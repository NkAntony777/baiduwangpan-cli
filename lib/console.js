"use strict";

/**
 * 控制台编码工具
 *
 * 背景: 在中文 Windows (zh-CN) 上, 控制台默认代码页为 cp936 (GBK),
 * 而 Node 的 stdout 始终输出 UTF-8 字节, 导致 `bdp` 的中文输出在
 * PowerShell / cmd 中显示乱码 (如 "测试中文输出" 显示为 "娴嬭瘯涓枃杈撳嚭")。
 *
 * 修复思路: 检测当前代码页, 若不是 65001 (UTF-8) 且标准输出是终端,
 * 则通过 `cmd /c chcp 65001` 切换代码页, 使控制台按 UTF-8 解释输出。
 */

const { spawnSync, execSync } = require("node:child_process");

/**
 * 解析 `cmd /c chcp` 的输出, 提取代码页数字。
 *
 * 注意: chcp 输出的语言随当前代码页变化 ——
 *   代码页为 936 时: "活动代码页: 936" (GBK 编码, 中文标签)
 *   代码页为 65001 时: "Active code page: 65001" (英文标签)
 * 因此同时兼容中英文两种格式。
 *
 * @param {string} output `cmd /c chcp` 的原始输出
 * @returns {number|null} 代码页数字; 空串或无法解析时返回 null
 */
function parseChcp(output) {
  if (typeof output !== "string" || output.trim() === "") return null;
  // 兼容 "Active code page: 936" 与 "活动代码页: 936" 两种格式
  const m = output.match(/(?:code\s*page|代码页)\s*[:：]?\s*(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 从 `cmd /c chcp` 的原始输出 Buffer 中解析代码页数字。
 * 无论输出是 UTF-8 还是 GBK 编码, 数字本身都是 ASCII, 因此兼容两种场景:
 *   1) 按 UTF-8 解码解析;
 *   2) 失败则按 GBK 解码 (TextDecoder, 依赖 ICU; 无 ICU 时静默跳过);
 *   3) 兜底: 直接从原始字节中提取数字 (任何编码下数字均为 ASCII)。
 *
 * @param {Buffer} buf chcp 输出的原始字节
 * @returns {number|null} 代码页数字; 解析失败返回 null
 */
function resolveChcpNumber(buf) {
  let cp = parseChcp(buf.toString("utf8"));
  if (cp !== null) return cp;
  try {
    cp = parseChcp(new TextDecoder("gbk").decode(buf));
  } catch {
    /* 构建无 GBK 解码器时跳过 */
  }
  if (cp !== null) return cp;
  const m = buf.toString("latin1").match(/(\d{3,5})/);
  return m ? Number(m[1]) : null;
}

/**
 * 确保 Windows 控制台使用 UTF-8 代码页, 避免中文乱码。
 *
 * 仅在同时满足以下条件时才尝试切换:
 *   - process.platform === "win32" (其他平台无此问题)
 *   - process.stdout.isTTY (标准输出是终端; 重定向/管道场景不处理)
 *   - 当前代码页不是 65001 (已是 UTF-8 则跳过)
 *
 * 切换失败时静默忽略, 不抛异常; 幂等, 可安全重复调用。
 */
function ensureUtf8Console() {
  if (process.platform !== "win32" || !process.stdout.isTTY) return;

  // 1. 查询当前代码页 (spawnSync 返回原始 Buffer, 不经过控制台解码)
  let current = null;
  try {
    const r = spawnSync("cmd", ["/c", "chcp"], {
      encoding: "buffer",
      windowsHide: true,
    });
    if (r.status !== 0 || !r.stdout || r.stdout.length === 0) return;
    current = resolveChcpNumber(r.stdout);
  } catch {
    return;
  }

  // 2. 已是最新代码页或无法解析, 无需处理
  if (current === null || current === 65001) return;

  // 3. 切换代码页。
  //    注意: 不能用 windowsHide —— 隐藏窗口的子进程会被分配独立的隐藏控制台,
  //    其中的 chcp 只改那个隐藏控制台的代码页, 对用户所在控制台无效 (已实测)。
  //    失败静默 (例如控制台被其它程序独占)。
  try {
    execSync("cmd /c chcp 65001 >nul", { stdio: "ignore" });
  } catch {
    /* 静默失败 */
  }
}

module.exports = { parseChcp, ensureUtf8Console };
