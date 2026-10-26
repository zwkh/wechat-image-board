const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { formatTime } = require('../miniprogram/utils/time');
const { apiHarness } = require('./helpers');

function pageHarness(name, api, wxOverrides = {}) {
  let definition;
  const wx = { stopPullDownRefresh() {}, showLoading() {}, hideLoading() {}, showToast() {}, showModal() {}, getFileSystemManager() { return { readFile() {} }; }, ...wxOverrides };
  const context = {
    Page(value) { definition = value; }, wx, console,
    require(file) {
      if (file.endsWith('/api')) return api;
      if (file.endsWith('/time')) return { formatTime };
      if (file.endsWith('/config')) return { title: '最新图片' };
      throw new Error(`Unexpected module: ${file}`);
    }
  };
  const source = fs.readFileSync(path.join(__dirname, `../miniprogram/pages/${name}/${name}.js`), 'utf8');
  vm.runInNewContext(source, context);
  const page = { ...definition, data: { ...definition.data }, setData(data) { Object.assign(this.data, data); } };
  return { page, wx };
}

test('北京时间跨日及无效值处理', () => {
  assert.equal(formatTime(Date.UTC(2026, 9, 15, 20, 5, 9)), '2026-10-16 04:05:09');
  assert.equal(formatTime(null), '');
  assert.equal(formatTime('invalid'), '');
});

test('每次打开首页重新获取图片，失败时不把旧图展示为最新', async () => {
  let count = 0;
  const { page } = pageHarness('index', { callApi: async () => {
    if (++count === 3) throw new Error('离线');
    return { imageUrl: `https://test/${count}.png`, updatedAt: 1700000000000 };
  } });
  page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.imageUrl, 'https://test/1.png');
  page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.imageUrl, 'https://test/2.png');
  await page.loadCurrent();
  assert.equal(page.data.error, '离线');
  assert.equal(page.data.imageUrl, '');
  assert.equal(page.data.loading, false);
});

test('慢请求不能覆盖较新请求的返回结果', async () => {
  let release;
  let count = 0;
  const { page } = pageHarness('index', { callApi: async () => {
    if (++count === 1) return new Promise(resolve => { release = resolve; });
    return { imageUrl: 'new', updatedAt: 2 };
  } });
  const older = page.loadCurrent();
  await page.loadCurrent();
  release({ imageUrl: 'old', updatedAt: 1 });
  await older;
  assert.equal(page.data.imageUrl, 'new');
});

test('管理页非管理员不会进入发布表单的数据加载流程', async () => {
  const actions = [];
  const { page } = pageHarness('admin', { callApi: async action => {
    actions.push(action);
    return { openid: 'reader', isAdmin: false };
  } });
  await page.reload();
  assert.equal(page.data.isAdmin, false);
  assert.deepEqual(actions, ['identity']);
});

function readyAdmin(page) {
  Object.assign(page.data, { loading: false, isAdmin: true, openid: 'owner', selectedPath: '/selected.png', selectedType: 'png', version: 0 });
}

test('选图允许 300MB 边界并显示 MB，超限及非法大小不读取图片', async () => {
  for (const [size, expected] of [[513 * 1024, '513 KB'], [3 * 1024 * 1024, '3.00 MB'], [300 * 1024 * 1024, '300.00 MB'], [300 * 1024 * 1024 + 1, null], [0, null], [-1, null], [NaN, null]]) {
    let imageReads = 0;
    let message = '';
    const wx = { chooseMedia() {}, getImageInfo() {}, showModal(options) { message = options.content; } };
    const { page } = pageHarness('admin', { invoke: async api => {
      if (api === wx.chooseMedia) return { tempFiles: [{ size, tempFilePath: '/large.png' }] };
      imageReads++;
      return { type: 'png' };
    } }, wx);
    readyAdmin(page);
    page.data.selectedPath = '';
    await page.chooseImage();
    if (expected) {
      assert.equal(page.data.selectedPath, '/large.png');
      assert.equal(page.data.selectedSize, expected);
      assert.equal(message, '');
    } else {
      assert.equal(page.data.selectedPath, '');
      assert.equal(imageReads, 0);
      assert.match(message, /300MB/);
    }
  }
});
function nativeWx(cloud) {
  return {
    cloud,
    showModal(options) { options.success({ confirm: true }); },
    getFileSystemManager() { throw new Error('新版不应把图片读成 Base64'); }
  };
}

test('图片使用原生上传，发布函数只接收文件 ID，成功后刷新一次', async () => {
  const actions = [];
  const wx = nativeWx({
    uploadFile(options) {
      assert.equal(options.filePath, '/selected.png');
      assert.match(options.cloudPath, /^uploads\/owner\/.+\.png$/);
      options.success({ fileID: 'cloud://env.bucket/uploads/owner/image.png' });
      return { onProgressUpdate(callback) { callback({ progress: 100 }); } };
    },
    callFunction(options) {
      actions.push(options.data.action);
      assert.equal(options.data.imageBase64, undefined);
      assert.ok(JSON.stringify(options.data).length < 500);
      options.success({ result: { ok: true, data: options.data.action === 'publish' ? { version: 1 } : { imageUrl: 'https://test/new.png', version: 1, updatedAt: 1700000000000 } } });
    }
  });
  const { api, timers } = apiHarness(wx);
  const { page } = pageHarness('admin', api, wx);
  readyAdmin(page);
  await page.publish();
  assert.deepEqual(actions, ['publish', 'getCurrent']);
  assert.equal(page.data.version, 1);
  assert.equal(page.data.busy, false);
  assert.equal(page.data.selectedPath, '');
  assert.match(page.data.notice, /发布成功/);
  assert.equal(timers.size, 0);
});

test('原生上传不回调时 60 秒退出，不发送发布；迟到结果也不发布', async () => {
  let upload;
  let calls = 0;
  const wx = nativeWx({ uploadFile(options) { upload = options; }, callFunction() { calls++; } });
  const { api, fireTimeout, timers } = apiHarness(wx);
  const { page } = pageHarness('admin', api, wx);
  readyAdmin(page);
  const running = page.publish();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(page.data.busyText, /上传图片/);
  fireTimeout(60000);
  await running;
  assert.equal(page.data.busy, false);
  assert.match(page.data.notice, /UPLOAD_TIMEOUT/);
  upload.success({ fileID: 'cloud://env.bucket/uploads/owner/late.png' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(timers.size, 0);
});

test('存储写权限未更新时明确提示配置 OpenID，不提交发布', async () => {
  let calls = 0;
  const wx = nativeWx({ uploadFile(options) { options.fail({ errMsg: 'permission denied' }); }, callFunction() { calls++; } });
  const { api } = apiHarness(wx);
  const { page } = pageHarness('admin', api, wx);
  readyAdmin(page);
  await page.publish();
  assert.match(page.data.notice, /STORAGE_PERMISSION/);
  assert.match(page.data.notice, /OpenID/);
  assert.equal(page.data.busy, false);
  assert.equal(calls, 0);
});

test('发布请求不回调时刷新确认，不自动重复发布，忽略迟到结果', async () => {
  const actions = [];
  let publishOptions;
  const wx = nativeWx({
    uploadFile(options) { options.success({ fileID: 'cloud://env.bucket/uploads/owner/image.png' }); },
    callFunction(options) {
      actions.push(options.data.action);
      if (options.data.action === 'publish') publishOptions = options;
      else options.success({ result: { ok: true, data: { imageUrl: 'https://test/new.png', version: 2, updatedAt: 1700000000000 } } });
    }
  });
  const { api, fireTimeout } = apiHarness(wx);
  const { page } = pageHarness('admin', api, wx);
  readyAdmin(page);
  const running = page.publish();
  await new Promise(resolve => setImmediate(resolve));
  fireTimeout(45000);
  await running;
  assert.equal(page.data.busy, false);
  assert.equal(page.data.version, 2);
  assert.match(page.data.notice, /CLIENT_TIMEOUT/);
  assert.deepEqual(actions, ['publish', 'getCurrent']);
  publishOptions.success({ result: { ok: true, data: { version: 1 } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.version, 2);
});

test('发布后的查询也无响应时仍解锁，并保留原始错误', async () => {
  const wx = nativeWx({ uploadFile(options) { options.success({ fileID: 'cloud://env.bucket/uploads/owner/image.png' }); }, callFunction() {} });
  const { api, fireTimeout } = apiHarness(wx);
  const { page } = pageHarness('admin', api, wx);
  readyAdmin(page);
  const running = page.publish();
  await new Promise(resolve => setImmediate(resolve));
  fireTimeout(45000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.busy, true);
  fireTimeout(20000);
  await running;
  assert.equal(page.data.busy, false);
  assert.match(page.data.error, /刷新当前图片失败/);
  assert.match(page.data.notice, /CLIENT_TIMEOUT/);
});

test('取消确认框不上传、不发布并保留选图', async () => {
  const { page } = pageHarness('admin', {
    invoke: async () => ({ confirm: false }),
    uploadImage: async () => { throw new Error('不应上传'); },
    callApi: async () => { throw new Error('不应发布'); }
  });
  readyAdmin(page);
  await page.publish();
  assert.equal(page.data.busy, false);
  assert.equal(page.data.selectedPath, '/selected.png');
  assert.equal(page.data.notice, '');
});

test('管理员可复制精确匹配本人 OpenID 的存储规则', () => {
  let copied;
  const { page } = pageHarness('admin', {}, { setClipboardData(options) { copied = JSON.parse(options.data); } });
  readyAdmin(page);
  page.copyStorageRule();
  assert.equal(copied.read, false);
  assert.equal(copied.write, "auth.openid == 'owner' && /^uploads\\//.test(resource.path)");
  page.data.isAdmin = false;
  copied = null;
  page.copyStorageRule();
  assert.equal(copied, null);
});
