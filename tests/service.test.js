const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, MAX_BYTES } = require('../cloudfunctions/imageBoard/service');
const initialRecord = require('../deploy/initial-record.json');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=', 'base64');
const fileID = (version = 0, name = 'image') => `cloud://env.bucket/uploads/owner/${name}-${version}.png`;
const publication = (version, name) => ({ action: 'publish', fileID: fileID(version, name), expectedVersion: version });

function setup(options = {}) {
  const state = { record: { ...initialRecord }, downloads: [], reads: 0, logs: [], fileContent: png, ...options };
  const db = { collection(name) {
    assert.equal(name, 'image_board');
    return { where(filter) { return {
      limit() { return this; },
      async get() {
        state.reads++;
        if (state.readBarrier) await state.readBarrier();
        return { data: state.record ? [{ ...state.record }] : [] };
      },
      async update({ data }) {
        if (state.commitBarrier) await state.commitBarrier();
        const matches = state.record && state.record._id === filter._id && state.record.version === filter.version;
        if (matches) Object.assign(state.record, data);
        if (state.commitThrows) throw new Error('connection lost after commit');
        return { stats: { updated: matches ? 1 : 0 } };
      }
    }; } };
  } };
  const cloud = {
    async downloadFile(input) {
      state.downloads.push(input.fileID);
      if (state.downloadThrows) throw new Error('storage unavailable');
      if (state.downloadBarrier) await state.downloadBarrier();
      return { fileContent: state.fileContent };
    },
    async getTempFileURL({ fileList }) {
      if (state.urlBarrier) await state.urlBarrier();
      return { fileList: [{ status: state.urlFails ? -1 : 0, tempFileURL: `https://example.test/${fileList[0]}` }] };
    }
  };
  const handler = createHandler({
    cloud, db, env: { ADMIN_OPENIDS: state.admins === undefined ? 'owner' : state.admins },
    now: () => 1700000000000, timeouts: state.timeouts,
    logger: { info: (...args) => state.logs.push(args), error: (...args) => state.logs.push(args) }
  });
  const call = (event, openid = 'owner') => handler(event, { OPENID: openid, ENV: 'env', requestID: 'test-request' });
  return { state, call };
}

test('初始记录展示空态，原生上传后的文件可发布并显示服务端时间', async () => {
  const { call } = setup();
  assert.deepEqual(await call({ action: 'getCurrent' }, 'reader'), { ok: true, data: { imageUrl: '', updatedAt: null, version: 0 } });
  assert.equal((await call(publication(0))).ok, true);
  const result = await call({ action: 'getCurrent' }, 'reader');
  assert.equal(result.data.version, 1);
  assert.equal(result.data.updatedAt, 1700000000000);
  assert.match(result.data.imageUrl, /^https:/);
});

test('普通用户和未登录调用不能伪造身份发布，校验发生在云读写之前', async () => {
  const { call, state } = setup();
  assert.equal((await call(publication(0), '')).code, 'UNAUTHENTICATED');
  assert.equal((await call({ ...publication(0), OPENID: 'owner', openid: 'owner', isAdmin: true }, 'reader')).code, 'FORBIDDEN');
  assert.equal(state.downloads.length, 0);
  assert.equal(state.reads, 0);
});

test('管理员配置为空拒绝发布，没有客户端注册管理员接口', async () => {
  const { call } = setup({ admins: '' });
  assert.equal((await call(publication(0))).code, 'FORBIDDEN');
  assert.equal((await call({ action: 'identity' })).data.isAdmin, false);
  assert.equal((await call({ action: 'registerAdmin' })).code, 'INVALID_ACTION');
});

test('OpenID 必须精确匹配，支持逗号分隔并去除空格', async () => {
  const { call } = setup({ admins: ' owner , second ' });
  assert.equal((await call({ action: 'identity' }, 'second')).data.isAdmin, true);
  assert.equal((await call({ action: 'identity' }, 'own')).data.isAdmin, false);
});

test('缺少初始记录会提示部署问题', async () => {
  const { call, state } = setup({ record: null });
  assert.equal((await call(publication(0))).code, 'NOT_INITIALIZED');
  assert.equal(state.downloads.length, 0);
});

test('拒绝其他环境、其他用户、路径穿越、外部链接和旧版 Base64 参数', async () => {
  const { call, state } = setup();
  for (const value of [undefined, '', 'https://example.test/x.png', 'cloud://evil.bucket/uploads/owner/image.png', 'cloud://env.bucket/uploads/reader/image.png', 'cloud://env.bucket/uploads/owner/../reader/image.png', 'cloud://env.bucket/published/old.png']) {
    assert.equal((await call({ ...publication(0), fileID: value })).code, 'INVALID_FILE');
  }
  assert.equal((await call({ action: 'publish', expectedVersion: 0, imageBase64: png.toString('base64') })).code, 'INVALID_FILE');
  assert.equal(state.downloads.length, 0);
});

test('服务端复核实际文件大小和签名，不信任客户端文件名', async () => {
  for (const value of [Buffer.alloc(0), Buffer.from('not an image'), Buffer.alloc(MAX_BYTES + 1)]) {
    const { call, state } = setup({ fileContent: value });
    assert.equal((await call(publication(0))).code, 'INVALID_IMAGE');
    assert.equal(state.record.version, 0);
  }
});

test('成功发布保留文件 ID，并忽略客户端时间', async () => {
  const { call, state } = setup();
  assert.equal((await call({ ...publication(0), updatedAt: 1 })).ok, true);
  assert.equal((await call(publication(1))).ok, true);
  assert.equal(state.record.fileID, fileID(1));
  assert.equal(state.record.version, 2);
  assert.equal(state.record.updatedAt, 1700000000000);
});

test('513KB 图片仍只需要小型发布参数，并由服务端检查实际文件', async () => {
  const content = Buffer.alloc(513 * 1024);
  png.copy(content);
  const { call, state } = setup({ fileContent: content });
  const request = publication(0);
  assert.ok(Buffer.byteLength(JSON.stringify(request)) < 500);
  assert.equal((await call(request)).ok, true);
  assert.equal(state.downloads.length, 1);
  assert.equal(state.record.version, 1);
});

test('旧版本或非法版本拒绝发布，不去读取云存储', async () => {
  const { call, state } = setup();
  await call(publication(0));
  assert.equal((await call(publication(0))).code, 'CONFLICT');
  for (const version of [undefined, -1, 0.5, '1', Infinity]) assert.equal((await call(publication(version))).code, 'INVALID_VERSION');
  assert.equal(state.downloads.length, 1);
});

test('并发发布只有一个成功，冲突文件保留', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let downloads = 0;
  const { call, state } = setup({ downloadBarrier: async () => { if (++downloads === 2) release(); await barrier; } });
  const results = await Promise.all([call(publication(0, 'a')), call(publication(0, 'b'))]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => result.code === 'CONFLICT').length, 1);
  assert.equal(state.record.version, 1);
});

test('提交成功后连接异常保留结果供刷新确认', async () => {
  const { call, state } = setup({ commitThrows: true });
  assert.equal((await call(publication(0))).code, 'COMMIT_UNCERTAIN');
  assert.equal(state.record.version, 1);
  assert.equal((await call({ action: 'getCurrent' })).data.version, 1);
});

test('数据库读取不返回时退出，返回诊断阶段和请求 ID', async () => {
  const { call, state } = setup({ timeouts: { read: 5 }, readBarrier: () => new Promise(() => {}) });
  const result = await call(publication(0));
  assert.equal(result.code, 'DATABASE_TIMEOUT');
  assert.equal(result.stage, 'database.read');
  assert.equal(result.requestID, 'test-request');
  assert.equal(state.downloads.length, 0);
});

test('图片下载不返回时退出，不在迟到完成后继续提交', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const { call, state } = setup({ timeouts: { download: 5 }, downloadBarrier: () => barrier });
  const result = await call(publication(0));
  assert.equal(result.code, 'FILE_TIMEOUT');
  assert.equal(result.stage, 'storage.download');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.record.version, 0);
});

test('存储读取错误给出可定位的错误码', async () => {
  const { call, state } = setup({ downloadThrows: true });
  const result = await call(publication(0));
  assert.equal(result.code, 'FILE_UNAVAILABLE');
  assert.equal(result.stage, 'storage.download');
  assert.ok(state.logs.some(([, log]) => log.stage === 'storage.download' && log.status === 'failed'));
});

test('提交超时后可能迟到成功，文件不会被删除', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const { call, state } = setup({ timeouts: { commit: 5 }, commitBarrier: () => barrier });
  assert.equal((await call(publication(0))).code, 'COMMIT_UNCERTAIN');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.record.version, 1);
});

test('图片链接获取失败或超时，不把图片当成空态', async () => {
  const record = { _id: 'current', version: 1, fileID: fileID(), updatedAt: 1 };
  assert.equal((await setup({ record, urlFails: true }).call({ action: 'getCurrent' })).code, 'IMAGE_UNAVAILABLE');
  assert.equal((await setup({ record, timeouts: { url: 5 }, urlBarrier: () => new Promise(() => {}) }).call({ action: 'getCurrent' })).code, 'IMAGE_TIMEOUT');
});
