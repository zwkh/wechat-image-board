const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, MAX_BYTES } = require('../cloudfunctions/imageBoard/service');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=';

function setup(options = {}) {
  const state = {
    record: { _id: 'current', fileID: '', updatedAt: null, version: 0 },
    uploads: [], deleted: [], reads: 0,
    ...options
  };
  const db = {
    collection(name) {
      assert.equal(name, 'image_board');
      return {
        where(filter) {
          return {
            limit() { return this; },
            async get() { state.reads++; return { data: state.record ? [{ ...state.record }] : [] }; },
            async update({ data }) {
              const matches = state.record && state.record._id === filter._id && state.record.version === filter.version;
              if (matches) Object.assign(state.record, data);
              if (state.commitThrows) throw new Error('connection lost after commit');
              return { stats: { updated: matches ? 1 : 0 } };
            }
          };
        }
      };
    }
  };
  const cloud = {
    async uploadFile(input) {
      state.uploads.push(input);
      if (state.uploadBarrier) await state.uploadBarrier();
      return { fileID: `cloud://env/${input.cloudPath}` };
    },
    async getTempFileURL({ fileList }) {
      return { fileList: [{ status: state.urlFails ? -1 : 0, tempFileURL: `https://example.test/${fileList[0]}` }] };
    },
    async deleteFile({ fileList }) { state.deleted.push(...fileList); }
  };
  let id = 0;
  const handler = createHandler({ cloud, db, env: { ADMIN_OPENIDS: state.admins === undefined ? 'owner' : state.admins }, now: () => 1700000000000, randomId: () => `unique-${++id}`, logger: { error() {} } });
  const call = (event, openid = 'owner') => handler(event, { OPENID: openid });
  return { state, call };
}
const publication = version => ({ action: 'publish', imageBase64: png, expectedVersion: version });

test('普通用户可读取空态和当前图片及服务端更新时间', async () => {
  const { call } = setup();
  const empty = await call({ action: 'getCurrent' }, 'reader');
  assert.deepEqual(empty, { ok: true, data: { imageUrl: '', updatedAt: null, version: 0 } });
  assert.equal((await call(publication(0))).ok, true);
  const result = await call({ action: 'getCurrent' }, 'reader');
  assert.equal(result.data.version, 1);
  assert.equal(result.data.updatedAt, 1700000000000);
  assert.match(result.data.imageUrl, /^https:/);
});

test('未登录调用被拒绝；不能通过 event 伪造管理员', async () => {
  const { call, state } = setup();
  assert.equal((await call(publication(0), '')).code, 'UNAUTHENTICATED');
  assert.equal((await call({ ...publication(0), OPENID: 'owner', openid: 'owner', isAdmin: true }, 'reader')).code, 'FORBIDDEN');
  assert.equal(state.uploads.length, 0);
  assert.equal(state.reads, 0);
});

test('管理员配置为空默认拒绝写入，不存在先到先得的注册接口', async () => {
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

test('缺少初始化记录会提示部署问题，不会直接创建或覆盖数据', async () => {
  const { call, state } = setup({ record: null });
  assert.equal((await call(publication(0))).code, 'NOT_INITIALIZED');
  assert.equal(state.uploads.length, 0);
});

test('拒绝过大文件、无效编码和非图片内容，不允许指定外部 fileID', async () => {
  const { call, state } = setup();
  for (const value of ['', 'hello', '!!!!', Buffer.from('not an image').toString('base64'), Buffer.alloc(MAX_BYTES + 1).toString('base64')]) {
    assert.equal((await call({ ...publication(0), imageBase64: value })).code, 'INVALID_IMAGE');
  }
  assert.equal((await call({ action: 'publish', expectedVersion: 0, fileID: 'cloud://evil/image.jpg' })).code, 'INVALID_IMAGE');
  assert.equal(state.uploads.length, 0);
});

test('成功发布产生新路径并更新版本，不采用客户端时间', async () => {
  const { call, state } = setup();
  assert.equal((await call({ ...publication(0), updatedAt: 1 })).ok, true);
  assert.equal((await call(publication(1))).ok, true);
  assert.notEqual(state.uploads[0].cloudPath, state.uploads[1].cloudPath);
  assert.equal(state.record.version, 2);
  assert.equal(state.record.updatedAt, 1700000000000);
  assert.equal(state.deleted.length, 0); // 保留旧文件避免读请求失效。
});

test('旧版本或非法版本拒绝发布', async () => {
  const { call, state } = setup();
  await call(publication(0));
  assert.equal((await call(publication(0))).code, 'CONFLICT');
  for (const version of [undefined, -1, 0.5, '1', Infinity]) assert.equal((await call(publication(version))).code, 'INVALID_VERSION');
  assert.equal(state.uploads.length, 1);
});

test('并发发布只有一个成功，冲突文件被清理', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let uploads = 0;
  const { call, state } = setup({ uploadBarrier: async () => { if (++uploads === 2) release(); await barrier; } });
  const results = await Promise.all([call(publication(0)), call(publication(0))]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => result.code === 'CONFLICT').length, 1);
  assert.equal(state.record.version, 1);
  assert.equal(state.deleted.length, 1);
  assert.notEqual(state.deleted[0], state.record.fileID);
});

test('提交成功后连接异常，保留已发布文件供管理员刷新确认', async () => {
  const { call, state } = setup({ commitThrows: true });
  const result = await call(publication(0));
  assert.equal(result.code, 'COMMIT_UNCERTAIN');
  assert.equal(state.record.version, 1);
  assert.equal(state.deleted.length, 0);
  assert.equal((await call({ action: 'getCurrent' })).data.version, 1);
});

test('临时链接获取失败显示错误，不把无法访问的图片当成空态', async () => {
  const { call } = setup({ record: { _id: 'current', fileID: 'cloud://env/x.png', version: 1, updatedAt: 1 }, urlFails: true });
  assert.equal((await call({ action: 'getCurrent' })).code, 'IMAGE_UNAVAILABLE');
});
