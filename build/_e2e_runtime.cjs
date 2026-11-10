// 打包后 Electron 运行时冒烟：启动 win-unpacked 的可执行文件，
// 用 CDP 检查页面是否加载、无启动异常，并验证 IPC 导出的 preload 能力存在。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'dist_release', 'win-unpacked', 'GZ环保巡查管理系统.exe');
const OUT = path.join(ROOT, '..', '_e2e_out');
const P = 9345;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(EXE)) throw new Error('未找到打包后的 exe: ' + EXE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'el-'));
  // 当前开发环境会设置 ELECTRON_RUN_AS_NODE=1（IDE 自身是 Electron 应用），
  // 若不清除，Electron 会以纯 Node 模式启动、不开窗口，冒烟会误判为启动失败。
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--remote-debugging-port=${P}`, `--user-data-dir=${dir}`], { stdio: 'ignore', detached: false, env });

  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try {
      const l = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
      target = l.find(t => t.type === 'page' && /^http:\/\/127\.0\.0\.1/.test(t.url));
      if (target) break;
    } catch (e) { /* not ready */ }
  }
  if (!target) { console.log('FAIL  Electron 未在 60s 内暴露调试端口'); child.kill(); process.exit(1); }
  console.log('目标页面:', target.url, '|', target.title);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map(); const errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(String(((m.exceptionDetails || {}).exception || {}).description || '').slice(0, 300));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push((m.params.args || []).map(a => a.value ?? a.description).join(' ').slice(0, 300));
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('t ' + method)); } }, 30000); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception || {}).description || '').slice(0, 300)); return r.result && r.result.value; };
  await send('Runtime.enable'); await send('Page.enable');
  await sleep(2500);

  const state = await ev(`(() => ({
    title: document.title,
    hasLogin: !!document.querySelector('.login-card'),
    boot: !!document.querySelector('.app-boot'),
    api: !!(window.electronAPI && window.electronAPI.saveXlsxEnhanced && window.electronAPI.exportPdf && window.electronAPI.getAppVersion),
    text: (document.getElementById('app').innerText || '').replace(/\\s+/g, ' ').slice(0, 100)
  }))()`);
  const ver = await ev(`window.electronAPI.getAppVersion()`);
  console.log('页面状态:', JSON.stringify(state), '| app version =', ver);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'electron_runtime.png'), Buffer.from(shot.data, 'base64'));

  const ok = state.title.length > 0 && (state.hasLogin || !state.boot) && state.api && String(ver).indexOf('1.0.33') === 0 && errors.length === 0;
  console.log(ok ? 'PASS  打包后 Electron 运行正常（v' + ver + '）' : 'FAIL  运行异常');
  if (errors.length) console.log('错误:', errors.slice(0, 5));

  ws.close();
  try { child.kill(); } catch (e) {}
  await sleep(1500);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('失败:', e.stack); process.exit(1); });
