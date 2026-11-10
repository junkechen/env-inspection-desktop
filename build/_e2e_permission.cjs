// 权限回归：不同角色登录后菜单可见性与页面守卫
//   admin(邴景国/安环部)      → 全部菜单，含「模块考核落实单」
//   inspector(贺跃磊/安环部)   → 有「模块考核落实单」，无「用户管理/配置管理」
//   rectifier(杨育强/生产部)   → 无「模块考核落实单」，无「用户管理」，直访 /config 应被拦回首页
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startStaticServer } = require('../static_server');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '..', '_e2e_out');
const CHROME = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const P = 9339;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const GW = 'https://anuanbu1-1-6gjqaydwd067dbb1-1421679372.ap-shanghai.app.tcloudbase.com/api';

const results = [];
function check(step, ok, detail) { results.push({ step, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${ok ? '' : '  -> ' + JSON.stringify(detail)}`); }

async function session(name) {
  const r = await fetch(GW, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TCB-Env': 'anuanbu1-1-6gjqaydwd067dbb1' }, body: JSON.stringify({ action: 'login', query: { username: name, name, password: '123456' } }) });
  const j = await r.json();
  if (!j || j.code !== 0 || !j.user) throw new Error(name + ' 登录失败: ' + JSON.stringify(j).slice(0, 120));
  return j.user;
}

class C {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.p = new Map();
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const q = this.p.get(m.id); this.p.delete(m.id); m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result); } };
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('t' + method)); } }, 40000); }); }
  async ev(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text).slice(0, 300)); return r.result && r.result.value; }
}

(async () => {
  const { server, port } = await startStaticServer(path.join(ROOT, 'app'));
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q4-'));
  const ch = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--window-size=1440,900', `--user-data-dir=${dir}`, `--remote-debugging-port=${P}`, 'about:blank'], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 60; i++) { await sleep(500); try { const l = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json(); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) {} }
  const cdp = new C(t.webSocketDebuggerUrl);
  await cdp.ready; await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

  async function loginAs(name) {
    await cdp.send('Page.navigate', { url: base + '/' });
    await sleep(2500);
    // 先清掉上一个账号的登录态
    await cdp.ev(`(() => { localStorage.clear(); return 1; })()`);
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(2500);
    await cdp.ev(`(() => { const ins=[...document.querySelectorAll('.login-card input')]; if(ins.length<2) return 0; const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(ins[0], ${JSON.stringify(name)}); ins[0].dispatchEvent(new Event('input',{bubbles:true})); s.call(ins[1],'123456'); ins[1].dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
    await sleep(400);
    await cdp.ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/登\\s*录/.test(x.innerText||'')); b&&b.click(); return 1; })()`);
    for (let i = 0; i < 30; i++) { await sleep(700); if (await cdp.ev(`!!document.querySelector('.menu .menu-item')`)) break; }
    await sleep(1200);
    return await cdp.ev(`[...document.querySelectorAll('.menu .menu-item')].map(x => (x.innerText||'').trim())`);
  }

  // admin
  let menus = await loginAs('邴景国');
  check('admin 菜单含模块考核落实单/用户管理/配置管理',
    menus.includes('模块考核落实单') && menus.includes('用户管理') && menus.includes('配置管理'), menus);
  console.log('       admin 菜单:', JSON.stringify(menus));

  // inspector（安环部，非管理员）
  menus = await loginAs('贺跃磊');
  check('安环部检查员可见模块考核落实单', menus.includes('模块考核落实单'), menus);
  check('安环部检查员不可见用户管理/配置管理', !menus.includes('用户管理') && !menus.includes('配置管理'), menus);
  console.log('       inspector 菜单:', JSON.stringify(menus));

  // rectifier（生产部）
  menus = await loginAs('杨育强');
  check('车间整改人不可见模块考核落实单', !menus.includes('模块考核落实单'), menus);
  check('车间整改人不可见用户管理/配置管理', !menus.includes('用户管理') && !menus.includes('配置管理'), menus);
  console.log('       rectifier 菜单:', JSON.stringify(menus));

  // 直访 /config 应被守卫弹回
  await cdp.ev(`(() => { location.hash = '#/config'; return 1; })()`);
  await sleep(2000);
  const guard = await cdp.ev(`(() => ({ hash: location.hash, hasConfigTitle: /配置管理/.test(document.querySelector('.crumb') && document.querySelector('.crumb').innerText || '') }))()`);
  check('非管理员直访 /config 被拦回首页', guard.hash !== '#/config', guard);

  // 直访 /assessments（非安环部）—— 页面应可见但数据为空或提示无权
  await cdp.ev(`(() => { location.hash = '#/assessments'; return 1; })()`);
  await sleep(2500);
  const asm = await cdp.ev(`(() => {
    const t = (document.getElementById('app').innerText || '').replace(/\\s+/g,' ');
    return { fatal: /页面加载失败|渲染出错/.test(t), rows: document.querySelectorAll('.el-table__body tbody tr').length, snippet: t.slice(0, 120) };
  })()`);
  check('非安环部直访落实单页不崩溃', !asm.fatal, asm);

  fs.writeFileSync(path.join(OUT, 'perm_report.json'), JSON.stringify({ results }, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n结果：通过 ${results.length - failed} / 失败 ${failed}`);
  cdp.ws.close(); ch.kill(); server.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(1); });
