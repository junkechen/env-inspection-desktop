// 发布 v1.0.9 Release：创建 release → 上传 EXE + version.json
const fs = require('fs');
const path = require('path');
const TOKEN = process.env.GH_TOKEN;
const REPO = 'junkechen/env-inspection-desktop';
const TAG = 'v1.0.9';
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
  let release;
  try {
    release = await api('/repos/' + REPO + '/releases', {
      method: 'POST',
      body: JSON.stringify({
        tag_name: TAG,
        target_commitish: 'master',
        name: TAG,
        body: [
          '## v1.0.9 更新内容（启动修复）',
          '',
          '- 修复启动卡在「正在加载系统…」的问题（隐患页模块导入错误导致界面无法挂载）',
          '- 业务类别体系改造内容与 v1.0.8 相同（安全/节能/环保三业务、等级一般/较大/重大、业务联动类别）'
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

  const root = path.join(__dirname, '..', 'dist_release');
  const assets = [
    { file: path.join(root, 'GZInspection_v1.0.9.exe'), name: 'GZInspection_v1.0.9.exe', type: 'application/octet-stream' },
    { file: path.join(__dirname, '..', 'version.json'), name: 'version.json', type: 'application/json' }
  ];
  for (const a of assets) {
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
