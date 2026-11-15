// 打包产物全功能回归：启动 dist_release/win-unpacked 的真实 Electron，
// 走真实登录 → 逐路由渲染 → 三个新增模块的列表/详情/表单弹窗，
// 并确认 window.electronAPI（导出/更新等 IPC 能力）已注入。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'dist_release', 'win-unpacked', 'GZ环保巡查管理系统.exe');
const OUT = path.join(ROOT, '..', '_e2e_out');
const APP_VER = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).version;
const P = 9355;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const GW = 'https://anuanbu1-1-6gjqaydwd067dbb1-1421679372.ap-shanghai.app.tcloudbase.com/api';

const results = [];
function check(s, ok, d) { results.push({ s, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${ok ? '' : '  -> ' + JSON.stringify(d)}`); }

(async () => {
  if (!fs.existsSync(EXE)) throw new Error('未找到打包产物: ' + EXE);
  const r0 = await fetch(GW, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TCB-Env': 'anuanbu1-1-6gjqaydwd067dbb1' }, body: JSON.stringify({ action: 'login', query: { username: '邴景国', name: '邴景国', password: '123456' } }) });
  const u = (await r0.json()).user;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-'));
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--remote-debugging-port=${P}`, `--user-data-dir=${dir}`], { stdio: 'ignore', env });

  let t = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    try {
      const l = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
      t = l.find(x => x.type === 'page' && /^http:\/\/127\.0\.0\.1/.test(x.url));
      if (t) break;
    } catch (e) {}
  }
  if (!t) throw new Error('打包应用未就绪');
  console.log('页面:', t.url);

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map(); const errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') {
      const dsc = String(((m.exceptionDetails || {}).exception || {}).description || '');
      if (!/favicon|net::ERR/i.test(dsc)) errors.push(dsc.slice(0, 300));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const s = (m.params.args || []).map(a => a.value ?? a.description).join(' ');
      if (!/favicon|net::ERR|Failed to load resource/i.test(s)) errors.push(s.slice(0, 300));
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('t ' + method)); } }, 40000); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text).slice(0, 400)); return r.result && r.result.value; };
  await send('Runtime.enable'); await send('Page.enable');

  // 真实 UI 登录
  await sleep(2000);
  await ev(`(() => { const ins=[...document.querySelectorAll('.login-card input')]; const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(ins[0], ${JSON.stringify(u.username)}); ins[0].dispatchEvent(new Event('input',{bubbles:true})); s.call(ins[1],'123456'); ins[1].dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await sleep(400);
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/登\\s*录/.test(x.innerText||'')); b&&b.click(); return 1; })()`);
  let okLogin = false;
  for (let i = 0; i < 40; i++) { await sleep(800); if (await ev(`!!document.querySelector('.menu .menu-item')`)) { okLogin = true; break; } }
  check('打包应用可登录并进入主界面', okLogin, {});
  await sleep(1500);

  const menus = await ev(`[...document.querySelectorAll('.menu .menu-item')].map(x => (x.innerText||'').trim())`);
  check('菜单含三个新增模块', ['合理化建议', 'AI 隐患识别', '模块考核落实单'].every(m => menus.includes(m)), menus);

  const ROUTES = [
    ['/', '仪表盘'], ['/suggestions', '合理化建议'], ['/ai-hazard', 'AI 隐患识别'],
    ['/assessments', '模块考核落实单'], ['/hazards', '隐患管理'], ['/announcements', '公告栏'],
    ['/messages', '消息催办'], ['/departments', '部门/车间'], ['/users', '用户管理'],
    ['/work-permits', '作业票签批'], ['/trainings', '安全教育培训'], ['/config', '配置管理']
  ];
  for (const [p, name] of ROUTES) {
    await ev(`(() => { location.hash = ${JSON.stringify('#' + p)}; return 1; })()`);
    await sleep(2600);
    const st = await ev(`(() => {
      const root = document.getElementById('app');
      const txt = (root.innerText||'').replace(/\\s+/g,' ');
      return { fatal: /渲染出错|页面加载失败/.test(txt), len: txt.length, boot: !!root.querySelector('.app-boot') };
    })()`);
    check(`渲染 ${name} (${p})`, !st.fatal && !st.boot && st.len > 60, st);
  }

  // 新增模块详情弹窗
  await ev(`(() => { location.hash='#/suggestions'; return 1; })()`); await sleep(2500);
  const sug = await ev(`(async () => {
    const rows = document.querySelectorAll('.el-table__body tbody tr');
    if (!rows.length) return { rows: 0 };
    const b = [...rows[0].querySelectorAll('button')].find(x => /详情/.test(x.innerText||''));
    b && b.click();
    await new Promise(r=>setTimeout(r,1200));
    const d = document.querySelector('.el-dialog');
    return { rows: rows.length, open: !!d, len: d ? (d.innerText||'').length : 0 };
  })()`);
  check('打包应用：建议详情弹窗可打开', sug.rows > 0 && sug.open && sug.len > 40, sug);
  await ev(`(() => { const c=document.querySelector('.el-dialog__headerbtn'); c&&c.click(); return 1; })()`); await sleep(700);

  await ev(`(() => { location.hash='#/assessments'; return 1; })()`); await sleep(2500);
  const asm = await ev(`(async () => {
    const rows = document.querySelectorAll('.el-table__body tbody tr');
    if (!rows.length) return { rows: 0 };
    const b = [...rows[0].querySelectorAll('button')].find(x => /详情/.test(x.innerText||''));
    b && b.click();
    await new Promise(r=>setTimeout(r,1500));
    const d = document.querySelector('.el-dialog');
    return { rows: rows.length, open: !!d, len: d ? (d.innerText||'').length : 0 };
  })()`);
  check('打包应用：落实单详情弹窗可打开', asm.rows > 0 && asm.open && asm.len > 60, asm);
  await ev(`(() => { const c=document.querySelector('.el-dialog__headerbtn'); c&&c.click(); return 1; })()`); await sleep(700);

  // IPC 能力
  const ipc = await ev(`(async () => {
    const v = await window.electronAPI.getAppVersion();
    const cfg = await window.electronAPI.getUpdateConfig().catch(() => null);
    return { version: v, hasUpdateCfg: !!cfg, keys: Object.keys(window.electronAPI) };
  })()`);
  check('electronAPI 注入完整且版本为 v' + APP_VER,
    String(ipc.version).indexOf(APP_VER) === 0 &&
    ipc.keys.includes('saveXlsxEnhanced') && ipc.keys.includes('exportPdf') &&
    ipc.keys.includes('showItemInFolder'), ipc);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'packaged_login.png'), Buffer.from(shot.data, 'base64'));

  check('全程无未捕获异常', errors.length === 0, errors.slice(0, 4));
  fs.writeFileSync(path.join(OUT, 'packaged_report.json'), JSON.stringify({ results, errors, ipc }, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n结果：通过 ${results.length - failed} / 失败 ${failed}`);

  ws.close();
  try { child.kill(); } catch (e) {}
  await sleep(1200);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('失败:', e.stack); process.exit(1); });
