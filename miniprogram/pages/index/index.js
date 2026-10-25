const { callApi } = require('../../utils/api');
const { formatTime } = require('../../utils/time');
const config = require('../../config');

Page({
  data: { title: config.title, loading: true, imageUrl: '', updatedText: '', error: '', imageError: false },
  onShow() { this.loadCurrent(); },
  onPullDownRefresh() { this.loadCurrent(); },
  async loadCurrent() {
    const request = (this._request || 0) + 1;
    this._request = request;
    this.setData({ loading: true, error: '', imageError: false });
    try {
      const current = await callApi('getCurrent');
      if (request !== this._request) return;
      this.setData({ imageUrl: current.imageUrl || '', updatedText: formatTime(current.updatedAt) });
    } catch (error) {
      if (request === this._request) this.setData({ error: error.message, imageUrl: '', updatedText: '' });
    } finally {
      if (request === this._request) {
        this.setData({ loading: false });
        wx.stopPullDownRefresh();
      }
    }
  },
  onImageError() { this.setData({ imageError: true }); },
  previewImage() {
    if (!this.data.imageUrl || this.data.imageError) return;
    wx.previewImage({ urls: [this.data.imageUrl], current: this.data.imageUrl });
  },
  openAdmin() { wx.navigateTo({ url: '/pages/admin/admin' }); },
  onShareAppMessage() { return { title: this.data.title, path: '/pages/index/index' }; }
});
