'use strict';
// End-to-end simulation: starts the real server, connects bot players over Socket.IO,
// plays complete games in both modes and checks that secret info never leaks.
//
//   npm test

process.env.PORT = process.env.PORT || '3999';
process.env.IJ_TIME_SCALE = process.env.IJ_TIME_SCALE || '0.03';

const { io } = require('socket.io-client');
const { server } = require('../server');

const URL = `http://localhost:${process.env.PORT}`;
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
const pickOne = (a) => a[Math.floor(Math.random() * a.length)];

function bot(name, { idle = false } = {}) {
  const sock = io(URL, { transports: ['websocket'], forceNew: true });
  const b = { name, sock, state: null, acted: new Set(), phases: [], over: null, token: `tok-${name}-${Math.random()}` };
  const emit = (ev, data) => new Promise((res) => sock.emit(ev, data, res));
  b.emit = emit;
  sock.on('state', (s) => {
    b.state = s;
    if (b.phases[b.phases.length - 1] !== s.phase) b.phases.push(s.phase);
    audit(b, s);
    if (s.phase === 'gameover' && !b.over) b.over = s;
    if (!idle) play(b, s);
  });
  return b;
}

// Secrets each player must never see.
function audit(b, s) {
  const g = s.game;
  if (!g || !g.cur) return;
  const c = g.cur;
  const role = s.me.role;
  if (c.kind === 'trivia' && s.phase !== 'trivia-reveal') {
    check(c.answer === undefined, `${b.name} saw the trivia answer during ${s.phase}`);
    check(c.byPlayer === undefined, `${b.name} saw others' answers during ${s.phase}`);
    if (role !== 'mole') check(c.tip === undefined, `${b.name} (not mole) got a tip`);
  }
  if (c.kind === 'bluff' && s.phase !== 'bluff-reveal') {
    check(c.truth === undefined && c.reveal === undefined, `${b.name} saw bluff truth during ${s.phase}`);
    if (role !== 'mole') check(c.tip === undefined, `${b.name} (not mole) got a bluff tip`);
    if (c.ballot) check(c.ballot.every((o) => !('kind' in o) && !('authors' in o)), `${b.name} ballot leaks kinds/authors`);
  }
  if (c.kind === 'poker' && s.phase !== 'poker-reveal' && c.bluffer !== s.me.id) {
    check(c.truth === undefined, `${b.name} saw poker truth while not the bluffer`);
  }
  if (s.phase !== 'gameover') {
    check(g.moleId === undefined && g.agents === undefined && g.scores === undefined, `${b.name} saw hidden roles/scores mid-game`);
  }
  if (g.mode === 'rivals') {
    check(s.chat.every((m) => m.to === 'all' || m.to === s.me.team), `${b.name} saw the other team's chat`);
  }
}

function play(b, s) {
  const g = s.game;
  if (!g) return;
  const c = g.cur;
  const key = `${s.phase}:${g.round}:${g.step}`;
  if (b.acted.has(key)) return;
  const act = (a) => { b.acted.add(key); setTimeout(() => b.emit('act', a), 5 + Math.random() * 20); };
  const me = s.me.id;
  const others = s.players.filter((p) => p.id !== me);
  switch (s.phase) {
    case 'briefing': return act({ type: 'ready' });
    case 'trivia-answer': return act({ type: 'answer', choice: Math.floor(Math.random() * 4) });
    case 'trivia-discuss': if (c.safecracker === me) act({ type: 'pick', choice: Math.floor(Math.random() * 4) }); return;
    case 'bluff-write': return act({ type: 'fake', text: `${b.name} fake ${g.round}` });
    case 'bluff-vote': {
      const opts = c.ballot.filter((o) => !o.mine);
      return act({ type: 'vote', option: pickOne(opts).id });
    }
    case 'poker-pitch':
      if (c.bluffer === me) {
        b.acted.add(key);
        b.emit('chat', { text: 'Trust me, it is totally true.', channel: 'all' });
        setTimeout(() => b.emit('act', { type: 'pitchDone' }), 20);
      }
      return;
    case 'poker-vote': if (s.me.team !== c.bluffTeam) act({ type: 'call', value: pickOne(['believe', 'busted']) }); return;
    case 'interrogate': return act({ type: 'suspect', target: pickOne([...others.map((p) => p.id), 'pass']) });
    case 'accuse': return act({ type: 'suspect', target: pickOne(others).id });
    case 'agent-guess': {
      const mates = others.filter((p) => p.team === s.me.team);
      return act({ type: 'suspect', target: pickOne(mates).id });
    }
    default:
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, label) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for: ${label}`);
    await wait(20);
  }
}

async function game(mode, n, opts = {}) {
  const bots = Array.from({ length: n }, (_, i) => bot(`${mode}${i + 1}`, { idle: opts.idle && i === n - 1 }));
  await until(() => bots.every((b) => b.sock.connected), 3000, 'connect');
  const host = bots[0];
  const created = await host.emit('join', { name: host.name, token: host.token, create: true });
  check(created.ok, `create failed: ${JSON.stringify(created)}`);
  for (const b of bots.slice(1)) {
    const r = await b.emit('join', { name: b.name, token: b.token, code: created.code });
    check(r.ok, `join failed: ${JSON.stringify(r)}`);
  }
  await host.emit('settings', { mode, pack: opts.pack || 'standard', doubleAgents: true });
  if (mode === 'rivals') await host.emit('shuffle');
  await until(() => host.state && host.state.players.length === n && !host.state.startError, 3000, 'lobby ready');
  const started = await host.emit('start');
  check(!started.error, `start failed: ${started.error}`);

  if (opts.dropMidGame) {
    await until(() => host.state.phase === 'trivia-answer', 5000, 'first trivia');
    const victim = bots[1];
    victim.sock.disconnect();
    await wait(50);
    victim.sock.connect();
    await until(() => victim.sock.connected, 3000, 'reconnect');
    const r = await victim.emit('join', { name: victim.name, token: victim.token, code: created.code });
    check(r.ok, `rejoin mid-game failed: ${JSON.stringify(r)}`);
  }

  await until(() => bots.every((b) => b.over), 60000, `${mode} game over`);
  const over = host.over.game;
  const summary = mode === 'crew'
    ? `winner=${over.winner} locks=${over.locks} alarms=${over.alarms} mole=${over.moleId ? 'yes' : 'no'} exposed=${!!over.exposedId}`
    : `winner=${over.winner} score=${over.teamScore.A}-${over.teamScore.B} agents=${over.agents ? 'yes' : 'no'}`;
  console.log(`  ${mode} x${n}${opts.pack ? ` [${opts.pack}]` : ''}${opts.idle ? ' [1 idle]' : ''}${opts.dropMidGame ? ' [reconnect]' : ''}: ${summary}`);
  console.log(`    phases: ${host.phases.join(' > ')}`);
  check(bots.every((b) => b.over.game.winner === over.winner), 'players disagree on the winner');
  if (mode === 'crew') check(over.locks >= 3 || over.alarms >= over.maxAlarms || over.winner === 'mole', 'crew game ended without a decision');

  // Play-again returns everyone to the lobby.
  await host.emit('again');
  await until(() => bots.every((b) => b.state.phase === 'lobby'), 3000, 'back to lobby');
  bots.forEach((b) => b.sock.close());
}

(async () => {
  try {
    console.log('Simulating games…');
    await game('crew', 2);
    await game('crew', 3, { pack: 'adult' });
    for (let i = 0; i < 4; i++) await game('crew', 5);
    await game('crew', 8, { pack: 'mixed' });
    await game('crew', 4, { idle: true });
    await game('crew', 5, { dropMidGame: true });
    await game('rivals', 4);
    await game('rivals', 5);
    for (let i = 0; i < 2; i++) await game('rivals', 6);
    await game('rivals', 8, { pack: 'adult', idle: true });

    // Lobby rules.
    const a = bot('solo');
    await until(() => a.sock.connected, 3000, 'connect');
    const r = await a.emit('join', { name: 'Solo', token: a.token, create: true });
    const s1 = await a.emit('start');
    check(s1.error && /at least 2/.test(s1.error), 'solo start should be refused');
    const bad = await a.emit('join', { name: 'X', token: 'tok-zzz-1234', code: 'QQQQ' });
    check(bad.error, 'joining a missing room should fail');
    await a.emit('settings', { mode: 'rivals' });
    const s2 = await a.emit('start');
    check(s2.error && /4 players/.test(s2.error), 'rivals with 1 player should be refused');
    a.sock.close();
    void r;
  } catch (e) {
    failures.push(e.message);
  }
  if (failures.length) {
    console.log(`\nFAILED (${failures.length}):`);
    [...new Set(failures)].slice(0, 30).forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
  } else {
    console.log('\nAll simulations passed.');
  }
  server.close();
  setTimeout(() => process.exit(), 200);
})();
