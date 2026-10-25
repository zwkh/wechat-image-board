# 项目维护约定

- 用户确认的正式源码目录为 `D:\wechat-image-board`，微信开发者工具也打开此目录。直接在这里修改并用 Git 管理，不通过压缩包同步，不再维护此前 C 盘副本。
- 保留用户配置的 `project.config.json`、`miniprogram/config.js` 和 `project.private.config.json`，除非任务明确需要修改配置。
- 修改前检查 Git 状态，保留用户改动。源码修复与云端部署是不同步骤，未完成真实云环境验证时不要声称发布成功。
- 相关代码修改后运行 `node scripts/check.js` 和 `node --test tests/api.test.js tests/frontend.test.js tests/service.test.js`。
