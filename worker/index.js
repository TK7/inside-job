// Inside Job on Cloudflare Workers.
//
// Static files in ./public are served by Workers Static Assets (see wrangler.jsonc) before this
// code runs. Only requests that match no file reach fetch() below:
//   /ws      WebSocket for the game, handed to the GameHub Durable Object
//   /health  quick status check
//
// All rooms live in one Durable Object instance, exactly like the single Node process did, so
// room codes stay unique and every player in a room talks to the same in-memory game.

import { DurableObject } from 'cloudflare:workers';
import hubModule from '../src/hub.js';

const { Hub } = hubModule;
const HUB_NAME = 'global';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws' || url.pathname === '/health') {
      const stub = env.HUB.get(env.HUB.idFromName(HUB_NAME));
      return stub.fetch(request);
    }
    if (url.pathname === '/rules') return env.ASSETS.fetch(new URL('/rules.html', url));
    return env.ASSETS.fetch(request);
  },
};

export class GameHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.hub = new Hub();
    this.conns = new Set();
    this.sweeper = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(`ok ${this.hub.rooms.size} rooms`, { headers: { 'Content-Type': 'text/plain' } });
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    // Plain accept() (not the hibernation API) keeps the game timers and rooms in memory
    // for as long as players are connected.
    server.accept();
    const conn = this.hub.open(
      (text) => server.send(text),
      () => server.close(1000, 'timeout'),
    );
    this.conns.add(conn);
    const done = () => {
      if (!this.conns.delete(conn)) return;
      this.hub.closed(conn);
    };
    server.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') this.hub.message(conn, ev.data);
    });
    server.addEventListener('close', done);
    server.addEventListener('error', done);

    if (!this.sweeper) {
      this.sweeper = setInterval(() => {
        this.hub.sweep(this.conns);
        for (const c of this.conns) if (c.dead) this.conns.delete(c);
      }, 10 * 1000);
    }

    return new Response(null, { status: 101, webSocket: client });
  }
}
