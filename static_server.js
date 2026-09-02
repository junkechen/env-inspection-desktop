// 本地静态服务器（纯 Node http + fs），供 Electron 主进程托管 app/ 目录。
// 独立成模块以便单元测试覆盖路径穿越防护、MIME、404 等边界。

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

// 处理单个请求：返回 {status, contentType, body}（便于测试，不依赖 res 对象）
function handleRequest(rootDir, urlPath) {
  let p = decodeURIComponent((urlPath || '/').split('?')[0]);
  if (p === '/') p = '/index.html';

  const filePath = path.normalize(path.join(rootDir, p));
  // 防目录穿越：解析后的路径必须仍在 rootDir 内
  if (!filePath.startsWith(rootDir)) {
    return { status: 403, contentType: 'text/plain; charset=utf-8', body: 'Forbidden' };
  }

  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch (e) {
    return { status: 404, contentType: 'text/plain; charset=utf-8', body: 'Not Found' };
  }

  const ext = path.extname(filePath).toLowerCase();
  return {
    status: 200,
    contentType: MIME[ext] || 'application/octet-stream',
    body: data
  };
}

// 启动服务器，返回 { server, port }
function startStaticServer(rootDir) {
  const server = http.createServer((req, res) => {
    try {
      const result = handleRequest(rootDir, req.url);
      res.writeHead(result.status, { 'Content-Type': result.contentType, 'Cache-Control': 'no-cache' });
      res.end(result.body);
    } catch (e) {
      res.writeHead(500); res.end('Server Error');
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
    server.on('error', reject);
  });
}

module.exports = { startStaticServer, handleRequest, MIME };
