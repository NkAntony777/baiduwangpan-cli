// 测试专用：在 bdp 进程里把引擎 spawn 换成固定输出，避免真的启动 BaiduPCS-Go。
const Module = require("module");
const { EventEmitter } = require("events");
const realRequire = Module.prototype.require;
const cp = realRequire.call(module, "child_process");

function fakeSpawn(cmd, args) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = function () {};
  const sub = args && args[0];
  process.nextTick(() => {
    let text = "ok\n";
    if (sub === "locate") text = (process.env.BDP_FAKE_DLINK || "https://example.invalid/f") + "\n";
    else if (sub === "meta") text = "文件大小          15, 0MB\n";
    child.stdout.emit("data", Buffer.from(text));
    child.emit("close", 0);
  });
  return child;
}

Module.prototype.require = function (id) {
  if (id === "child_process") return Object.assign({}, cp, { spawn: fakeSpawn });
  return realRequire.apply(this, arguments);
};
