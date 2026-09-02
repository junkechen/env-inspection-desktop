// 极简 hash 路由：响应式 route.path + navigate() + 历史栈 back()
const { reactive } = Vue;

export const route = reactive({ path: location.hash.slice(1) || '/' });

// 维护应用内历史栈（用于顶部返回按钮）
const historyStack = [route.path];
const MAX_HISTORY = 50;

function pushHistory(path) {
  if (!path) path = '/';
  // 避免连续重复入栈
  if (historyStack[historyStack.length - 1] !== path) {
    historyStack.push(path);
    if (historyStack.length > MAX_HISTORY) historyStack.shift();
  }
}

window.addEventListener('hashchange', () => {
  const p = location.hash.slice(1) || '/';
  route.path = p;
  pushHistory(p);
});

export function navigate(path) {
  if (location.hash.slice(1) !== path) {
    location.hash = path;
  } else {
    route.path = path;
  }
}

export function back() {
  // 弹出当前页
  historyStack.pop();
  const prev = historyStack[historyStack.length - 1];
  if (prev && prev !== route.path) {
    location.hash = prev;
  } else {
    // 没有历史或已在首页，回到仪表盘
    navigate('/');
  }
}

// 把 /users、/users/123 等归一为一级 key 用于菜单匹配
export function topPath(path) {
  const seg = (path || '/').split('/').filter(Boolean);
  return '/' + (seg[0] || '');
}
