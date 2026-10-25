const test = require('node:test');
const assert = require('node:assert/strict');
const { apiHarness } = require('./helpers');

test('云调用支持回调结果，成功和失败均清理超时计时器', async () => {
  const { api, timers } = apiHarness({ cloud: { callFunction(options) { options.success({ result: { ok: true, data: { version: 1 } } }); } } });
  assert.equal((await api.callApi('getCurrent')).version, 1);
  assert.equal(timers.size, 0);
  await assert.rejects(api.invoke(() => { throw new Error('read error'); }, {}, { timeoutMs: 100 }), /read error/);
  assert.equal(timers.size, 0);
});

test('SDK 只返回 Promise 时也能结束等待', async () => {
  const { api, timers } = apiHarness({ cloud: { callFunction: async () => ({ result: { ok: true, data: 42 } }) } });
  assert.equal(await api.callApi('identity'), 42);
  assert.equal(timers.size, 0);
});

test('回调式 SDK 返回空 Promise 时仍等待真正的回调结果', async () => {
  let callback;
  const { api } = apiHarness({ cloud: { callFunction(options) { callback = options.success; return Promise.resolve(); } } });
  const pending = api.callApi('getCurrent');
  await new Promise(resolve => setImmediate(resolve));
  callback({ result: { ok: true, data: { version: 3 } } });
  assert.equal((await pending).version, 3);
});

test('发布 SDK 没有任何回调时 45 秒退出，迟到结果不重复提交或改变结果', async () => {
  let sdkOptions;
  let calls = 0;
  const { api, fireTimeout, timers, logs } = apiHarness({ cloud: { callFunction(options) { calls++; sdkOptions = options; } } });
  const pending = api.callApi('publish', { imageBase64: 'private-image-data' });
  const failure = assert.rejects(pending, error => error.code === 'CLIENT_TIMEOUT' && /结果暂未确认/.test(error.message));
  fireTimeout(45000);
  await failure;
  sdkOptions.success({ result: { ok: true, data: { version: 1 } } });
  assert.equal(calls, 1);
  assert.equal(timers.size, 0);
  assert.doesNotMatch(JSON.stringify(logs), /private-image-data/);
});

test('查询 SDK 没有任何回调时 20 秒退出', async () => {
  const { api, fireTimeout } = apiHarness({ cloud: { callFunction() {} } });
  const failure = assert.rejects(api.callApi('getCurrent'), error => error.code === 'CLIENT_TIMEOUT');
  fireTimeout(20000);
  await failure;
});

test('保留服务端阶段、错误码和请求 ID，便于对照云端日志', async () => {
  const { api } = apiHarness({ cloud: { callFunction(options) {
    options.success({ result: { ok: false, code: 'UPLOAD_TIMEOUT', message: '上传超时', stage: 'storage.upload', requestID: 'request-1' } });
  } } });
  await assert.rejects(api.callApi('publish'), error => error.code === 'UPLOAD_TIMEOUT' && error.stage === 'storage.upload' && error.requestID === 'request-1');
});

test('平台主动返回函数超时错误时给出可操作的提示', async () => {
  const { api } = apiHarness({ cloud: { callFunction(options) { options.fail({ errMsg: 'cloud.callFunction:fail function timeout' }); } } });
  await assert.rejects(api.callApi('publish'), error => error.code === 'FUNCTION_TIMEOUT' && /云端日志/.test(error.message));
});
