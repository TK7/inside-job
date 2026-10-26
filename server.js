'use strict';
// Inside Job server: serves the web client and runs game rooms over Socket.IO.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { Server } = require('socket.io');
const { Room } = require('./src/room');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const SOCKET_CLIENT = path.join(path.dirname(require.resolve('socket.io/package.json')), 'client-dist', 'socket.io.min.js');
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
const IDLE_ROOM_MS = 30 * 60 * 1000;

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
  if (url === '/vendor/socket.io.min.js') return sendFile(req, res, SOCKET_CLIENT);
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

const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000, maxHttpBufferSize: 1e4 });
const rooms = new Map();

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// Batch state pushes: one personalised view per socket, at most once per tick.
function notify(room) {
  if (room.pending) return;
  room.pending = true;
  setImmediate(() => {
    room.pending = false;
    const sids = io.sockets.adapter.rooms.get(room.code);
    if (!sids) return;
    for (const sid of sids) {
      const sock = io.sockets.sockets.get(sid);
      if (sock && sock.data.pid) sock.emit('state', room.view(sock.data.pid));
    }
  });
}

function socketsFor(room, pid, exceptId) {
  const sids = io.sockets.adapter.rooms.get(room.code) || new Set();
  return [...sids].filter((sid) => sid !== exceptId && io.sockets.sockets.get(sid)?.data.pid === pid);
}

io.on('connection', (socket) => {
  socket.data = {};

  function detach() {
    const room = rooms.get(socket.data.code);
    if (room && socket.data.pid && !socketsFor(room, socket.data.pid, socket.id).length) room.disconnect(socket.data.pid);
    if (socket.data.code) socket.leave(socket.data.code);
    socket.data = {};
  }

  socket.on('join', (msg, ack) => {
    if (typeof ack !== 'function') return;
    msg = msg || {};
    const token = msg.token;
    if (typeof token !== 'string' || token.length < 8 || token.length > 64) return ack({ error: 'Your session is invalid. Refresh the page.' });
    let code = String(msg.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    let room;
    if (msg.create) {
      code = newCode();
      room = new Room(code, notify);
      rooms.set(code, room);
    } else {
      room = rooms.get(code);
      if (!room) return ack({ error: code ? `There's no room with code ${code}. Check it and try again.` : 'Enter a room code.' });
    }
    const res = room.join(msg.name, token);
    if (res.error) {
      if (msg.create) rooms.delete(code);
      return ack(res);
    }
    if (socket.data.code && (socket.data.code !== code || socket.data.pid !== res.player.id)) detach();
    socket.data = { code, pid: res.player.id };
    socket.join(code);
    ack({ ok: true, code, playerId: res.player.id, name: res.player.name });
    room.changed();
  });

  const on = (event, fn) =>
    socket.on(event, (msg, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const room = rooms.get(socket.data.code);
      if (!room || !socket.data.pid || !room.player(socket.data.pid)) return reply({ error: 'You are not in a room.' });
      try {
        reply(fn(room, socket.data.pid, msg && typeof msg === 'object' ? msg : {}) || {});
      } catch (e) {
        console.error(`[${room.code}] ${event} failed:`, e);
        reply({ error: 'Something went wrong. Try again.' });
      }
    });

  on('settings', (r, pid, m) => r.updateSettings(pid, m));
  on('team', (r, pid, m) => r.setTeam(pid, m.team));
  on('shuffle', (r, pid) => r.shuffleTeams(pid));
  on('kick', (r, pid, m) => r.kick(pid, m.id));
  on('start', (r, pid) => r.start(pid));
  on('act', (r, pid, m) => r.act(pid, m));
  on('chat', (r, pid, m) => r.say(pid, m.text, m.channel));
  on('again', (r, pid, m) => r.playAgain(pid, !!m.restart));
  on('leave', (r, pid) => {
    socket.leave(r.code);
    socket.data = {};
    r.leave(pid);
    return {};
  });

  socket.on('disconnect', detach);
});

// Forget rooms nobody has touched for a while.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.isEmpty() && now - room.touched > IDLE_ROOM_MS) {
      clearTimeout(room.timer);
      rooms.delete(code);
    }
  }
}, 60 * 1000).unref();

server.listen(PORT, () => console.log(`Inside Job running on http://localhost:${PORT}`));

module.exports = { server, rooms };
