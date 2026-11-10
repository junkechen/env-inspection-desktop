// AI 隐患识别端到端：真实上传一张图片 → 点击识别 → 等结果 → 校验返回结构
// 用法：node build/_e2e_ai.cjs [图片路径]
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startStaticServer } = require('../static_server');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '..', '_e2e_out');
const CHROME = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const P = 9340;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const IMG = process.argv[2] || path.join(ROOT, '..', '_tpl_report_1.png');

(async () => {
  const GW = 'https://anuanbu1-1-6gjqaydwd067dbb1-1421679372.ap-shanghai.app.tcloudbase.com/api';
  const r0 = await fetch(GW, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TCB-Env': 'anuanbu1-1-6gjqaydwd067dbb1' }, body: JSON.stringify({ action: 'login', query: { username: '邴景国', name: '邴景国', password: '123456' } }) });
  const u = (await r0.json()).user;
  const { server, port } = await startStaticServer(path.join(ROOT, 'app'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-'));
  const ch = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--window-size=1440,900', `--user-data-dir=${dir}`, `--remote-debugging-port=${P}`, 'about:blank'], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 60; i++) { await sleep(500); try { const l = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json(); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) {} }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const pend = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('t ' + method)); } }, 60000); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text).slice(0, 400)); return r.result && r.result.value; };
  await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');

  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await sleep(3000);
  await ev(`(() => { const ins=[...document.querySelectorAll('.login-card input')]; const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(ins[0], ${JSON.stringify(u.username)}); ins[0].dispatchEvent(new Event('input',{bubbles:true})); s.call(ins[1],'123456'); ins[1].dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await sleep(400);
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/登\\s*录/.test(x.innerText||'')); b&&b.click(); return 1; })()`);
  for (let i = 0; i < 30; i++) { await sleep(700); if (await ev(`!!document.querySelector('.menu .menu-item')`)) break; }
  await sleep(1200);

  await ev(`(() => { location.hash='#/ai-hazard'; return 1; })()`); await sleep(2500);

  // 用 CDP 设置文件输入
  const doc = await send('DOM.getDocument', { depth: -1 });
  const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
  if (!q.nodeId) throw new Error('未找到 file input');
  await send('DOM.setFileInputFiles', { files: [IMG], nodeId: q.nodeId });
  await sleep(2500);

  const afterPick = await ev(`(() => {
    const imgs = [...document.querySelectorAll('img')].filter(i => (i.src||'').startsWith('blob:'));
    const b = [...document.querySelectorAll('button')].find(x => /开始 AI 识别/.test(x.innerText||''));
    return { preview: imgs.length, btnDisabled: b ? (!!b.disabled || b.classList.contains('is-disabled')) : null, tip: (document.getElementById('app').innerText||'').replace(/\\s+/g,' ').slice(0,150) };
  })()`);
  console.log('选图后:', JSON.stringify(afterPick));

  // 点击识别，轮询结果（AI 可能 30-90s）
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/开始 AI 识别/.test(x.innerText||'')); b&&b.click(); return 1; })()`);
  let result = null;
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const st = await ev(`(() => {
      const t = (document.getElementById('app').innerText||'').replace(/\\s+/g,' ');
      const btns = [...document.querySelectorAll('button')].map(b => (b.innerText||'').trim());
      const errTip = [...document.querySelectorAll('.el-message')].map(e => (e.innerText||'').trim());
      return {
        // 结果判定：出现「转为正式上报」按钮 或「未识别出明显隐患」卡片
        done: btns.some(b => /转为正式上报/.test(b)) || /未识别出明显隐患/.test(t),
        noHazard: /未识别出明显隐患/.test(t),
        errTip,
        len: t.length
      };
    })()`);
    if (st.done) { result = st; break; }
    if (st.errTip.length) { result = st; break; }
    if (i % 5 === 0) console.log(`  [${(i + 1) * 3}s] 等待识别… len=${st.len}`);
  }
  console.log('识别结果:', result ? JSON.stringify(result) : '（超时未出现）');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'ai_result.png'), Buffer.from(shot.data, 'base64'));

  console.log(result && result.done && !(result.errTip || []).length ? 'PASS  AI 识别返回结构化结果' : 'FAIL  AI 识别未成功');
  ws.close(); ch.kill(); server.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  process.exit(result && result.done && !(result.errTip || []).length ? 0 : 1);
})().catch(e => { console.error(e.stack); process.exit(1); });
