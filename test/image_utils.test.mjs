import assert from 'node:assert';

// api.js 依赖浏览器全局对象，先提供最小 mock，再动态导入模块
global.window = { __API_BASE__: 'https://mock-gw.example.com/api', localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } };
global.location = { hash: '' };

const { api } = await import('../app/js/api.js');
const { resolveImageUrl, resolveIssuePhotos, resolveIssuesPhotos } = await import('../app/js/image_utils.js');

// 模拟 api.getFileUrl：把 cloud:// 前缀替换为 https://fake/，其他返回原值
const calls = [];
api.getFileUrl = async (filePath, maxAge) => {
  calls.push({ filePath, maxAge });
  return filePath.replace('cloud://', 'https://fake.cdn/');
};

console.log('image_utils 测试：');

// 1. http 链接原样返回
assert.strictEqual(await resolveImageUrl('https://example.com/a.jpg'), 'https://example.com/a.jpg');
console.log('  ✓ http(s) 链接原样返回');

// 2. cloud:// 被刷新为临时 URL
assert.strictEqual(await resolveImageUrl('cloud://env.bucket/hazards/1.jpg'), 'https://fake.cdn/env.bucket/hazards/1.jpg');
console.log('  ✓ cloud:// fileID 被刷新为临时 URL');

// 3. 缓存生效：同一 fileID 只请求一次
await resolveImageUrl('cloud://env.bucket/hazards/1.jpg');
assert.strictEqual(calls.filter(c => c.filePath === 'cloud://env.bucket/hazards/1.jpg').length, 1);
console.log('  ✓ 同一 fileID 仅请求一次云函数');

// 4. resolveIssuePhotos 刷新对象内所有照片
const issue = {
  photos: ['cloud://a/1.jpg', 'https://b/2.jpg'],
  rectificationPhotos: ['cloud://a/3.jpg'],
  rectificationHistory: [
    { photos: ['cloud://a/4.jpg'] },
    { photos: ['https://b/5.jpg'] }
  ]
};
await resolveIssuePhotos(issue);
assert.deepStrictEqual(issue.photos, ['https://fake.cdn/a/1.jpg', 'https://b/2.jpg']);
assert.deepStrictEqual(issue.rectificationPhotos, ['https://fake.cdn/a/3.jpg']);
assert.deepStrictEqual(issue.rectificationHistory[0].photos, ['https://fake.cdn/a/4.jpg']);
assert.deepStrictEqual(issue.rectificationHistory[1].photos, ['https://b/5.jpg']);
console.log('  ✓ resolveIssuePhotos 递归刷新所有照片字段');

// 5. resolveIssuesPhotos 批量处理多个 issue
const list = [
  { photos: ['cloud://a/x.jpg'] },
  { rectificationPhotos: ['cloud://a/y.jpg'] }
];
await resolveIssuesPhotos(list);
assert.deepStrictEqual(list[0].photos, ['https://fake.cdn/a/x.jpg']);
assert.deepStrictEqual(list[1].rectificationPhotos, ['https://fake.cdn/a/y.jpg']);
console.log('  ✓ resolveIssuesPhotos 批量处理 issue 列表');

console.log('\n结果：5 通过 / 0 失败');
