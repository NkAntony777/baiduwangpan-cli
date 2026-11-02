const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("../lib/http");

test("spawnCollected: 等待子进程时事件循环不被冻住", async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  const r = await http.spawnCollected(
    process.execPath,
    ["-e", "setTimeout(()=>{}, 40)"],
    { encoding: "utf-8", timeoutMs: 5000 }
  );
  clearInterval(timer);
  assert.equal(r.status, 0);
  assert.equal(r.error, null);
  assert.ok(ticks > 0, "定时器应能触发");
});
