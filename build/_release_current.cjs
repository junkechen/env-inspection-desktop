// 通用发布脚本：从 version.json / package.json 读取版本、EXE 名与更新说明，
// 创建（或复用）对应 tag 的 GitHub Release 并上传 EXE + version.json。
//
// 用法：GH_TOKEN=<PAT> node build/_release_current.cjs
// 说明：以后升级只需改 package.json + version.json，不必再复制一版 _release_xxxx.cjs。
// 安全：PAT 只从环境变量读取，绝不写入任何文件、日志或命令行参数。
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.GH_TOKEN;
const ROOT = path.resolve(__dirname, '..');
const REPO = 'junkechen/env-inspection-desktop';
const API = 'https://api.github.com';
const UPLOAD = 'https://uploads.github.com';

if (!TOKEN) { console.error('缺少 GH_TOKEN 环境变量（仅从 env 读取，不落盘）'); process.exit(1); }

const ver = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (ver.version !== pkg.version) {
  console.error('版本号不一致：version.json=' + ver.version + ' / package.json=' + pkg.version);
  process.exit(1);
}
const TAG = 'v' + ver.version;
const EXE = path.join(ROOT, 'dist_release', ver.exeName);
const NOTES = ver.notes || (TAG + ' 更新');
if (!fs.existsSync(EXE)) { console.error('缺少打包产物：' + EXE); process.exit(1); }

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
  try { json = text ? JSON.parse(text) : {}; } catch (e) { /* 非 JSON */ }
  if (!res.ok) throw new Error(res.status + ' ' + text.slice(0, 300));
  return json;
}

async function upload(release, file, name, type) {
  const existing = (release.assets || []).find((x) => x.name === name);
  if (existing) {
    await api('/repos/' + REPO + '/releases/assets/' + existing.id, { method: 'DELETE' });
    console.log('deleted old asset:', name);
  }
  const up = await fetch(UPLOAD + '/repos/' + REPO + '/releases/' + release.id + '/assets?name=' + encodeURIComponent(name), {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + TOKEN,
      'Content-Type': type,
      'Content-Length': fs.statSync(file).size,
      'User-Agent': 'release-script'
    },
    body: fs.createReadStream(file),
    duplex: 'half'
  });
  const t = await up.text();
  if (!up.ok) throw new Error('upload ' + name + ' failed: ' + up.status + ' ' + t.slice(0, 300));
  console.log('uploaded:', name, JSON.parse(t).state);
}

(async () => {
  let release;
  try {
    release = await api('/repos/' + REPO + '/releases', {
      method: 'POST',
      body: JSON.stringify({
        tag_name: TAG, target_commitish: 'master', name: TAG,
        body: NOTES, make_latest: 'true'
      })
    });
    console.log('release created:', release.id, TAG);
  } catch (e) {
    if (/already_exists/.test(e.message)) {
      release = await api('/repos/' + REPO + '/releases/tags/' + TAG);
      console.log('release exists:', release.id, TAG);
    } else { throw e; }
  }
  await upload(release, EXE, ver.exeName, 'application/octet-stream');
  await upload(release, path.join(ROOT, 'version.json'), 'version.json', 'application/json');
  console.log('DONE', TAG, ver.exeName);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
