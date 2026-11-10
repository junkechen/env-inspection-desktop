// AI 识别前端链路验证（云端账户余额不足时的替代方案）：
//   拦截 fetch 的 aiHazard 请求返回构造响应，验证
//   ① 结果卡片渲染（标题/类别/等级/风险点/建议）
//   ② 「转为正式上报」回填表单
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startStaticServer } = require('../static_server');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '..', '_e2e_out');
const CHROME = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const P = 9341;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const STUB = {
  code: 0,
  analysis: {
    hasHazard: true,
    title: '在线监测设备采样探头积尘',
    category: '废气排放',
    businessType: '安全业务',
    severity: '较大',
    confidence: 0.86,
    description: '废气排口在线监测采样探头表面积尘明显，可能影响监测数据准确性。',
    riskPoints: ['采样数据失真导致超标漏报', '影响环保验收与台账真实性'],
    suggestion: '立即清理采样探头并校准，建立每周清洁与校准记录。'
  },
  raw: '{"stub":true}'
};

const results = [];
function check(s, ok, d) { results.push({ s, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${ok ? '' : '  -> ' + JSON.stringify(d)}`); }

(async () => {
  const GW = 'https://anuanbu1-1-6gjqaydwd067dbb1-1421679372.ap-shanghai.app.tcloudbase.com/api';
  const r0 = await fetch(GW, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TCB-Env': 'anuanbu1-1-6gjqaydwd067dbb1' }, body: JSON.stringify({ action: 'login', query: { username: '邴景国', name: '邴景国', password: '123456' } }) });
  const u = (await r0.json()).user;
  const { server, port } = await startStaticServer(path.join(ROOT, 'app'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai2-'));
  const ch = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--window-size=1440,900', `--user-data-dir=${dir}`, `--remote-debugging-port=${P}`, 'about:blank'], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 60; i++) { await sleep(500); try { const l = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json(); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) {} }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('t ' + method)); } }, 60000); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text).slice(0, 400)); return r.result && r.result.value; };
  await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');

  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const orig = window.fetch;
      window.__aiStubCalls = 0;
      window.fetch = function(url, opts) {
        try {
          const body = opts && opts.body ? JSON.parse(opts.body) : null;
          if (body && body.action === 'aiHazard') {
            window.__aiStubCalls++;
            return Promise.resolve(new Response(JSON.stringify(${JSON.stringify(STUB)}), { status: 200, headers: { 'Content-Type': 'application/json' } }));
          }
        } catch (e) {}
        return orig.apply(this, arguments);
      };
    })();`
  });

  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await sleep(3000);
  await ev(`(() => { const ins=[...document.querySelectorAll('.login-card input')]; const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(ins[0], ${JSON.stringify(u.username)}); ins[0].dispatchEvent(new Event('input',{bubbles:true})); s.call(ins[1],'123456'); ins[1].dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await sleep(400);
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/登\\s*录/.test(x.innerText||'')); b&&b.click(); return 1; })()`);
  for (let i = 0; i < 30; i++) { await sleep(700); if (await ev(`!!document.querySelector('.menu .menu-item')`)) break; }
  await sleep(1200);

  await ev(`(() => { location.hash='#/ai-hazard'; return 1; })()`); await sleep(2500);

  // 直接向 file input 塞文件
  const doc = await send('DOM.getDocument', { depth: -1 });
  const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { files: [path.join(ROOT, '..', '_tpl_report_1.png')], nodeId: q.nodeId });
  await sleep(2500);

  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/开始 AI 识别/.test(x.innerText||'')); b&&b.click(); return 1; })()`);
  await sleep(3000);

  const render = await ev(`(() => {
    const t = (document.getElementById('app').innerText || '').replace(/\\s+/g, ' ');
    return {
      calls: window.__aiStubCalls,
      title: /在线监测设备采样探头积尘/.test(t),
      category: /废气排放/.test(t),
      severity: /较大/.test(t),
      confidence: /86%/.test(t),
      risks: /采样数据失真/.test(t),
      suggestion: /立即清理采样探头/.test(t),
      convertBtn: [...document.querySelectorAll('button')].some(b => /转为正式上报/.test(b.innerText || ''))
    };
  })()`);
  check('AI 请求到达（桩命中）', render.calls === 1, render);
  check('结果卡片渲染标题/类别/等级/置信度', render.title && render.category && render.severity && render.confidence, render);
  check('风险点与整改建议渲染', render.risks && render.suggestion, render);
  check('出现「转为正式上报」入口', render.convertBtn, render);

  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'ai_stub_result.png'), Buffer.from(shot1.data, 'base64'));

  // 转为正式上报：表单回填校验
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/转为正式上报/.test(x.innerText||'')); b&&b.click(); return 1; })()`);
  await sleep(1500);
  const form = await ev(`(() => {
    const d = document.querySelector('.el-dialog');
    if (!d) return { open: false };
    const vals = [...d.querySelectorAll('input')].map(i => i.value).filter(Boolean);
    const areas = [...d.querySelectorAll('textarea')].map(i => i.value).filter(Boolean);
    return { open: true, vals: vals.slice(0, 8), areas: areas.map(a => a.slice(0, 40)), text: (d.innerText || '').replace(/\\s+/g, ' ').slice(0, 200) };
  })()`);
  check('转为上报弹窗打开并回填标题/描述', form.open && form.vals.some(v => /采样探头/.test(v)), form);
  console.log('       回填值:', JSON.stringify(form.vals), JSON.stringify(form.areas));

  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'ai_convert.png'), Buffer.from(shot2.data, 'base64'));

  fs.writeFileSync(path.join(OUT, 'ai_stub_report.json'), JSON.stringify({ results }, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n结果：通过 ${results.length - failed} / 失败 ${failed}`);
  ws.close(); ch.kill(); server.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(1); });
