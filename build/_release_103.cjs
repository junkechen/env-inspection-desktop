// 发布 v1.0.3 Release：创建 release → 上传 EXE + version.json
const fs = require('fs');
const path = require('path');
const TOKEN = process.env.GH_TOKEN;
const REPO = 'junkechen/env-inspection-desktop';
const TAG = 'v1.0.3';
const API = 'https://api.github.com';

async function api(url, opts = {}) {
  const res = await fetch(API + url, Object.assign({
    headers: {
      'Authorization': 'Bearer ' + TOKEN,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'release-script',
      'Content-Type': 'application/json'
    }
  }, opts));
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (e) {}
  if (!res.ok) throw new Error(res.status + ' ' + text.slice(0, 300));
  return json;
}

(async () => {
  // 1. 创建 release（若 tag 已存在则报错，此时改为查询现有 release）
  let release;
  try {
    release = await api('/repos/' + REPO + '/releases', {
      method: 'POST',
      body: JSON.stringify({
        tag_name: TAG,
        target_commitish: 'master',
        name: TAG,
        body: [
          '## v1.0.3 更新内容',
          '',
          '- 用户管理：新增「待审核」筛选与「通过」审核操作（APP 注册账号初始为待审核状态）',
          '- 用户管理：修复操作列「禁用/删除」按钮被遮挡不可见的问题',
          '- 用户管理：修复状态筛选下拉不生效的问题',
          '- 登录：新增「记住密码并自动登录」，勾选后下次启动免输入'
        ].join('\n')
      })
    });
    console.log('release created:', release.id);
  } catch (e) {
    if (/already_exists/.test(e.message)) {
      const list = await api('/repos/' + REPO + '/releases/tags/' + TAG);
      release = list;
      console.log('release exists:', release.id);
    } else { throw e; }
  }

  // 2. 上传资产
  const root = path.join(__dirname, '..', 'dist_release');
  const assets = [
    { file: path.join(root, 'GZInspection_v1.0.3.exe'), name: 'GZInspection_v1.0.3.exe', type: 'application/octet-stream' },
    { file: path.join(__dirname, '..', 'version.json'), name: 'version.json', type: 'application/json' }
  ];
  for (const a of assets) {
    // 同名资产先删后传
    const existing = (release.assets || []).find(x => x.name === a.name);
    if (existing) {
      await api('/repos/' + REPO + '/releases/assets/' + existing.id, { method: 'DELETE' });
      console.log('deleted old asset:', a.name);
    }
    const up = await fetch('https://uploads.github.com/repos/' + REPO + '/releases/' + release.id + '/assets?name=' + encodeURIComponent(a.name), {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Content-Type': a.type,
        'Content-Length': fs.statSync(a.file).size,
        'User-Agent': 'release-script'
      },
      body: fs.createReadStream(a.file),
      duplex: 'half'
    });
    const t = await up.text();
    if (!up.ok) throw new Error('upload ' + a.name + ' failed: ' + up.status + ' ' + t.slice(0, 300));
    console.log('uploaded:', a.name, JSON.parse(t).state);
  }
  console.log('DONE');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
