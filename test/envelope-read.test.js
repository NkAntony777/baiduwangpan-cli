// cat/head/tail/grep 的 --json 必须带 meta。不访问真实网盘：
// 假引擎 preload + 本机 HTTP 提供文件正文。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const BDP_JS = path.join(__dirname, "..", "bin", "bdp.js");
const VERSION = require("../package.json").version;
const PRELOAD = path.join(__dirname, "fixtures", "fake-engine-preload.js");

test("信封: cat/head/tail/grep --json 在假引擎下都带 meta", async () => {
  const body = Buffer.from("hello envelope\n");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Length": String(body.length) });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-env-read-"));
  fs.writeFileSync(
    path.join(cfgDir, "config.json"),
    JSON.stringify({
      bduss: "x",
      stoken: "y",
      ua: "ua",
      webTransport: "native",
      pcsPath: "BaiduPCS-Go",
    })
  );
  const cases = [
    ["cat", "/demo.txt", "--json"],
    ["head", "-n", "1", "/demo.txt", "--json"],
    ["tail", "-n", "1", "/demo.txt", "--json"],
    ["grep", "envelope", "/demo.txt", "--json"],
  ];
  try {
    const runCli = (args) => new Promise((resolve) => {
      const child = spawn(process.execPath, ["--require", PRELOAD, BDP_JS].concat(args), {
        env: Object.assign({}, process.env, {
          BDP_CONFIG_DIR: cfgDir,
          BDP_FAKE_DLINK: "http://127.0.0.1:" + port + "/file",
        }),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      const timer = setTimeout(() => { child.kill(); }, 8000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ status: code, stdout, stderr });
      });
    });
    for (const args of cases) {
      const r = await runCli(args);
      assert.equal(r.status, 0, args[0] + "\n" + r.stdout + "\n" + r.stderr);
      const json = JSON.parse(r.stdout);
      assert.equal(json.meta.command, args[0]);
      assert.equal(json.meta.version, VERSION);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});
