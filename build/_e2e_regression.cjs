// 真实浏览器回归（CDP 直连，不依赖 playwright / chrome 外部安装）
// 用法：node build/_e2e_regression.cjs
// 流程：
//   1) 用 static_server 起本地静态服务托管 app/ 目录
//   2) 拉起 Playwright 缓存里的 Chromium（--headless=new --remote-debugging-port）
//   3) 通过 CDP 逐路由访问，收集 console error / 未捕获异常 / 关键 DOM 断言
//   4) 输出 JSON 报告与截图
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startStaticServer } = require('../static_server');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'app');
const OUT = path.join(ROOT, '..', '_e2e_out');
const CHROME = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const CDP_PORT = 9333;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 登录：直接向云函数网关取 token + user ----------
async function login() {
  const GW = 'https://anuanbu1-1-6gjqaydwd067dbb1-1421679372.ap-shanghai.app.tcloudbase.com/api';
  const ENV = 'anuanbu1-1-6gjqaydwd067dbb1';
  const res = await fetch(GW, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TCB-Env': ENV },
    body: JSON.stringify({ action: 'login', query: { username: '邴景国', name: '邴景国', password: '123456' } })
  });
  const json = await res.json();
  if (!json || json.code !== 0 || !json.user) throw new Error('登录失败: ' + JSON.stringify(json).slice(0, 200));
  return { token: 'cb_e2e_' + Date.now(), user: json.user };
}

// ---------- 最小 CDP 客户端 ----------
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(new Error('ws error'));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        const hs = this.handlers.get(msg.method) || [];
        hs.forEach(h => h(msg.params));
      }
    };
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 60000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    }
    return r.result && r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

// ---------- 主流程 ----------
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const report = { startedAt: new Date().toISOString(), routes: [], consoleErrors: [], fatal: [] };

  const session = await login();
  console.log('登录成功:', session.user.name, session.user.role, session.user.department);

  const { server, port } = await startStaticServer(APP_DIR);
  const base = `http://127.0.0.1:${port}`;
  console.log('静态服务:', base);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1440,900',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch (e) { /* 尚未就绪 */ }
  }
  if (!target) { throw new Error('Chromium 未就绪'); }

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  // 收集控制台错误 / 未捕获异常
  let current = null;
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error' && p.type !== 'warning') return;
    const text = (p.args || []).map(a => a.value ?? a.description ?? a.type).join(' ');
    if (!text) return;
    const item = { route: current, type: p.type, text: String(text).slice(0, 400) };
    if (p.type === 'error') report.consoleErrors.push(item);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    const desc = (d.exception && d.exception.description) || d.text || 'unknown';
    report.consoleErrors.push({ route: current, type: 'exception', text: String(desc).slice(0, 600) });
  });
  cdp.on('Log.entryAdded', (p) => {
    const e = p.entry || {};
    if (e.level !== 'error') return;
    report.consoleErrors.push({ route: current, type: 'log:' + e.source, text: String(e.text || '').slice(0, 400) });
  });

  // 首次访问（未登录 → 登录页）
  await cdp.send('Page.navigate', { url: base + '/' });
  await sleep(3000);

  // 走真实 UI 登录：填表 → 点「登 录」→ 等跳转首页
  const loginFill = await cdp.eval(`(() => {
    const inputs = [...document.querySelectorAll('.login-card input')];
    if (inputs.length < 2) return { ok: false, count: inputs.length };
    const setVal = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setVal(inputs[0], ${JSON.stringify(session.user.username || session.user.name)});
    setVal(inputs[1], '123456');
    return { ok: true };
  })()`);
  if (!loginFill.ok) throw new Error('未找到登录输入框');
  await sleep(500);
  await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /登\\s*录/.test(x.innerText || ''));
    if (b) b.click();
    return !!b;
  })()`);
  // 等待登录跳转
  let loggedIn = false;
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    const st = await cdp.eval(`(() => ({
      hash: location.hash,
      sidebar: !!document.querySelector('.menu .menu-item'),
      text: (document.getElementById('app').innerText || '').replace(/\\s+/g, ' ').slice(0, 120)
    }))()`);
    if (st.sidebar) { loggedIn = true; console.log('登录成功，已进入主界面:', st.text); break; }
  }
  if (!loggedIn) throw new Error('UI 登录未进入主界面');
  await sleep(1500);

  const ROUTES = [
    { path: '/', name: '仪表盘', expect: ['隐患', '总'] },
    { path: '/suggestions', name: '合理化建议', expect: ['合理化建议'] },
    { path: '/ai-hazard', name: 'AI 隐患识别', expect: ['AI'] },
    { path: '/assessments', name: '模块考核落实单', expect: ['模块考核'] },
    { path: '/hazards', name: '隐患管理', expect: ['隐患'] },
    { path: '/announcements', name: '公告栏', expect: ['公告'] },
    { path: '/messages', name: '消息催办', expect: ['消息'] },
    { path: '/departments', name: '部门/车间', expect: ['部门'] },
    { path: '/users', name: '用户管理', expect: ['用户'] },
    { path: '/work-permits', name: '作业票签批', expect: ['作业票'] },
    { path: '/trainings', name: '安全教育培训', expect: ['培训'] },
    { path: '/config', name: '配置管理', expect: ['配置'] }
  ];

  for (const r of ROUTES) {
    current = r.path;
    const errsBefore = report.consoleErrors.length;
    await cdp.eval(`(() => { location.hash = ${JSON.stringify('#' + r.path)}; return true; })()`);
    await sleep(3000);
    const probe = await cdp.eval(`(() => {
      const root = document.getElementById('app');
      const txt = (root && root.innerText || '').replace(/\\s+/g, ' ').trim();
      return {
        hash: location.hash,
        boot: !!(root && root.querySelector('.app-boot')),
        fatal: !!(root && /页面加载失败/.test(root.innerText || '')),
        len: txt.length,
        head: txt.slice(0, 200),
        hasExpect: ${JSON.stringify(r.expect)}.some(k => txt.includes(k)),
        hasMenu: !!(root && root.querySelector('.menu .menu-item'))
      };
    })()`);
    const errs = report.consoleErrors.slice(errsBefore);
    // 截图
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, r.path === '/' ? 'dashboard' : r.path.slice(1).replace(/\//g, '_') + '.png'), Buffer.from(shot.data, 'base64'));
    } catch (e) { /* ignore */ }
    report.routes.push(Object.assign({ errors: errs.length, errDetail: errs }, probe));
    const ok = !probe.boot && !probe.fatal && probe.len > 20 && probe.hasExpect;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.path.padEnd(14)} len=${probe.len} expect=${probe.hasExpect} fatal=${probe.fatal} err=${errs.length}`);
    if (!ok) console.log('      head:', probe.head);
  }

  // ---------- 交互回归 ----------
  current = '/suggestions';
  const inter = [];
  await cdp.eval(`(() => { location.hash = '#/suggestions'; return true; })()`);
  await sleep(2500);
  // 打开「新增建议」对话框
  const dlg = await cdp.eval(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find(x => /新增|提报|新建/.test(x.innerText || ''));
    if (!b) return { opened: false, buttons: btns.map(x => (x.innerText || '').trim()).filter(Boolean).slice(0, 20) };
    b.click();
    return { opened: true };
  })()`);
  await sleep(1200);
  const dlgText = await cdp.eval(`(() => { const d = document.querySelector('.el-dialog'); return d ? (d.innerText || '').slice(0, 300) : ''; })()`);
  inter.push({ step: 'suggestions 新增对话框', ok: !!dlgText && dlgText.length > 5, detail: dlgText || JSON.stringify(dlg) });
  console.log(inter[0].ok ? 'PASS  建议新增弹窗' : 'FAIL  建议新增弹窗 ' + JSON.stringify(dlg));

  // 关闭弹窗
  await cdp.eval(`(() => { const c = document.querySelector('.el-dialog__headerbtn'); if (c) c.click(); return true; })()`);
  await sleep(800);

  // 仪表盘统计周期切换
  current = '/';
  await cdp.eval(`(() => { location.hash = '#/'; return true; })()`);
  await sleep(2500);
  const timeSwitch = await cdp.eval(`(() => {
    const labels = [...document.querySelectorAll('.el-radio-button__inner, .el-radio__label')].map(x => (x.innerText || '').trim());
    const month = [...document.querySelectorAll('.el-radio-button__inner, .el-radio__label')].find(x => /本月/.test(x.innerText || ''));
    if (month) month.click();
    return { labels, clicked: !!month };
  })()`);
  await sleep(2000);
  const afterMonth = await cdp.eval(`(() => {
    const txt = (document.getElementById('app').innerText || '').replace(/\\s+/g, ' ');
    const m = txt.match(/统计周期[^|]{0,40}/);
    return { snippet: m ? m[0] : txt.slice(0, 160) };
  })()`);
  inter.push({ step: '仪表盘统计周期切换', ok: timeSwitch.clicked, detail: timeSwitch });
  console.log(timeSwitch.clicked ? 'PASS  仪表盘统计周期切换' : 'FAIL  仪表盘统计周期切换 ' + JSON.stringify(timeSwitch));

  report.interactions = inter;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  console.log('\n=== 控制台错误汇总 ===');
  if (!report.consoleErrors.length) console.log('（无）');
  else report.consoleErrors.forEach(e => console.log(`[${e.route}] ${e.type}: ${e.text}`));

  cdp.close();
  try { chrome.kill(); } catch (e) { /* ignore */ }
  server.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(0);
})().catch((e) => {
  console.error('E2E 失败:', e && e.message);
  try { fs.writeFileSync(path.join(OUT, 'fatal.json'), JSON.stringify({ error: String(e && e.stack) }, null, 2)); } catch (x) { /* ignore */ }
  process.exit(1);
});
