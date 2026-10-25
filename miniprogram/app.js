const config = require('./config');

App({
  globalData: { cloudReady: false, setupError: '' },
  onLaunch() {
    if (!wx.cloud) {
      this.globalData.setupError = '当前微信版本过低，请升级微信后重试';
      return;
    }
    if (!config.envId || config.envId.indexOf('请填写') !== -1) {
      this.globalData.setupError = '请先在 miniprogram/config.js 中填写云开发环境 ID';
      return;
    }
    try {
      wx.cloud.init({ env: config.envId });
      this.globalData.cloudReady = true;
    } catch (error) {
      this.globalData.setupError = '云开发初始化失败，请检查环境配置';
      console.error('cloud init failed', error);
    }
  }
});
