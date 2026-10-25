const { callApi, invoke } = require('../../utils/api');
const { formatTime } = require('../../utils/time');
const MAX_BYTES = 2 * 1024 * 1024;

Page({
  data: {
    loading: true, isAdmin: false, openid: '', error: '', busy: false,
    imageUrl: '', updatedText: '', version: 0, selectedPath: '', selectedSize: '',
    notice: '', busyText: '', currentImageError: false
  },
  onLoad() { this.reload(); },
  async reload() {
    if (this.data.busy) return;
    this.setData({ loading: true, error: '', selectedPath: '', notice: '', currentImageError: false });
    try {
      const identity = await callApi('identity');
      this.setData({ isAdmin: identity.isAdmin, openid: identity.openid });
      if (identity.isAdmin) {
        const current = await callApi('getCurrent');
        this.setData({ imageUrl: current.imageUrl || '', updatedText: formatTime(current.updatedAt), version: current.version });
      }
    } catch (error) {
      this.setData({ error: error.message });
    } finally {
      this.setData({ loading: false });
    }
  },
  copyOpenid() {
    if (this.data.openid) wx.setClipboardData({ data: this.data.openid });
  },
  async chooseImage() {
    if (this.data.busy || this.data.loading || this.data.error || !this.data.isAdmin) return;
    try {
      const result = await invoke(wx.chooseMedia, { count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['original'] });
      const file = result.tempFiles[0];
      if (!file || !file.size || file.size > MAX_BYTES) throw new Error('请选择不超过 2MB 的图片，较大图片请先压缩');
      const info = await invoke(wx.getImageInfo, { src: file.tempFilePath });
      if (!['jpeg', 'jpg', 'png', 'webp'].includes(info.type)) throw new Error('仅支持 JPG、PNG、WebP 图片，请先转换格式');
      this.setData({ selectedPath: file.tempFilePath, selectedSize: `${(file.size / 1024).toFixed(0)} KB`, notice: '' });
    } catch (error) {
      if (/cancel/.test(error.errMsg || '')) return;
      wx.showModal({ title: '无法选择图片', content: error.message || '请检查相册授权或微信隐私授权后重试', showCancel: false });
    }
  },
  async publish() {
    if (!this.data.selectedPath || this.data.loading || this.data.busy || this.data.error || !this.data.isAdmin) return;
    // 确认框出现前加锁，防止重复点击提交。
    this.setData({ busy: true, busyText: '等待确认', notice: '' });
    let attempted = false;
    let published = false;
    let phase = 'confirmation';
    try {
      const confirmation = await invoke(wx.showModal, { title: '发布这张图片？', content: '发布后，用户重新打开小程序或下拉刷新时会看到新图片。', confirmText: '确认发布', confirmColor: '#216b55' });
      if (!confirmation.confirm) return;
      phase = 'read';
      this.setData({ busyText: '正在读取图片（最多 10 秒）' });
      wx.showLoading({ title: '正在读取图片', mask: true });
      const fs = wx.getFileSystemManager();
      const file = await invoke(fs.readFile.bind(fs), { filePath: this.data.selectedPath, encoding: 'base64' }, {
        timeoutMs: 10000, timeoutCode: 'READ_TIMEOUT', timeoutMessage: '读取图片超时，请重新选择图片'
      });
      phase = 'publish';
      this.setData({ busyText: '正在上传并发布（最多等待 45 秒）' });
      wx.showLoading({ title: '正在上传并发布', mask: true });
      attempted = true;
      const result = await callApi('publish', { imageBase64: file.data, expectedVersion: this.data.version });
      published = true;
      this.setData({ selectedPath: '', version: result.version, notice: '发布成功。用户重新打开或刷新即可看到新图片。' });
    } catch (error) {
      // 超时可能发生在服务端提交之后，刷新确认，禁止盲目自动重试。
      if (phase !== 'confirmation') this.setData({ selectedPath: '' });
      const message = error.message || (phase === 'read' ? '读取图片失败，请重新选择图片' : '无法打开发布确认框，请重试');
      const code = error.code ? `（${error.code}）` : '';
      this.setData({ notice: attempted ? `${message}${code}。请刷新当前图片确认结果后，再选择图片发布。` : `${message}${code}` });
    } finally {
      wx.hideLoading();
      try {
        if (attempted) {
          this.setData({ busyText: '正在确认当前图片（最多 20 秒）' });
          await this.refreshCurrent();
        }
      } finally {
        this.setData({ busy: false, busyText: '' });
        if (published) wx.showToast({ title: '发布成功', icon: 'success' });
      }
    }
  },
  async refreshCurrent() {
    try {
      const current = await callApi('getCurrent');
      this.setData({ imageUrl: current.imageUrl || '', updatedText: formatTime(current.updatedAt), version: current.version, error: '', currentImageError: false });
    } catch (error) {
      this.setData({ error: `刷新当前图片失败：${error.message}。请重新加载确认结果后再发布` });
    }
  },
  onCurrentImageError() { this.setData({ currentImageError: true }); },
  previewSelected() {
    if (this.data.selectedPath) wx.previewImage({ urls: [this.data.selectedPath] });
  },
  goHome() { if (!this.data.busy) wx.reLaunch({ url: '/pages/index/index' }); }
});
