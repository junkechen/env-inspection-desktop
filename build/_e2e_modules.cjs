// 新模块深度交互回归：详情弹窗 / 表单弹窗 / 评分与决议入口是否可见
// 用法：node build/_e2e_modules.cjs
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startStaticServer } = require('../static_server');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '..', '_e2e_out');
const CHROME = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const CDP_PORT = 9335;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getSession() {
  const GW = 'https://anuanbu1-1-6gjqaydwd067dbb1-1421679372.ap-shanghai.app.tcloudbase.com/api';
  const res = await fetch(GW, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TCB-Env': 'anuanbu1-1-6gjqaydwd067dbb1' },
    body: JSON.stringify({ action: 'login', query: { username: '邴景国', name: '邴景国', password: '123456' } })
  });
  const j = await res.json();
  if (!j || j.code !== 0) throw new Error('登录失败');
  return j.user;
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.handlers = new Map();
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else if (m.method) (this.handlers.get(m.method) || []).forEach(h => h(m.params));
    };
  }
  on(m, fn) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(fn); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 40000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
    return r.result && r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const results = [];
function check(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${ok ? '' : '  -> ' + JSON.stringify(detail)}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const user = await getSession();
  const { server, port } = await startStaticServer(path.join(ROOT, 'app'));
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e2-'));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--window-size=1440,900', `--user-data-dir=${dir}`, `--remote-debugging-port=${CDP_PORT}`, 'about:blank'], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = l.find(t => t.type === 'page');
      if (target) break;
    } catch (e) {}
  }
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

  const errors = [];
  cdp.on('Runtime.exceptionThrown', p => {
    errors.push(String(((p.exceptionDetails || {}).exception || {}).description || (p.exceptionDetails || {}).text).slice(0, 300));
  });
  cdp.on('Runtime.consoleAPICalled', p => {
    if (p.type === 'error') errors.push((p.args || []).map(a => a.value ?? a.description).join(' ').slice(0, 300));
  });

  await cdp.send('Page.navigate', { url: base + '/' });
  await sleep(3000);
  await cdp.eval(`(() => {
    const inputs = [...document.querySelectorAll('.login-card input')];
    const setVal = (el, v) => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal(inputs[0], ${JSON.stringify(user.username || user.name)});
    setVal(inputs[1], '123456');
    return true;
  })()`);
  await sleep(400);
  await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/登\\s*录/.test(x.innerText||'')); if(b)b.click(); return !!b; })()`);
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    if (await cdp.eval(`!!document.querySelector('.menu .menu-item')`)) break;
  }
  await sleep(1500);

  // ---------- 合理化建议 ----------
  await cdp.eval(`(() => { location.hash = '#/suggestions'; return true; })()`);
  await sleep(3000);
  const sugRow = await cdp.eval(`(() => {
    const rows = document.querySelectorAll('.el-table__body tbody tr');
    if (!rows.length) return { ok: false, rows: 0 };
    const btns = [...rows[0].querySelectorAll('button')].map(b => (b.innerText || '').trim());
    return { ok: true, rows: rows.length, btns };
  })()`);
  check('建议列表有数据行', sugRow.rows > 0, sugRow);

  // 点第一行「详情」
  const sugDetail = await cdp.eval(`(() => {
    const rows = document.querySelectorAll('.el-table__body tbody tr');
    if (!rows.length) return { clicked: false };
    const b = [...rows[0].querySelectorAll('button')].find(x => /详情/.test(x.innerText || ''));
    if (!b) return { clicked: false, btns: [...rows[0].querySelectorAll('button')].map(x => x.innerText) };
    b.click();
    return { clicked: true };
  })()`);
  await sleep(1500);
  const sugDialog = await cdp.eval(`(() => {
    const d = document.querySelector('.el-dialog');
    if (!d) return { open: false };
    const t = (d.innerText || '').replace(/\\s+/g, ' ');
    return {
      open: true, len: t.length, head: t.slice(0, 180),
      hasScore: /评分|可行性|效益|创新/.test(t),
      hasWeighted: /加权|均分/.test(t),
      hasLike: /点赞|赞/.test(t)
    };
  })()`);
  check('建议详情弹窗可打开且有内容', sugDialog.open && sugDialog.len > 40, sugDialog);
  check('建议详情含评分/加权/点赞区域', sugDialog.hasScore || sugDialog.hasWeighted, sugDialog);
  await cdp.eval(`(() => { const c=document.querySelector('.el-dialog__headerbtn'); if(c)c.click(); return true; })()`);
  await sleep(800);

  // 新增建议弹窗字段完整性
  const sugCreate = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /提报建议|新增建议|新增/.test(x.innerText || ''));
    if (!b) return { open: false, btns: [...document.querySelectorAll('button')].map(x => (x.innerText||'').trim()).filter(Boolean) };
    b.click(); return { open: true };
  })()`);
  await sleep(1200);
  const sugForm = await cdp.eval(`(() => {
    const d = document.querySelector('.el-dialog');
    if (!d) return { shown: false };
    const labels = [...d.querySelectorAll('.el-form-item__label')].map(x => (x.innerText || '').trim());
    const t = (d.innerText || '').replace(/\\s+/g, ' ');
    return { shown: true, labels, len: t.length, sample: t.slice(0, 200) };
  })()`);
  check('建议新增弹窗可打开', sugCreate.open && sugForm.shown, { sugCreate, sugForm });
  console.log('       表单字段:', JSON.stringify(sugForm.labels));
  await cdp.eval(`(() => { const c=document.querySelector('.el-dialog__headerbtn'); if(c)c.click(); return true; })()`);
  await sleep(600);

  // ---------- 模块考核落实单 ----------
  await cdp.eval(`(() => { location.hash = '#/assessments'; return true; })()`);
  await sleep(3000);
  const asmRow = await cdp.eval(`(() => {
    const rows = document.querySelectorAll('.el-table__body tbody tr');
    return { rows: rows.length, btns: rows.length ? [...rows[0].querySelectorAll('button')].map(b => (b.innerText || '').trim()) : [] };
  })()`);
  check('落实单列表有数据行', asmRow.rows > 0, asmRow);

  const asmDetail = await cdp.eval(`(() => {
    const rows = document.querySelectorAll('.el-table__body tbody tr');
    if (!rows.length) return { clicked: false };
    const b = [...rows[0].querySelectorAll('button')].find(x => /详情/.test(x.innerText || ''));
    if (!b) return { clicked: false };
    b.click(); return { clicked: true };
  })()`);
  await sleep(1800);
  const asmDialog = await cdp.eval(`(() => {
    const d = document.querySelector('.el-dialog');
    if (!d) return { open: false };
    const t = (d.innerText || '').replace(/\\s+/g, ' ');
    return {
      open: true, len: t.length, head: t.slice(0, 220),
      hasSign: /签字|确认/.test(t), hasCorrective: /纠正措施|整改措施/.test(t),
      hasReview: /审核|闭环/.test(t), hasPdf: /PDF/.test(t)
    };
  })()`);
  check('落实单详情弹窗可打开且有内容', asmDialog.open && asmDialog.len > 60, asmDialog);
  check('落实单详情含签字/纠正/审核要素', asmDialog.hasSign || asmDialog.hasCorrective || asmDialog.hasReview, asmDialog);
  console.log('       详情摘要:', asmDialog.head);

  // 下发弹窗
  await cdp.eval(`(() => { const c=document.querySelector('.el-dialog__headerbtn'); if(c)c.click(); return true; })()`);
  await sleep(800);
  const asmCreate = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /下发|新增/.test(x.innerText || ''));
    if (!b) return { open: false };
    b.click(); return { open: true };
  })()`);
  await sleep(1200);
  const asmForm = await cdp.eval(`(() => {
    const d = document.querySelector('.el-dialog');
    if (!d) return { shown: false };
    return { shown: true, labels: [...d.querySelectorAll('.el-form-item__label')].map(x => (x.innerText || '').trim()) };
  })()`);
  check('落实单下发弹窗可打开', asmCreate.open && asmForm.shown, { asmCreate, asmForm });
  console.log('       表单字段:', JSON.stringify(asmForm.labels));
  await cdp.eval(`(() => { const c=document.querySelector('.el-dialog__headerbtn'); if(c)c.click(); return true; })()`);
  await sleep(600);

  // ---------- AI 隐患识别 ----------
  await cdp.eval(`(() => { location.hash = '#/ai-hazard'; return true; })()`);
  await sleep(2500);
  const aiPage = await cdp.eval(`(() => {
    const t = (document.getElementById('app').innerText || '').replace(/\\s+/g, ' ');
    const btns = [...document.querySelectorAll('button')].map(b => (b.innerText || '').trim()).filter(Boolean);
    return { len: t.length, hasDrop: /拖拽|粘贴/.test(t), btns: btns.slice(0, 12) };
  })()`);
  check('AI 识别页含上传/粘贴与识别按钮', aiPage.hasDrop && aiPage.btns.some(b => /识别/.test(b)), aiPage);

  // 选中图片后「开始识别」按钮是否启用
  const aiBtnState = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /开始 AI 识别|识别/.test(x.innerText || ''));
    if (!b) return { found: false };
    return { found: true, disabled: !!b.disabled || b.classList.contains('is-disabled') };
  })()`);
  check('未选图时识别按钮为禁用态（防止空请求）', aiBtnState.found && aiBtnState.disabled, aiBtnState);

  // ---------- 仪表盘时间范围自定义 ----------
  await cdp.eval(`(() => { location.hash = '#/'; return true; })()`);
  await sleep(2500);
  const custom = await cdp.eval(`(() => {
    const lab = [...document.querySelectorAll('.el-radio-button__inner, .el-radio__label')].find(x => /自定义/.test(x.innerText || ''));
    if (!lab) return { clicked: false };
    lab.click(); return { clicked: true };
  })()`);
  await sleep(800);
  const picker = await cdp.eval(`(() => {
    const p = document.querySelector('.el-date-editor');
    return { present: !!p, count: document.querySelectorAll('.el-date-editor').length };
  })()`);
  check('统计周期选自定义后出现日期范围选择器', custom.clicked && picker.present, { custom, picker });

  const before = await cdp.eval(`(() => (document.querySelector('.stat-grid, .cards, .content').innerText || '').replace(/\\s+/g,' ').slice(0,200))()`);
  check('仪表盘主区正常渲染', before.length > 50, before.slice(0, 100));

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'custom_range.png'), Buffer.from(shot.data, 'base64'));

  const realErrors = errors.filter(e => !/favicon|net::ERR|Failed to load resource/i.test(e));
  check('全程无未捕获异常', realErrors.length === 0, realErrors.slice(0, 5));

  fs.writeFileSync(path.join(OUT, 'modules_report.json'), JSON.stringify({ results, errors }, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n结果：通过 ${results.length - failed} / 失败 ${failed}`);

  cdp.close(); try { chrome.kill(); } catch (e) {} server.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('失败:', e && e.stack); process.exit(1); });
