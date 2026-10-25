async function callApi(action, data = {}, options = {}) {
  const state = getApp().globalData;
  if (!state.cloudReady) throw new Error(state.setupError || '云开发尚未就绪');
  let response;
  try {
    response = await invoke(wx.cloud.callFunction.bind(wx.cloud), {
      name: 'imageBoard', data: { ...data, action }
    }, {
      timeoutMs: options.timeoutMs || (action === 'publish' ? 45000 : 20000),
      timeoutCode: 'CLIENT_TIMEOUT',
      timeoutMessage: action === 'publish' ? '发布请求等待超时，结果暂未确认' : '连接超时，请检查网络后重试'
    });
  } catch (error) {
    const detail = String(error.errMsg || error.message || '');
    const timedOut = /timeout|timed out|超时/i.test(detail);
    const failure = new Error(error.code === 'CLIENT_TIMEOUT' ? error.message : timedOut
      ? '云函数执行超时，请检查 imageBoard 的超时配置和云端日志'
      : '连接失败，请检查网络、云函数部署状态和环境 ID');
    failure.code = error.code || (timedOut ? 'FUNCTION_TIMEOUT' : 'NETWORK');
    failure.requestID = error.requestID || '';
    // 只记录诊断信息，不打印图片编码或整个调用参数。
    console.error('imageBoard request failed', { action, code: failure.code, requestID: failure.requestID, detail: detail.slice(0, 300) });
    throw failure;
  }
  const result = response && response.result;
  if (!result || result.ok !== true) {
    const error = new Error((result && result.message) || '服务返回异常，请稍后重试');
    error.code = (result && result.code) || 'SERVER';
    error.stage = (result && result.stage) || '';
    error.requestID = (result && result.requestID) || (response && response.requestID) || '';
    console.error('imageBoard operation failed', { action, code: error.code, stage: error.stage, requestID: error.requestID });
    throw error;
  }
  return result.data;
}

// 选图和确认弹窗等待用户操作，不设默认超时；文件和网络操作显式设定上限。
function invoke(api, options = {}, settings = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    if (settings.timeoutMs) {
      timer = setTimeout(() => {
        const error = new Error(settings.timeoutMessage || '操作超时，请重试');
        error.code = settings.timeoutCode || 'TIMEOUT';
        finish(reject, error);
      }, settings.timeoutMs);
    }
    try {
      const task = api({ ...options, success: value => finish(resolve, value), fail: error => finish(reject, error) });
      // 兼容回调与 Promise 两种 SDK 返回方式；迟到的结果不会再次改变状态。
      if (task && typeof task.then === 'function') task.then(value => {
        // 部分回调式接口返回 Promise<void>；其结束不等于已收到操作结果。
        if (value !== undefined) finish(resolve, value);
      }, error => finish(reject, error));
    } catch (error) {
      finish(reject, error);
    }
  });
}

async function uploadImage(filePath, cloudPath, onProgress) {
  try {
    const uploaded = await invoke(options => {
      const task = wx.cloud.uploadFile(options);
      if (task && typeof task.onProgressUpdate === 'function' && onProgress) {
        task.onProgressUpdate(result => onProgress(result.progress));
      }
      return task;
    }, { filePath, cloudPath }, {
      timeoutMs: 60000, timeoutCode: 'UPLOAD_TIMEOUT', timeoutMessage: '图片上传超时，请检查网络后重试'
    });
    if (!uploaded || !uploaded.fileID) throw new Error('图片上传没有返回文件 ID，请重试');
    return uploaded;
  } catch (error) {
    const detail = String(error.errMsg || error.message || '');
    const denied = /permission|denied|unauthorized|-502003|-502005|权限/i.test(detail);
    const failure = new Error(denied ? '云存储拒绝上传，请按新版部署说明将写权限配置为仅你的 OpenID 可写' : (error.message || '图片上传失败，请检查网络及云存储状态'));
    failure.code = error.code || (denied ? 'STORAGE_PERMISSION' : 'UPLOAD_FAILED');
    console.error('image upload failed', { code: failure.code, detail: detail.slice(0, 300) });
    throw failure;
  }
}

module.exports = { callApi, invoke, uploadImage };
