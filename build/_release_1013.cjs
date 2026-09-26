// 发布 v1.0.13 Release：创建 release → 上传 EXE + version.json
const fs = require('fs');
const path = require('path');
const TOKEN = process.env.GH_TOKEN;
const REPO = 'junkechen/env-inspection-desktop';
const TAG = 'v1.0.13';
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
          '## v1.0.13 更新内容',
          '',
          '- 仪表盘「车间问题数量排名」支持点击行查看该车间/部门的问题清单与问题描述（原点击无反应）',
          '- 单业务账号默认显示本业务隐患、隐藏业务选择框；仅归属多个业务的账号才显示业务切换',
          '- 公告栏默认折叠，点击标题展开查看，不再常驻全部公告'
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
    { file: path.join(root, 'GZInspection_v1.0.13.exe'), name: 'GZInspection_v1.0.13.exe', type: 'application/octet-stream' },
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
