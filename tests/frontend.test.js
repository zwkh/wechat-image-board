const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { formatTime } = require('../miniprogram/utils/time');

function pageHarness(name, api) {
  let definition;
  const wx = { stopPullDownRefresh() {}, showLoading() {}, hideLoading() {}, showToast() {}, showModal() {}, getFileSystemManager() { return { readFile() {} }; } };
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

test('管理员发布收到不确定结果后刷新确认，不自动重试', async () => {
  const actions = [];
  const { page } = pageHarness('admin', {
    invoke: async (_api, options) => options.encoding ? { data: 'image' } : { confirm: true },
    callApi: async action => {
      actions.push(action);
      if (action === 'publish') throw new Error('连接失败');
      return { imageUrl: 'https://test/new.png', version: 2, updatedAt: 1700000000000 };
    }
  });
  Object.assign(page.data, { isAdmin: true, selectedPath: '/selected.png', version: 1 });
  await page.publish();
  assert.deepEqual(actions, ['publish', 'getCurrent']);
  assert.equal(page.data.selectedPath, '');
  assert.equal(page.data.version, 2);
  assert.equal(page.data.busy, false);
  assert.match(page.data.notice, /确认结果/);
});
