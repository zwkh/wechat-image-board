const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 用可控时钟测试真实 API 包装，避免测试等待 10～45 秒。
function apiHarness(wx, app = { globalData: { cloudReady: true } }) {
  const timers = new Map();
  const logs = [];
  let id = 0;
  const context = {
    wx, getApp: () => app, module: { exports: {} },
    console: { error: (...args) => logs.push(args) },
    setTimeout(callback, ms) { const key = ++id; timers.set(key, { callback, ms }); return key; },
    clearTimeout(key) { timers.delete(key); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/api.js'), 'utf8'), context);
  return {
    api: context.module.exports, timers, logs,
    fireTimeout(ms) {
      const timer = [...timers.values()].find(value => value.ms === ms);
      if (!timer) throw new Error(`Timeout not scheduled: ${ms}`);
      timer.callback();
    }
  };
}

module.exports = { apiHarness };
