// 题库练习 / 题库管理 E2E（v1.0.35）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startStaticServer } = require('../static_server');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '..', '_e2e_out');
const CHROME = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const P = 9356;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const GW = 'https://anuanbu1-1-6gjqaydwd067dbb1-1421679372.ap-shanghai.app.tcloudbase.com/api';

const results = [];
function check(s, ok, d) { results.push({ s, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${ok ? '' : '  -> ' + JSON.stringify(d)}`); }

(async () => {
  const lr = await fetch(GW, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TCB-Env': 'anuanbu1-1-6gjqaydwd067dbb1' }, body: JSON.stringify({ action: 'login', query: { username: '邴景国', name: '邴景国', password: '123456' } }) });
  const u = (await lr.json()).user;
  const { server, port } = await startStaticServer(path.join(ROOT, 'app'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-'));
  const ch = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--window-size=1440,900', `--user-data-dir=${dir}`, `--remote-debugging-port=${P}`, 'about:blank'], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 60; i++) { await sleep(500); try { const l = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json(); t = l.find(x => x.type === 'page'); if (t) break; } catch (e) {} }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map(); const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(String(((m.exceptionDetails || {}).exception || {}).description || '').slice(0, 300));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const s = (m.params.args || []).map(a => a.value ?? a.description).join(' ');
      if (!/favicon|net::ERR|Failed to load resource/i.test(s)) errors.push(s.slice(0, 300));
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('t ' + method)); } }, 40000); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text).slice(0, 400)); return r.result && r.result.value; };
  await send('Page.enable'); await send('Runtime.enable');

  // 拦截考试记录写入，避免真实污染云端数据；其余请求照常
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => { const orig = window.fetch; window.__quizWrites = [];
      window.fetch = function(url, opts) {
        try { const b = opts && opts.body ? JSON.parse(opts.body) : null;
          if (b && b.action === 'add' && b.collection === 'training_records') {
            window.__quizWrites.push(b.data); return Promise.resolve(new Response(JSON.stringify({code:0}), {status:200,headers:{'Content-Type':'application/json'}}));
          }
          if (b && b.action === 'add' && b.collection === 'training_questions') {
            window.__quizWrites.push(b.data); return Promise.resolve(new Response(JSON.stringify({code:0}), {status:200,headers:{'Content-Type':'application/json'}}));
          }
        } catch(e) {}
        return orig.apply(this, arguments);
      }; })();`
  });

  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await sleep(3000);
  await ev(`(() => { const ins=[...document.querySelectorAll('.login-card input')]; const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(ins[0], ${JSON.stringify(u.username)}); ins[0].dispatchEvent(new Event('input',{bubbles:true})); s.call(ins[1],'123456'); ins[1].dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await sleep(400);
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/登\\s*录/.test(x.innerText||'')); b&&b.click(); return 1; })()`);
  for (let i = 0; i < 30; i++) { await sleep(700); if (await ev(`!!document.querySelector('.menu .menu-item')`)) break; }
  await sleep(1200);

  await ev(`(() => { location.hash='#/trainings'; return 1; })()`); await sleep(3000);
  const tabs = await ev(`[...document.querySelectorAll('.el-tabs__item')].map(x=>(x.innerText||'').trim())`);
  check('培训页含「题库练习」与「题库管理」Tab', tabs.includes('题库练习') && tabs.includes('题库管理'), tabs);
  console.log('       tabs:', JSON.stringify(tabs));

  // 切到题库练习
  await ev(`(() => { const t=[...document.querySelectorAll('.el-tabs__item')].find(x=>/题库练习/.test(x.innerText||'')); t&&t.click(); return 1; })()`);
  await sleep(800);
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/开始练习/.test(x.innerText||'')); b&&b.click(); return !!b; })()`);
  await sleep(1500);
  const quiz = await ev(`(() => {
    const cards = document.querySelectorAll('.quiz-card');
    const radios = document.querySelectorAll('.el-radio');
    return { cards: cards.length, radios: radios.length, head: (document.getElementById('app').innerText||'').replace(/\\s+/g,' ').slice(0,160) };
  })()`);
  check('抽题渲染 15 道题目与选项', quiz.cards === 15 && quiz.radios > 20, quiz);

  // 每题选第一个选项，提交判分
  await ev(`(() => {
    const cards=[...document.querySelectorAll('.quiz-card')];
    cards.forEach(c => {
      const r=c.querySelector('.el-radio input'); if(r) r.click();
      const k=c.querySelector('.el-checkbox input'); if(k) k.click();
    });
    return 1;
  })()`);
  await sleep(500);
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/提交判分/.test(x.innerText||'')); b&&b.click(); return 1; })()`);
  await sleep(2000);
  const graded = await ev(`(() => {
    const t=(document.getElementById('app').innerText||'').replace(/\\s+/g,' ');
    return { result:/得分\\s*\\d+\\s*分/.test(t), explains:document.querySelectorAll('.quiz-explain').length, writes:(window.__quizWrites||[]).length, snippet:t.slice(-260) };
  })()`);
  check('判分显示得分与逐题解析', graded.result && graded.explains === 15, graded);
  check('成绩写入培训档案（training_records）', graded.writes >= 1, graded);

  // 题库管理 Tab
  await ev(`(() => { const t=[...document.querySelectorAll('.el-tabs__item')].find(x=>/题库管理/.test(x.innerText||'')); t&&t.click(); return 1; })()`);
  await sleep(1200);
  const bank = await ev(`(() => {
    const txt=(document.getElementById('app').innerText||'').replace(/\\s+/g,' ');
    return {
      hasStats: /题目总数/.test(txt) && /待确认/.test(txt),
      rows: document.querySelectorAll('.el-table__body tbody tr').length,
      hasDetect: [...document.querySelectorAll('button')].some(b=>/检索待确认更新/.test(b.innerText||'')),
      hasCreate: [...document.querySelectorAll('button')].some(b=>/录入题目/.test(b.innerText||''))
    };
  })()`);
  check('题库管理渲染统计卡与题目列表', bank.hasStats && bank.rows > 0, bank);
  check('题库管理含检索更新 / 录入入口', bank.hasDetect && bank.hasCreate, bank);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'quiz_bank.png'), Buffer.from(shot.data, 'base64'));

  check('全程无未捕获异常', errors.length === 0, errors.slice(0, 4));
  fs.writeFileSync(path.join(OUT, 'quiz_report.json'), JSON.stringify({ results, errors }, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n结果：通过 ${results.length - failed} / 失败 ${failed}`);
  ws.close(); ch.kill(); server.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('失败:', e.stack); process.exit(1); });
