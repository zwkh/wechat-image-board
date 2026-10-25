const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else files.push(file);
  }
}
walk(root);
for (const file of files) {
  if (file.endsWith('.json')) JSON.parse(fs.readFileSync(file, 'utf8'));
  if (file.endsWith('.js')) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  }
}
const app = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
for (const page of app.pages) {
  for (const suffix of ['.js', '.json', '.wxml', '.wxss']) {
    if (!fs.existsSync(path.join(root, 'miniprogram', page + suffix))) throw new Error(`页面文件缺失: ${page}${suffix}`);
  }
}
console.log(`检查通过：${files.filter(f => f.endsWith('.js')).length} 个 JS 文件语法、JSON 配置、页面文件完整性。`);
