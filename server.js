'use strict';
// Inside Job local/Node server: serves the web client and runs game rooms over WebSockets.
// Production runs on Cloudflare Workers instead (see worker/index.js and wrangler.jsonc);
// both share the same game hub (src/hub.js) and wire protocol.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const { Hub } = require('./src/hub');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};
const ROUTES = { '/': '/index.html', '/rules': '/rules.html' };

const hub = new Hub();
const rooms = hub.rooms;

const server = http.createServer((req, res) => {
  let url;
  try {
    url = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(`ok ${rooms.size} rooms`);
  }
  const file = path.normalize(path.join(PUBLIC, ROUTES[url] || url));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  sendFile(req, res, file);
});

// Gzip text responses: public tunnels such as localhost.run stall on large uncompressed
// bodies, and phones on mobile data load faster too.
function sendFile(req, res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
    if (/^(text|application\/json|image\/svg)/.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      data = zlib.gzipSync(data);
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = data.length;
    res.writeHead(200, headers);
    res.end(data);
  });
}

const conns = new Set();
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1e4 });
wss.on('connection', (ws) => {
  const conn = hub.open(
    (text) => ws.readyState === ws.OPEN && ws.send(text),
    () => ws.terminate(),
  );
  conns.add(conn);
  ws.on('message', (data) => hub.message(conn, String(data)));
  ws.on('close', () => {
    conns.delete(conn);
    hub.closed(conn);
  });
  ws.on('error', () => {});
});

setInterval(() => hub.sweep(conns), 10 * 1000).unref();

server.listen(PORT, () => console.log(`Inside Job running on http://localhost:${PORT}`));

module.exports = { server, rooms, hub };
