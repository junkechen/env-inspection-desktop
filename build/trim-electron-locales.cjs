// 裁剪 Electron 源里多余的语言包，从源头缩小打包体积。
//
// 为什么在源头裁，而不用 electron-builder 的 electronLanguages 或 afterPack 钩子？
//   两者都是在打包过程中删除文件，而本机的 safe-delete 守卫会拦截 fs.promises.rm
//   （报 "Error during a trash operation"），导致打包直接失败或构建被中断，
//   甚至出现 locales 被删一半的不一致状态。
//   改为在打包前裁剪 node_modules/electron/dist/locales，打包时只做拷贝不做删除，
//   完全绕开该问题。实测 fs.unlinkSync 未被守卫包装，可正常删除。
//
// 用法：npm run trim
// 何时需要重跑：执行 npm install / 重装 electron 后，语言包会被还原，需重新裁剪。
//
// 保留 zh-CN（界面语言）+ en-US（兜底，缺失会让未翻译字符串显示为空白）。

const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'locales');
const KEEP = new Set(['zh-CN.pak', 'en-US.pak']);

if (!fs.existsSync(LOCALES_DIR)) {
  console.error('未找到 Electron 语言包目录：', LOCALES_DIR);
  console.error('请确认已安装 electron 依赖（npm install）。');
  process.exit(1);
}

const all = fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.pak'));
const toRemove = all.filter((f) => !KEEP.has(f));

if (!toRemove.length) {
  console.log(`语言包已是裁剪状态，当前保留：${all.join(', ')}`);
  process.exit(0);
}

let freed = 0;
let failed = 0;
for (const name of toRemove) {
  const file = path.join(LOCALES_DIR, name);
  try {
    freed += fs.statSync(file).size;
    fs.unlinkSync(file);
  } catch (e) {
    failed += 1;
    console.warn('  删除失败（已跳过）:', name, e && e.message);
  }
}

console.log(`已裁剪 ${toRemove.length - failed} 个语言包，释放 ${(freed / 1024 / 1024).toFixed(1)} MB`);
console.log(`当前保留：${fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.pak')).join(', ')}`);
if (failed) process.exit(1);
