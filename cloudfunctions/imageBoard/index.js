const cloud = require('wx-server-sdk');
const { createHandler } = require('./service');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const handler = createHandler({ cloud, db: cloud.database(), env: process.env });

// 不信任客户端传入的 openid / isAdmin，身份仅取自微信云调用上下文。
exports.main = async (event, context = {}) => handler(event || {}, {
  ...cloud.getWXContext(), requestID: context.request_id || context.requestId || ''
});
