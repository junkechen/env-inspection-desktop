// 发布 v1.0.33 Release：创建 release → 上传 EXE + version.json
// 用法：GH_TOKEN=ghp_xxx node build/_release_1033.cjs
const fs = require('fs');
const path = require('path');
const TOKEN = process.env.GH_TOKEN;
const REPO = 'junkechen/env-inspection-desktop';
const TAG = 'v1.0.33';
const API = 'https://api.github.com';

if (!TOKEN) { console.error('缺少 GH_TOKEN 环境变量'); process.exit(1); }

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

const NOTES = `对齐手机端 APK v3.7.16+，补齐电脑端缺失的日常管理功能：

①隐患模块增强——支持编辑、撤回（软删除）与重新指派整改人（对齐 APK 撤回/编辑/改派口径）。
②新增「合理化建议」模块——全员提报、点赞、专家加权评分（可行性×0.4+效益×0.4+创新×0.2）、安环部决议定级（一/二/三等奖/优秀奖），支持 Excel 导出。
③新增「AI 隐患识别」——上传/粘贴现场照片，AI 智能研判隐患（类别/等级/风险点/整改建议），一键转为正式隐患上报。
④新增「模块考核落实单」——管理模块不符合项报告单与纠正措施流转：下发→受审核人签字确认→填写纠正措施→审核闭环，支持纸质模板 PDF 导出。
⑤仪表盘新增「统计周期」自定义时间范围（本周/本月/本季度/本年/自定义起止日期），卡片与图表随所选窗口缩放。
⑥界面修复——Element Plus 2.7 下拉框（筛选/表单选择器）恢复深色主题，修复白底下拉与弹层看不清的问题。`;

(async () => {
  let release;
  try {
    release = await api('/repos/' + REPO + '/releases', {
      method: 'POST',
      body: JSON.stringify({
        tag_name: TAG,
        target_commitish: 'master',
        name: TAG,
        body: NOTES
      })
    });
    console.log('release created:', release.id);
  } catch (e) {
    if (/already_exists/.test(e.message)) {
      release = await api('/repos/' + REPO + '/releases/tags/' + TAG);
      console.log('release exists:', release.id);
    } else { throw e; }
  }

  const root = path.join(__dirname, '..', 'dist_release');
  const assets = [
    { file: path.join(root, 'GZInspection_v1.0.33.exe'), name: 'GZInspection_v1.0.33.exe', type: 'application/octet-stream' },
    { file: path.join(__dirname, '..', 'version.json'), name: 'version.json', type: 'application/json' }
  ];
  for (const a of assets) {
    if (!fs.existsSync(a.file)) { console.error('缺少文件:', a.file); process.exit(1); }
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
