// 快速检查两个新增弹窗的实际可见字段（截图 + 文本）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startStaticServer } = require('../static_server');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '..', '_e2e_out');
const CHROME = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const P = 9336;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const GW = 'https://anuanbu1-1-6gjqaydwd067dbb1-1421679372.ap-shanghai.app.tcloudbase.com/api';
  const r0 = await fetch(GW, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TCB-Env': 'anuanbu1-1-6gjqaydwd067dbb1' }, body: JSON.stringify({ action: 'login', query: { username: '邴景国', name: '邴景国', password: '123456' } }) });
  const u = (await r0.json()).user;
  const { server, port } = await startStaticServer(path.join(ROOT, 'app'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-'));
  const ch = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--window-size=1440,900', `--user-data-dir=${dir}`, `--remote-debugging-port=${P}`, 'about:blank'], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 60; i++) { await sleep(500); try { const l = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json(); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) {} }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const pend = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('t ' + method)); } }, 30000); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text).slice(0, 300)); return r.result && r.result.value; };
  const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(s.data, 'base64')); };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await sleep(3000);
  await ev(`(() => { const ins=[...document.querySelectorAll('.login-card input')]; const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(ins[0], ${JSON.stringify(u.username)}); ins[0].dispatchEvent(new Event('input',{bubbles:true})); s.call(ins[1],'123456'); ins[1].dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await sleep(400);
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/登\\s*录/.test(x.innerText||'')); b&&b.click(); return 1; })()`);
  for (let i = 0; i < 30; i++) { await sleep(700); if (await ev(`!!document.querySelector('.menu .menu-item')`)) break; }
  await sleep(1500);

  await ev(`(() => { location.hash='#/suggestions'; return 1; })()`); await sleep(2500);
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/提报建议|新增建议/.test(x.innerText||'')); b&&b.click(); return 1; })()`);
  await sleep(1500);
  console.log('建议弹窗文本:', await ev(`(() => { const d=document.querySelector('.el-dialog'); return d ? (d.innerText||'').replace(/\\s+/g,' ').slice(0,400) : 'NONE'; })()`));
  console.log('输入控件数:', await ev(`document.querySelectorAll('.el-dialog input, .el-dialog textarea').length`));
  await shot('dlg_suggestion.png');
  await ev(`(() => { const c=document.querySelector('.el-dialog__headerbtn'); c&&c.click(); return 1; })()`); await sleep(800);

  await ev(`(() => { location.hash='#/assessments'; return 1; })()`); await sleep(2500);
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/下发|新增/.test(x.innerText||'')); b&&b.click(); return 1; })()`);
  await sleep(1500);
  console.log('落实单弹窗文本:', await ev(`(() => { const d=document.querySelector('.el-dialog'); return d ? (d.innerText||'').replace(/\\s+/g,' ').slice(0,400) : 'NONE'; })()`));
  console.log('输入控件数:', await ev(`document.querySelectorAll('.el-dialog input, .el-dialog textarea').length`));
  await shot('dlg_assessment.png');
  ws.close(); ch.kill(); server.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch(e => { console.error(e.stack); process.exit(1); });
