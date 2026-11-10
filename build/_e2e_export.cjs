// 导出能力回归：注入 electronAPI 桩，点击「导出 Excel / 导出 PDF」，
// 断言 saveXlsxEnhanced 收到非空 buffer、exportPdf 收到含关键字段的 HTML。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startStaticServer } = require('../static_server');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '..', '_e2e_out');
const CHROME = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const P = 9338;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function check(step, ok, detail) { results.push({ step, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${ok ? '' : '  -> ' + JSON.stringify(detail)}`); }

(async () => {
  const GW = 'https://anuanbu1-1-6gjqaydwd067dbb1-1421679372.ap-shanghai.app.tcloudbase.com/api';
  const r0 = await fetch(GW, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TCB-Env': 'anuanbu1-1-6gjqaydwd067dbb1' }, body: JSON.stringify({ action: 'login', query: { username: '邴景国', name: '邴景国', password: '123456' } }) });
  const u = (await r0.json()).user;
  const { server, port } = await startStaticServer(path.join(ROOT, 'app'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q3-'));
  const ch = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--window-size=1440,900', `--user-data-dir=${dir}`, `--remote-debugging-port=${P}`, 'about:blank'], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 60; i++) { await sleep(500); try { const l = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json(); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) {} }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const pend = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('t ' + method)); } }, 40000); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text).slice(0, 400)); return r.result && r.result.value; };
  await send('Page.enable'); await send('Runtime.enable');

  // 在页面加载前注入 electronAPI 桩（main world，addScriptToEvaluateOnNewDocument）
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__e2eExports = { xlsx: [], pdf: [] };
      window.electronAPI = {
        saveXlsxEnhanced: (p) => { window.__e2eExports.xlsx.push({ name: p && p.defaultName, len: (p && p.buffer || '').length }); return Promise.resolve({ canceled: false, filePath: 'C:/tmp/' + (p && p.defaultName) }); },
        saveBuffer: (p) => { window.__e2eExports.xlsx.push({ name: p && p.defaultName, len: 0 }); return Promise.resolve({ canceled: false }); },
        exportPdf: (p) => { window.__e2eExports.pdf.push({ name: p && p.defaultName, htmlLen: (p && p.html || '').length, hasTable: /<table/i.test(p && p.html || '') }); return Promise.resolve({ canceled: false, filePath: 'C:/tmp/' + (p && p.defaultName) }); },
        fetchImageUrl: () => Promise.resolve(''),
        getAppVersion: () => Promise.resolve('1.0.33-e2e'),
        getUpdateConfig: () => Promise.resolve({}),
        fetchText: () => Promise.resolve(''),
        openExternal: () => Promise.resolve(true)
      };`
  });

  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await sleep(3000);
  await ev(`(() => { const ins=[...document.querySelectorAll('.login-card input')]; const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(ins[0], ${JSON.stringify(u.username)}); ins[0].dispatchEvent(new Event('input',{bubbles:true})); s.call(ins[1],'123456'); ins[1].dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await sleep(400);
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/登\\s*录/.test(x.innerText||'')); b&&b.click(); return 1; })()`);
  for (let i = 0; i < 30; i++) { await sleep(700); if (await ev(`!!document.querySelector('.menu .menu-item')`)) break; }
  await sleep(1500);

  // ---- 合理化建议 Excel 导出 ----
  await ev(`(() => { location.hash='#/suggestions'; return 1; })()`); await sleep(2500);
  const sugXlsx = await ev(`(async () => {
    const b=[...document.querySelectorAll('button')].find(x=>/导出\\s*Excel|Excel/.test(x.innerText||''));
    if(!b) return { clicked:false };
    b.click();
    await new Promise(r=>setTimeout(r,2500));
    return { clicked:true, xlsx: window.__e2eExports.xlsx.slice() };
  })()`);
  check('合理化建议 Excel 导出产出非空文件', sugXlsx.clicked && sugXlsx.xlsx.length > 0 && sugXlsx.xlsx[0].len > 1000, sugXlsx);

  // ---- 落实单 PDF + Excel 导出 ----
  await ev(`(() => { location.hash='#/assessments'; return 1; })()`); await sleep(2500);
  const asmPdf = await ev(`(async () => {
    const b=[...document.querySelectorAll('button')].find(x=>/导出\\s*PDF|PDF/.test(x.innerText||''));
    if(!b) return { clicked:false, btns:[...document.querySelectorAll('button')].map(x=>(x.innerText||'').trim()) };
    b.click();
    await new Promise(r=>setTimeout(r,5000));
    return { clicked:true, pdf: window.__e2eExports.pdf.slice() };
  })()`);
  check('落实单 PDF 导出生成模板 HTML', asmPdf.clicked && asmPdf.pdf.length > 0 && asmPdf.pdf[0].htmlLen > 500 && asmPdf.pdf[0].hasTable, asmPdf);

  const asmXlsx = await ev(`(async () => {
    const before = window.__e2eExports.xlsx.length;
    const b=[...document.querySelectorAll('button')].find(x=>/导出\\s*Excel|Excel/.test(x.innerText||''));
    if(!b) return { clicked:false };
    b.click();
    await new Promise(r=>setTimeout(r,2500));
    return { clicked:true, added: window.__e2eExports.xlsx.slice(before) };
  })()`);
  check('落实单 Excel 导出产出非空文件', asmXlsx.clicked && asmXlsx.added.length > 0 && asmXlsx.added[0].len > 1000, asmXlsx);

  // ---- 隐患模块（既有功能不回归）----
  await ev(`(() => { location.hash='#/hazards'; return 1; })()`); await sleep(3000);
  const hz = await ev(`(async () => {
    const before = window.__e2eExports.xlsx.length;
    const b=[...document.querySelectorAll('button')].find(x=>/导出\\s*Excel|Excel/.test(x.innerText||''));
    if(!b) return { clicked:false, btns:[...document.querySelectorAll('button')].map(x=>(x.innerText||'').trim()) };
    b.click();
    await new Promise(r=>setTimeout(r,6000));
    return { clicked:true, added: window.__e2eExports.xlsx.slice(before) };
  })()`);
  check('隐患 Excel 导出（既有功能）仍可用', hz.clicked && hz.added.length > 0 && hz.added[0].len > 1000, hz);

  fs.writeFileSync(path.join(OUT, 'export_report.json'), JSON.stringify({ results }, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n结果：通过 ${results.length - failed} / 失败 ${failed}`);
  ws.close(); ch.kill(); server.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(1); });
