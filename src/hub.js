'use strict';
// Transport-agnostic game hub: room codes, joins, per-player state pushes and message routing.
// The Node server (server.js) and the Cloudflare Durable Object (worker/index.js) both wrap it
// around their own WebSocket implementation.
//
// Wire protocol (JSON text frames):
//   client -> server: { e: event, d: data, id?: number }   (id asks for an ack)
//   server -> client: { ack: id, d: result }              (reply to a request)
//                     { e: 'state', d: view }             (pushed game state)
//                     { e: 'pong' }                       (reply to { e: 'ping' })

const { Room } = require('./room');

const IDLE_ROOM_MS = 30 * 60 * 1000;
const STALE_CONN_MS = 35 * 1000; // clients ping every 10s; this mirrors Socket.IO's old ping timeout
const MAX_MESSAGE = 1e4;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomInt(n) {
  const c = globalThis.crypto;
  if (c && c.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0] % n;
  return Math.floor(Math.random() * n);
}

class Hub {
  constructor() {
    this.rooms = new Map();
    this.members = new Map(); // room code -> Set of connections
  }

  newCode() {
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join('');
    } while (this.rooms.has(code));
    return code;
  }

  // send(text) delivers one frame; close() drops the underlying socket.
  open(send, close) {
    return { data: {}, send, close, seen: Date.now() };
  }

  emit(conn, msg) {
    try {
      conn.send(JSON.stringify(msg));
    } catch {
      /* socket already closed */
    }
  }

  // Batch state pushes: one personalised view per connection, at most once per tick.
  notify(room) {
    if (room.pending) return;
    room.pending = true;
    queueMicrotask(() => {
      room.pending = false;
      for (const conn of this.members.get(room.code) || []) {
        if (conn.data.pid) this.emit(conn, { e: 'state', d: room.view(conn.data.pid) });
      }
    });
  }

  othersFor(room, pid, except) {
    return [...(this.members.get(room.code) || [])].filter((c) => c !== except && c.data.pid === pid);
  }

  attach(conn, code) {
    if (!this.members.has(code)) this.members.set(code, new Set());
    this.members.get(code).add(conn);
  }

  unattach(conn) {
    const set = this.members.get(conn.data.code);
    if (!set) return;
    set.delete(conn);
    if (!set.size) this.members.delete(conn.data.code);
  }

  detach(conn) {
    const room = this.rooms.get(conn.data.code);
    if (room && conn.data.pid && !this.othersFor(room, conn.data.pid, conn).length) room.disconnect(conn.data.pid);
    this.unattach(conn);
    conn.data = {};
  }

  closed(conn) {
    if (conn.dead) return;
    conn.dead = true;
    this.detach(conn);
  }

  message(conn, raw) {
    if (conn.dead) return;
    conn.seen = Date.now();
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.e !== 'string') return;
    if (msg.e === 'ping') return this.emit(conn, { e: 'pong' });
    const result = this.handle(conn, msg.e, msg.d);
    if (msg.id != null && result !== undefined) this.emit(conn, { ack: msg.id, d: result });
  }

  handle(conn, event, data) {
    if (event === 'join') return this.join(conn, data || {});
    const fn = HANDLERS[event];
    if (!fn) return undefined;
    const room = this.rooms.get(conn.data.code);
    if (!room || !conn.data.pid || !room.player(conn.data.pid)) return { error: 'You are not in a room.' };
    try {
      return fn.call(this, room, conn.data.pid, data && typeof data === 'object' ? data : {}, conn) || {};
    } catch (e) {
      console.error(`[${room.code}] ${event} failed:`, e);
      return { error: 'Something went wrong. Try again.' };
    }
  }

  join(conn, msg) {
    const token = msg.token;
    if (typeof token !== 'string' || token.length < 8 || token.length > 64) return { error: 'Your session is invalid. Refresh the page.' };
    let code = String(msg.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    let room;
    if (msg.create) {
      code = this.newCode();
      room = new Room(code, (r) => this.notify(r));
      this.rooms.set(code, room);
    } else {
      room = this.rooms.get(code);
      if (!room) return { error: code ? `There's no room with code ${code}. Check it and try again.` : 'Enter a room code.' };
    }
    const res = room.join(msg.name, token);
    if (res.error) {
      if (msg.create) this.rooms.delete(code);
      return res;
    }
    if (conn.data.code && (conn.data.code !== code || conn.data.pid !== res.player.id)) this.detach(conn);
    conn.data = { code, pid: res.player.id };
    this.attach(conn, code);
    room.changed();
    return { ok: true, code, playerId: res.player.id, name: res.player.name };
  }

  // Forget rooms nobody has touched for a while and drop connections that stopped pinging.
  sweep(conns) {
    const now = Date.now();
    for (const conn of conns || []) {
      if (now - conn.seen > STALE_CONN_MS) {
        try {
          conn.close();
        } catch {
          /* already gone */
        }
        this.closed(conn);
      }
    }
    for (const [code, room] of this.rooms) {
      if (room.isEmpty() && now - room.touched > IDLE_ROOM_MS) {
        clearTimeout(room.timer);
        this.rooms.delete(code);
      }
    }
  }
}

const HANDLERS = {
  settings: (r, pid, m) => r.updateSettings(pid, m),
  team: (r, pid, m) => r.setTeam(pid, m.team),
  shuffle: (r, pid) => r.shuffleTeams(pid),
  kick: (r, pid, m) => r.kick(pid, m.id),
  start: (r, pid) => r.start(pid),
  act: (r, pid, m) => r.act(pid, m),
  chat: (r, pid, m) => r.say(pid, m.text, m.channel),
  again: (r, pid, m) => r.playAgain(pid, !!m.restart),
  leave(r, pid, m, conn) {
    this.unattach(conn);
    conn.data = {};
    r.leave(pid);
    return {};
  },
};

module.exports = { Hub };
