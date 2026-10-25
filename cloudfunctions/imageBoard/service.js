const crypto = require('node:crypto');
const MAX_BYTES = 2 * 1024 * 1024;
const COLLECTION = 'image_board';
const DEFAULT_TIMEOUTS = { read: 8000, upload: 20000, commit: 8000, url: 8000, cleanup: 3000 };

class BusinessError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function withDeadline(operation, timeoutMs, code, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BusinessError(code, message)), timeoutMs);
  });
  // 超时只停止本流程继续等待，不代表底层云操作已撤销。
  return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => clearTimeout(timer));
}

function decodeImage(value) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(MAX_BYTES / 3) * 4) {
    throw new BusinessError('INVALID_IMAGE', '图片不能为空且不能超过 2MB');
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new BusinessError('INVALID_IMAGE', '图片编码不合法');
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length > MAX_BYTES || buffer.toString('base64') !== value) {
    throw new BusinessError('INVALID_IMAGE', '图片大小或编码不合法');
  }
  let extension = '';
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && buffer.toString('ascii', 12, 16) === 'IHDR') extension = 'png';
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) extension = 'jpg';
  if (buffer.length >= 16 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') extension = 'webp';
  if (!extension) throw new BusinessError('INVALID_IMAGE', '仅支持 JPG、PNG、WebP 图片');
  return { buffer, extension };
}

function createHandler({ cloud, db, env, now = Date.now, randomId = () => crypto.randomBytes(16).toString('hex'), logger = console, timeouts = {} }) {
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const collection = () => db.collection(COLLECTION);
  const admins = () => String(env.ADMIN_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean);
  async function currentRecord(step) {
    const result = await step('database.read', limits.read, 'DATABASE_TIMEOUT', '读取当前图片记录超时，请稍后重试', () => collection().where({ _id: 'current' }).limit(1).get());
    if (!result.data.length) throw new BusinessError('NOT_INITIALIZED', '请先按部署说明创建 image_board 集合及 current 初始记录');
    const record = result.data[0];
    if (!Number.isSafeInteger(record.version) || record.version < 0) throw new BusinessError('INVALID_CONFIG', '图片记录版本无效，请维护者检查数据库');
    return record;
  }

  async function getCurrent(step) {
    const record = await currentRecord(step);
    if (!record.fileID) return { imageUrl: '', updatedAt: null, version: record.version };
    // 客户端没有存储读写权限，由服务端签发当前图片访问链接。
    const result = await step('storage.url', limits.url, 'IMAGE_TIMEOUT', '获取图片访问链接超时，请稍后重试', () => cloud.getTempFileURL({ fileList: [record.fileID] }));
    const file = result.fileList && result.fileList[0];
    if (!file || file.status !== 0 || !file.tempFileURL) throw new BusinessError('IMAGE_UNAVAILABLE', '当前图片无法访问，请管理员检查云存储文件');
    return { imageUrl: file.tempFileURL, updatedAt: record.updatedAt, version: record.version };
  }

  async function publish(event, step) {
    if (!Number.isSafeInteger(event.expectedVersion) || event.expectedVersion < 0) throw new BusinessError('INVALID_VERSION', '请先刷新当前图片再发布');
    const existing = await currentRecord(step);
    if (existing.version !== event.expectedVersion) throw new BusinessError('CONFLICT', '图片已被更新，请刷新确认后重新选择');
    const { buffer, extension } = decodeImage(event.imageBase64);
    // 每次使用新路径，避免 CDN / 微信图片缓存继续显示旧图。
    let uploaded;
    try {
      uploaded = await step('storage.upload', limits.upload, 'UPLOAD_TIMEOUT', '云存储上传超时，请检查网络和云环境状态', () => cloud.uploadFile({ cloudPath: `published/${randomId()}.${extension}`, fileContent: buffer }));
    } catch (error) {
      if (error instanceof BusinessError) throw error;
      throw new BusinessError('UPLOAD_FAILED', '云存储上传失败，请检查云存储是否可用及云函数日志');
    }
    if (!uploaded.fileID) throw new BusinessError('UPLOAD_FAILED', '图片上传失败，请稍后重试');
    const updatedAt = now();
    const version = existing.version + 1;
    let result;
    try {
      // 原子条件更新：并发发布只允许一个请求提交，禁止覆盖未看过的新版本。
      result = await step('database.commit', limits.commit, 'COMMIT_UNCERTAIN', '保存发布记录超时，结果暂未确认', () => collection().where({ _id: 'current', version: event.expectedVersion }).update({ data: { fileID: uploaded.fileID, updatedAt, version } }));
    } catch (error) {
      // 请求出错时提交可能已经成功；保留文件，避免误删当前图片。
      throw new BusinessError('COMMIT_UNCERTAIN', '发布结果暂未确认');
    }
    if (!result.stats || result.stats.updated !== 1) {
      if (result.stats && result.stats.updated === 0) {
        try { await step('storage.cleanup', limits.cleanup, 'CLEANUP_TIMEOUT', '清理冲突文件超时', () => cloud.deleteFile({ fileList: [uploaded.fileID] })); } catch (_) { /* 清理失败不影响冲突判断，保留文件供人工清理。 */ }
        throw new BusinessError('CONFLICT', '图片已被其他发布操作更新');
      }
      throw new BusinessError('COMMIT_UNCERTAIN', '发布结果暂未确认');
    }
    // 不立即删除旧图，避免已打开的页面和进行中的读取请求失效。
    return { version, updatedAt };
  }

  return async (event = {}, context = {}) => {
    let stage = 'identity';
    const requestID = context.requestID || '';
    const log = (level, details) => {
      if (typeof logger[level] === 'function') logger[level]('imageBoard', { action: event.action, requestID, ...details });
    };
    const step = async (name, timeoutMs, code, message, operation) => {
      stage = name;
      const startedAt = Date.now();
      log('info', { stage, status: 'start' });
      try {
        const result = await withDeadline(operation, timeoutMs, code, message);
        log('info', { stage: name, status: 'ok', elapsedMs: Date.now() - startedAt });
        return result;
      } catch (error) {
        log('error', { stage: name, status: 'failed', code: error.code || error.errCode || 'SDK_ERROR', message: String(error.message || error.errMsg || '').slice(0, 300), elapsedMs: Date.now() - startedAt });
        throw error;
      }
    };
    try {
      if (!context.OPENID) throw new BusinessError('UNAUTHENTICATED', '请通过微信小程序访问');
      const isAdmin = admins().includes(context.OPENID);
      let data;
      switch (event.action) {
        case 'identity': data = { openid: context.OPENID, isAdmin }; break;
        case 'getCurrent': data = await getCurrent(step); break;
        case 'publish':
          if (!isAdmin) throw new BusinessError('FORBIDDEN', '当前微信没有发布权限');
          data = await publish(event, step);
          break;
        default: throw new BusinessError('INVALID_ACTION', '不支持的操作');
      }
      log('info', { stage: 'complete', status: 'ok' });
      return { ok: true, data };
    } catch (error) {
      const code = error instanceof BusinessError ? error.code : 'SERVER';
      log('error', { stage, status: 'failed', code });
      return { ok: false, code, stage, requestID, message: error instanceof BusinessError ? error.message : '服务暂时不可用，请稍后重试；维护者可查看云函数日志' };
    }
  };
}

module.exports = { createHandler, decodeImage, MAX_BYTES };
