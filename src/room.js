'use strict';
// One game room: lobby, players, chat and the full rules engine for both modes.
// The server is the single source of truth; view(playerId) builds what one player may see.

const content = require('./content');

const SECONDS = {
  briefing: 15,
  triviaAnswer: 20,
  triviaDiscuss: 30,
  bluffWrite: 45,
  bluffVote: 30,
  reveal: 12,
  interrogate: 60,
  accuse: 60,
  pokerPitch: 45,
  pokerVote: 20,
  agentGuess: 45,
};
const MAX_PLAYERS = 8;
const LOCKS_TO_WIN = 3;
const TOTAL_LOCKS = 5;
const TEAM_NAMES = { A: 'Crimson Crew', B: 'Cobalt Crew' };
// Personal money ($). Every miss (a wrong answer, or none before the timer) costs half the reward.
const MONEY = {
  trivia: 100, triviaMiss: 50, fastest: 50,
  truth: 100, truthMiss: 50, fooled: 50,
  pokerCall: 50, pokerMiss: 25, bluffer: 200,
  moleVote: 200, moleMiss: 100, alarmToMole: 150,
  heistBonus: 250,
};
const LOBBY_DROP_MS = 20000;
// Test hook: IJ_TIME_SCALE=0.05 runs every timer 20x faster.
const TIME_SCALE = Number(process.env.IJ_TIME_SCALE) || 1;

const rand = (n) => Math.floor(Math.random() * n);
const shuffle = (list) => {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]/g, '');
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const newId = () => Math.random().toString(36).slice(2, 10);
const other = (team) => (team === 'A' ? 'B' : 'A');

// Most common value; ties broken randomly. Returns null for an empty list.
function plurality(values) {
  const counts = tally(values);
  const max = Math.max(0, ...Object.values(counts));
  const top = Object.keys(counts).filter((k) => counts[k] === max);
  return top.length ? top[rand(top.length)] : null;
}
// Most common value only if it is strictly ahead; ties return null.
function strictTop(values) {
  const counts = tally(values);
  const max = Math.max(0, ...Object.values(counts));
  const top = Object.keys(counts).filter((k) => counts[k] === max);
  return top.length === 1 ? top[0] : null;
}
function tally(values) {
  const counts = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;
  return counts;
}

class Room {
  constructor(code, notify) {
    this.code = code;
    this.notify = notify;
    this.players = [];
    this.hostId = null;
    this.settings = { mode: 'crew', pack: 'standard', doubleAgents: true };
    this.phase = 'lobby';
    this.endsAt = null;
    this.phaseSecs = null;
    this.timer = null;
    this.chat = [];
    this.used = new Set();
    this.g = null;
    this.touched = Date.now();
  }

  // ---------------------------------------------------------------- players

  player(id) {
    return this.players.find((p) => p.id === id);
  }

  connected() {
    return this.players.filter((p) => p.connected);
  }

  join(name, token) {
    const existing = this.players.find((p) => p.token === token);
    if (existing) {
      existing.connected = true;
      clearTimeout(existing.dropTimer);
      this.ensureHost();
      return { player: existing };
    }
    name = clean(name, 16);
    if (!name) return { error: 'Pick a nickname first.' };
    if (this.phase !== 'lobby') return { error: 'That heist is already underway. Ask the host to let you in for the next game.' };
    if (this.players.length >= MAX_PLAYERS) return { error: 'This crew is full (8 players max).' };
    let unique = name;
    for (let n = 2; this.players.some((p) => p.name.toLowerCase() === unique.toLowerCase()); n++) {
      unique = `${name.slice(0, 13)} ${n}`;
    }
    const p = { id: newId(), token, name: unique, connected: true, team: this.smallerTeam(), score: 0, bank: 0 };
    this.players.push(p);
    this.ensureHost();
    this.system(`${p.name} joined the crew.`);
    return { player: p };
  }

  disconnect(id) {
    const p = this.player(id);
    if (!p) return;
    p.connected = false;
    if (this.phase === 'lobby') {
      clearTimeout(p.dropTimer);
      p.dropTimer = setTimeout(() => {
        if (!p.connected && this.phase === 'lobby') this.remove(p.id, `${p.name} left.`);
      }, LOBBY_DROP_MS);
    }
    this.ensureHost();
    if (!this.checkProgress()) this.changed();
  }

  leave(id) {
    const p = this.player(id);
    if (!p) return;
    if (this.phase === 'lobby' || this.phase === 'gameover') this.remove(id, `${p.name} left.`);
    else this.disconnect(id);
  }

  remove(id, message) {
    const p = this.player(id);
    if (!p) return;
    clearTimeout(p.dropTimer);
    this.players = this.players.filter((x) => x.id !== id);
    this.ensureHost();
    if (message) this.system(message);
    this.changed();
  }

  ensureHost() {
    const host = this.player(this.hostId);
    if (host && host.connected) return;
    const next = this.connected()[0] || this.players[0];
    this.hostId = next ? next.id : null;
  }

  smallerTeam() {
    const a = this.players.filter((p) => p.team === 'A').length;
    const b = this.players.filter((p) => p.team === 'B').length;
    return a <= b ? 'A' : 'B';
  }

  isEmpty() {
    return this.connected().length === 0;
  }

  // ---------------------------------------------------------------- chat

  say(id, text, channel) {
    const p = this.player(id);
    if (!p) return { error: 'Not in this room.' };
    text = clean(text, 200);
    if (!text) return {};
    const now = Date.now();
    if (p.lastChat && now - p.lastChat < 400) return { error: 'Slow down a little.' };
    p.lastChat = now;
    const teamChat = channel === 'team' && this.g && this.g.mode === 'rivals';
    this.chat.push({ id: newId(), from: p.id, name: p.name, text, to: teamChat ? p.team : 'all', at: now });
    if (this.chat.length > 150) this.chat.shift();
    this.changed();
    return {};
  }

  system(text) {
    this.chat.push({ id: newId(), system: true, text, to: 'all', at: Date.now() });
    if (this.chat.length > 150) this.chat.shift();
  }

  // ---------------------------------------------------------------- lobby

  updateSettings(id, s) {
    if (id !== this.hostId) return { error: 'Only the host can change settings.' };
    if (this.phase !== 'lobby') return { error: 'Settings are locked during a game.' };
    if (['crew', 'rivals'].includes(s.mode)) this.settings.mode = s.mode;
    if (['standard', 'adult', 'mixed'].includes(s.pack)) this.settings.pack = s.pack;
    if (typeof s.doubleAgents === 'boolean') this.settings.doubleAgents = s.doubleAgents;
    this.changed();
    return {};
  }

  setTeam(id, team) {
    const p = this.player(id);
    if (!p || this.phase !== 'lobby' || !['A', 'B'].includes(team)) return {};
    p.team = team;
    this.changed();
    return {};
  }

  shuffleTeams(id) {
    if (id !== this.hostId || this.phase !== 'lobby') return {};
    shuffle(this.players).forEach((p, i) => (p.team = i % 2 ? 'B' : 'A'));
    this.changed();
    return {};
  }

  kick(id, target) {
    if (id !== this.hostId || this.phase !== 'lobby' || target === id) return {};
    const p = this.player(target);
    if (p) this.remove(target, `${p.name} was removed by the host.`);
    return {};
  }

  startError() {
    const n = this.players.length;
    if (this.settings.mode === 'crew') return n < 2 ? 'You need at least 2 players to start.' : null;
    if (n < 4) return 'Rival Crews needs at least 4 players.';
    const a = this.players.filter((p) => p.team === 'A').length;
    if (a < 2 || n - a < 2) return 'Each crew needs at least 2 players. Switch teams or hit Shuffle.';
    return null;
  }

  start(id) {
    if (id !== this.hostId) return { error: 'Only the host can start the game.' };
    if (this.phase !== 'lobby') return {};
    // Anyone who dropped out of the lobby isn't dealt in.
    this.players.filter((p) => !p.connected).forEach((p) => this.remove(p.id));
    const err = this.startError();
    if (err) return { error: err };

    this.players.forEach((p) => (p.score = 0));
    const ps = this.players;
    if (this.settings.mode === 'crew') {
      const moleId = ps.length >= 4 ? ps[rand(ps.length)].id : null;
      this.g = {
        mode: 'crew',
        schedule: moleId
          ? ['trivia', 'bluff', 'trivia', 'interrogate', 'bluff', 'trivia']
          : ['trivia', 'bluff', 'trivia', 'bluff', 'trivia'],
        moleId,
        exposed: false,
        maxAlarms: moleId ? 3 : 2,
        locks: 0,
        alarms: 0,
        results: [],
        safeTurn: rand(ps.length),
      };
    } else {
      const size = { A: ps.filter((p) => p.team === 'A').length, B: ps.filter((p) => p.team === 'B').length };
      const big = Math.max(size.A, size.B);
      const useAgents = this.settings.doubleAgents && ps.length >= 6 && size.A >= 3 && size.B >= 3;
      const pickFrom = (t) => {
        const team = ps.filter((p) => p.team === t);
        return team[rand(team.length)].id;
      };
      this.g = {
        mode: 'rivals',
        schedule: ['trivia', 'bluff', 'poker', 'trivia', 'bluff', 'poker'].concat(useAgents ? ['agentGuess'] : []),
        teamScore: { A: 0, B: 0 },
        scale: { A: big / size.A, B: big / size.B },
        agents: useAgents ? { A: pickFrom('A'), B: pickFrom('B') } : null,
        pokerTurn: 0,
        bluffed: new Set(),
      };
    }
    this.gamesPlayed = (this.gamesPlayed || 0) + 1;
    Object.assign(this.g, { no: this.gamesPlayed, step: -1, round: 0, cur: null, ready: new Set(), winner: null, winners: [] });
    this.chat = [];
    this.system('The heist begins. Check your briefing!');
    this.setPhase('briefing', SECONDS.briefing);
    return {};
  }

  // `restart` deals the same crew straight into a new heist with the same settings;
  // otherwise everyone returns to the lobby (to change mode, pack or teams).
  playAgain(id, restart) {
    if (id !== this.hostId || this.phase !== 'gameover') return {};
    clearTimeout(this.timer);
    this.g = null;
    this.phase = 'lobby';
    this.endsAt = null;
    this.players.filter((p) => !p.connected).forEach((p) => this.remove(p.id));
    if (restart && !this.startError()) return this.start(id);
    this.system(restart
      ? `Back in the lobby: ${this.startError()}`
      : 'Back in the lobby. The host can start another job.');
    this.changed();
    return {};
  }

  // ---------------------------------------------------------------- phase machine

  setPhase(phase, secs) {
    clearTimeout(this.timer);
    this.phase = phase;
    this.phaseSecs = secs || null;
    this.endsAt = secs ? Date.now() + secs * 1000 * TIME_SCALE : null;
    if (secs) {
      this.timer = setTimeout(() => {
        try {
          this.timeout();
        } catch (e) {
          console.error(`[${this.code}] timeout error in ${this.phase}:`, e);
        }
      }, secs * 1000 * TIME_SCALE);
    }
    this.changed();
  }

  timeout() {
    const g = this.g;
    switch (this.phase) {
      case 'briefing': return this.next();
      case 'trivia-answer': return g.mode === 'crew' ? this.openDiscussion() : this.resolveTriviaRace();
      case 'trivia-discuss': return this.resolveTriviaCrew(null);
      case 'bluff-write': return this.openBallot();
      case 'bluff-vote': return this.resolveBluff();
      case 'poker-pitch': return this.openPokerVote();
      case 'poker-vote': return this.resolvePoker();
      case 'interrogate': return this.resolveInterrogate();
      case 'accuse': return this.resolveAccuse();
      case 'agent-guess': return this.resolveAgents();
      default:
        if (this.phase.endsWith('-reveal')) return this.next();
    }
  }

  next() {
    const g = this.g;
    if (g.mode === 'crew') {
      if (g.locks >= LOCKS_TO_WIN) return g.moleId && !g.exposed ? this.startAccuse() : this.finish('crew');
      if (g.alarms >= g.maxAlarms) return this.finish(g.moleId ? 'mole' : 'vault');
    }
    g.step++;
    const kind = g.schedule[g.step];
    if (kind === 'interrogate' && g.exposed) return this.next();
    switch (kind) {
      case 'trivia': return this.startTrivia();
      case 'bluff': return this.startBluff();
      case 'poker': return this.startPoker();
      case 'interrogate': return this.startInterrogate();
      case 'agentGuess': return this.startAgentGuess();
      default:
        if (g.mode === 'crew') return this.finish(g.moleId ? 'mole' : 'vault');
        return this.finishRivals();
    }
  }

  // Players allowed to act in the current phase.
  actors() {
    const g = this.g;
    const cur = g && g.cur;
    let list = this.connected();
    if (!g) return list;
    const benched = g.mode === 'crew' && g.exposed;
    if (benched && ['trivia-answer', 'trivia-discuss', 'bluff-write', 'bluff-vote'].includes(this.phase)) {
      list = list.filter((p) => p.id !== g.moleId);
    }
    if (this.phase === 'poker-pitch') list = list.filter((p) => p.id === cur.bluffer);
    if (this.phase === 'poker-vote') list = list.filter((p) => p.team !== cur.bluffTeam);
    return list;
  }

  canAct(id) {
    return this.actors().some((p) => p.id === id);
  }

  // Advance early once everyone who can act has done so. Returns true if it advanced.
  checkProgress() {
    const g = this.g;
    if (!g) return false;
    const cur = g.cur;
    const actors = this.actors();
    const allIn = (map) => actors.length > 0 && actors.every((p) => map[p.id] !== undefined);
    switch (this.phase) {
      case 'briefing':
        if (actors.length && actors.every((p) => g.ready.has(p.id))) { this.next(); return true; }
        return false;
      case 'trivia-answer':
        if (!allIn(cur.answers)) return false;
        g.mode === 'crew' ? this.openDiscussion() : this.resolveTriviaRace();
        return true;
      case 'bluff-write':
        if (!allIn(cur.fakes)) return false;
        this.openBallot();
        return true;
      case 'bluff-vote':
        if (!allIn(cur.votes)) return false;
        this.resolveBluff();
        return true;
      case 'poker-vote':
        if (!allIn(cur.votes)) return false;
        this.resolvePoker();
        return true;
      case 'interrogate':
      case 'accuse':
      case 'agent-guess':
        if (!allIn(cur.votes)) return false;
        this.timeout();
        return true;
      default:
        return false;
    }
  }

  // Personal money: `score` is this game's net, `bank` the running total for the room.
  pay(pid, amount) {
    const p = this.player(pid);
    if (!p) return;
    p.score += amount;
    p.bank += amount;
  }

  // A miss costs personal money only; team points in Rival Crews are never reduced.
  charge(pid, amount) {
    this.pay(pid, -amount);
  }

  // Money earned by playing well; in Rival Crews it also counts (scaled) for the player's team.
  award(pid, pts) {
    const p = this.player(pid);
    if (!p) return;
    this.pay(pid, pts);
    if (this.g.mode === 'rivals') this.g.teamScore[p.team] += pts * this.g.scale[p.team];
  }

  // Players who could answer this round: connected, and not a benched Mole.
  answerers() {
    const g = this.g;
    return this.connected().filter((p) => !(g.mode === 'crew' && g.exposed && p.id === g.moleId));
  }

  // ---------------------------------------------------------------- player actions

  act(id, a) {
    const g = this.g;
    const p = this.player(id);
    if (!g || !p || !a || typeof a.type !== 'string') return {};
    const cur = g.cur;
    const ph = this.phase;
    const result = this.handle(id, a, g, cur, ph);
    if (result && result.error) return result;
    if (!this.checkProgress()) this.changed();
    return result || {};
  }

  handle(id, a, g, cur, ph) {
    switch (a.type) {
      case 'ready':
        if (ph === 'briefing') g.ready.add(id);
        return {};

      case 'answer': {
        if (ph !== 'trivia-answer' || !this.canAct(id)) return {};
        const c = Number(a.choice);
        if (!Number.isInteger(c) || c < 0 || c > 3) return {};
        if (g.mode === 'rivals' && cur.answers[id] !== undefined) return { error: 'Your answer is already locked in.' };
        cur.answers[id] = c;
        cur.times[id] = Date.now();
        return {};
      }

      case 'pick': {
        if (ph !== 'trivia-discuss' || id !== cur.safecracker) return {};
        const c = Number(a.choice);
        if (!Number.isInteger(c) || c < 0 || c > 3) return {};
        this.resolveTriviaCrew(c);
        return {};
      }

      case 'fake': {
        if (ph !== 'bluff-write' || !this.canAct(id)) return {};
        const text = clean(a.text, 60);
        if (!text) return { error: 'Type a fake answer first.' };
        if (cur.truthKeys.includes(norm(text))) {
          return { error: "Too close to the real answer! Write a different fake (that's a good sign, though)." };
        }
        cur.fakes[id] = text;
        return {};
      }

      case 'vote': {
        if (ph !== 'bluff-vote' || !this.canAct(id)) return {};
        const opt = (this.ballotFor(id) || []).find((o) => o.id === a.option);
        if (!opt) return {};
        if (opt.authors.includes(id)) return { error: "That's your own fake. Pick the answer you think is real." };
        cur.votes[id] = opt.id;
        return {};
      }

      case 'pitchDone':
        if (ph === 'poker-pitch' && id === cur.bluffer) this.openPokerVote();
        return {};

      case 'call':
        if (ph !== 'poker-vote' || !this.canAct(id)) return {};
        if (!['believe', 'busted'].includes(a.value)) return {};
        cur.votes[id] = a.value;
        return {};

      case 'suspect': {
        if (!['interrogate', 'accuse', 'agent-guess'].includes(ph) || !this.canAct(id)) return {};
        const target = a.target;
        if (ph === 'interrogate' && target === 'pass') { cur.votes[id] = 'pass'; return {}; }
        const t = this.player(target);
        if (!t || t.id === id) return {};
        if (ph === 'agent-guess' && t.team !== this.player(id).team) return {};
        cur.votes[id] = t.id;
        return {};
      }

      default:
        return {};
    }
  }

  // ---------------------------------------------------------------- trivia

  startTrivia() {
    const g = this.g;
    const q = content.pick(this.settings.pack, 'trivia', this.used);
    const order = shuffle([0, 1, 2, 3]);
    g.round++;
    g.cur = {
      kind: 'trivia',
      category: q.c,
      question: q.q,
      options: order.map((i) => q.o[i]),
      answer: order.indexOf(0), // packs list the correct option first
      answers: {},
      times: {},
      startedAt: Date.now(),
    };
    if (g.mode === 'crew') {
      g.cur.safecracker = this.nextSafecracker();
      g.cur.tip = !!g.moleId && !g.exposed && Math.random() < 0.5;
    }
    this.setPhase('trivia-answer', SECONDS.triviaAnswer);
  }

  nextSafecracker() {
    const g = this.g;
    const n = this.players.length;
    for (let i = 0; i < n; i++) {
      const idx = (g.safeTurn + i) % n;
      const p = this.players[idx];
      if (p.connected && !(g.exposed && p.id === g.moleId)) {
        g.safeTurn = (idx + 1) % n;
        return p.id;
      }
    }
    return null;
  }

  openDiscussion() {
    if (this.phase !== 'trivia-answer') return;
    this.setPhase('trivia-discuss', SECONDS.triviaDiscuss);
  }

  countedAnswers() {
    const g = this.g;
    return Object.entries(g.cur.answers).filter(([pid]) => !(g.exposed && pid === g.moleId));
  }

  resolveTriviaCrew(pick) {
    if (this.phase !== 'trivia-discuss') return;
    const g = this.g;
    const cur = g.cur;
    if (pick === null) {
      const popular = plurality(this.countedAnswers().map(([, c]) => c));
      cur.pick = popular === null ? rand(4) : Number(popular);
      cur.auto = true;
    } else {
      cur.pick = pick;
    }
    this.payTrivia();
    this.lockResult(cur.pick === cur.answer);
    this.setPhase('trivia-reveal', SECONDS.reveal);
  }

  resolveTriviaRace() {
    if (this.phase !== 'trivia-answer') return;
    const g = this.g;
    const cur = g.cur;
    const before = { ...g.teamScore };
    let fastest = null;
    for (const [pid, c] of Object.entries(cur.answers)) {
      if (c === cur.answer && (!fastest || cur.times[pid] < cur.times[fastest])) fastest = pid;
    }
    this.payTrivia();
    if (fastest) this.award(fastest, MONEY.fastest);
    cur.fastest = fastest;
    cur.gain = { A: g.teamScore.A - before.A, B: g.teamScore.B - before.B };
    this.setPhase('trivia-reveal', SECONDS.reveal);
  }

  // Each player's own private answer: right earns, wrong or missing costs.
  payTrivia() {
    const cur = this.g.cur;
    for (const p of this.answerers()) {
      if (cur.answers[p.id] === cur.answer) this.award(p.id, MONEY.trivia);
      else this.charge(p.id, MONEY.triviaMiss);
    }
  }

  lockResult(ok) {
    const g = this.g;
    g.results.push(ok);
    g.cur.cracked = ok;
    if (ok) {
      g.locks++;
      this.system(`Lock ${g.results.length} cracked! (${g.locks}/${LOCKS_TO_WIN})`);
    } else {
      g.alarms++;
      if (g.moleId) this.award(g.moleId, MONEY.alarmToMole);
      this.system(`Alarm! The Vault has ${g.alarms}/${g.maxAlarms} alarms.`);
    }
  }

  // ---------------------------------------------------------------- bluff

  startBluff() {
    const g = this.g;
    const q = content.pick(this.settings.pack, 'bluff', this.used);
    g.round++;
    g.cur = {
      kind: 'bluff',
      prompt: q.q,
      truth: q.a,
      truthKeys: [q.a, ...(q.alts || [])].map(norm),
      decoys: shuffle(q.d),
      fakes: {},
      votes: {},
      tip: g.mode === 'crew' && !!g.moleId && !g.exposed && Math.random() < 0.5,
    };
    this.setPhase('bluff-write', SECONDS.bluffWrite);
  }

  buildBallot(authorFilter, decoysWanted) {
    const cur = this.g.cur;
    const truth = { text: cur.truth, kind: 'truth', authors: [] };
    const opts = [truth];
    const byKey = new Map([[norm(cur.truth), truth]]);
    for (const [pid, text] of Object.entries(cur.fakes)) {
      if (!authorFilter(pid)) continue;
      const key = norm(text);
      const same = byKey.get(key);
      if (same) {
        if (same.kind === 'fake') same.authors.push(pid);
        continue;
      }
      const o = { text, kind: 'fake', authors: [pid] };
      byKey.set(key, o);
      opts.push(o);
    }
    // Always offer at least four choices.
    let decoys = Math.max(decoysWanted, 4 - opts.length);
    for (const d of cur.decoys) {
      if (decoys <= 0) break;
      if (byKey.has(norm(d))) continue;
      const o = { text: d, kind: 'decoy', authors: [] };
      byKey.set(norm(d), o);
      opts.push(o);
      decoys--;
    }
    return shuffle(opts).map((o) => ({ ...o, id: newId() }));
  }

  openBallot() {
    if (this.phase !== 'bluff-write') return;
    const g = this.g;
    const team = (pid) => (this.player(pid) || {}).team;
    if (g.mode === 'crew') {
      g.cur.ballots = { all: this.buildBallot(() => true, this.players.length <= 4 ? 2 : 1) };
    } else {
      g.cur.ballots = {
        A: this.buildBallot((pid) => team(pid) === 'B', 1),
        B: this.buildBallot((pid) => team(pid) === 'A', 1),
      };
    }
    this.setPhase('bluff-vote', SECONDS.bluffVote);
  }

  ballotFor(pid) {
    const cur = this.g.cur;
    if (!cur || !cur.ballots) return null;
    if (this.g.mode === 'crew') return cur.ballots.all;
    const p = this.player(pid);
    return p ? cur.ballots[p.team] : null;
  }

  resolveBluff() {
    if (this.phase !== 'bluff-vote') return;
    const g = this.g;
    const cur = g.cur;
    const before = g.teamScore ? { ...g.teamScore } : null;
    let found = 0;
    for (const [pid, oid] of Object.entries(cur.votes)) {
      const opt = (this.ballotFor(pid) || []).find((o) => o.id === oid);
      if (!opt) continue;
      if (opt.kind === 'truth') {
        found++;
        this.award(pid, MONEY.truth);
      } else if (opt.kind === 'fake') {
        opt.authors.forEach((a) => this.award(a, MONEY.fooled));
      }
    }
    // Falling for a fake or a Vault decoy, or not voting, costs.
    for (const p of this.answerers()) {
      const opt = (this.ballotFor(p.id) || []).find((o) => o.id === cur.votes[p.id]);
      if (!opt || opt.kind !== 'truth') this.charge(p.id, MONEY.truthMiss);
    }
    cur.found = found;
    if (g.mode === 'crew') {
      cur.counting = Math.max(1, this.connected().filter((p) => !(g.exposed && p.id === g.moleId)).length);
      this.lockResult(found > cur.counting / 2);
    } else {
      cur.gain = { A: g.teamScore.A - before.A, B: g.teamScore.B - before.B };
    }
    this.setPhase('bluff-reveal', SECONDS.reveal);
  }

  // ---------------------------------------------------------------- poker face (rivals)

  startPoker() {
    const g = this.g;
    const team = g.pokerTurn++ % 2 === 0 ? 'A' : 'B';
    const members = this.connected().filter((p) => p.team === team);
    const callers = this.connected().filter((p) => p.team !== team);
    if (!members.length || !callers.length) return this.next();
    const fresh = members.filter((p) => !g.bluffed.has(p.id));
    const pool = fresh.length ? fresh : members;
    const bluffer = pool[rand(pool.length)];
    g.bluffed.add(bluffer.id);
    const st = content.pick(this.settings.pack, 'poker', this.used);
    g.round++;
    g.cur = { kind: 'poker', statement: st.s, truth: !!st.t, bluffTeam: team, bluffer: bluffer.id, votes: {} };
    this.system(`${bluffer.name} is on the hot seat. Grill them in All chat!`);
    this.setPhase('poker-pitch', SECONDS.pokerPitch);
  }

  openPokerVote() {
    if (this.phase !== 'poker-pitch') return;
    this.setPhase('poker-vote', SECONDS.pokerVote);
    this.checkProgress();
  }

  resolvePoker() {
    if (this.phase !== 'poker-vote') return;
    const g = this.g;
    const cur = g.cur;
    const values = Object.values(cur.votes);
    const believe = values.filter((v) => v === 'believe').length;
    const busted = values.length - believe;
    cur.call = believe > busted ? 'believe' : busted > believe ? 'busted' : 'split';
    cur.correct = (cur.call === 'believe' && cur.truth) || (cur.call === 'busted' && !cur.truth);
    const callers = other(cur.bluffTeam);
    if (cur.correct) {
      g.teamScore[callers] += 200;
      for (const [pid, v] of Object.entries(cur.votes)) {
        if ((v === 'believe') === cur.truth) this.pay(pid, MONEY.pokerCall);
      }
      cur.gain = { [callers]: 200, [cur.bluffTeam]: 0 };
    } else {
      g.teamScore[cur.bluffTeam] += 200;
      this.pay(cur.bluffer, MONEY.bluffer);
      cur.gain = { [callers]: 0, [cur.bluffTeam]: 200 };
    }
    // Each caller's own call: wrong or missing costs, whatever the team decided.
    for (const p of this.connected().filter((q) => q.team !== cur.bluffTeam)) {
      const v = cur.votes[p.id];
      if (!v || (v === 'believe') !== cur.truth) this.charge(p.id, MONEY.pokerMiss);
    }
    this.setPhase('poker-reveal', SECONDS.reveal);
  }

  // ---------------------------------------------------------------- deduction votes

  startInterrogate() {
    this.g.cur = { kind: 'interrogate', votes: {} };
    this.system('Interrogation! Talk it over, then vote someone into the van or pass.');
    this.setPhase('interrogate', SECONDS.interrogate);
  }

  resolveInterrogate() {
    if (this.phase !== 'interrogate') return;
    const g = this.g;
    const cur = g.cur;
    const votes = Object.values(cur.votes);
    cur.tally = tally(votes);
    const top = strictTop(votes);
    cur.target = top && top !== 'pass' ? top : null;
    if (!cur.target) {
      cur.outcome = 'pass';
      this.system('The crew passed. Nobody goes in the van.');
    } else if (cur.target === g.moleId) {
      cur.outcome = 'caught';
      g.exposed = true;
      this.system(`${this.player(cur.target).name} WAS the Mole! They're benched for the rest of the job.`);
    } else {
      cur.outcome = 'innocent';
      g.alarms++;
      this.award(g.moleId, MONEY.alarmToMole);
      this.system(`${(this.player(cur.target) || {}).name || 'They'} was innocent. The Vault raises an alarm.`);
    }
    this.payMoleVotes(true);
    this.setPhase('interrogate-reveal', SECONDS.reveal);
  }

  startAccuse() {
    this.g.cur = { kind: 'accuse', votes: {} };
    this.system('The vault is open! Before you split the loot: who is the Mole?');
    this.setPhase('accuse', SECONDS.accuse);
  }

  resolveAccuse() {
    if (this.phase !== 'accuse') return;
    const g = this.g;
    const cur = g.cur;
    const votes = Object.values(cur.votes);
    cur.tally = tally(votes);
    cur.target = strictTop(votes);
    const caught = cur.target === g.moleId;
    this.payMoleVotes(false);
    this.finish(caught ? 'crew' : 'mole');
  }

  // Each crew member's own Mole vote: right earns, an innocent player or no vote costs.
  // A "pass" in the Interrogation is free. The Mole's own votes are never charged.
  payMoleVotes(passAllowed) {
    const g = this.g;
    for (const p of this.answerers()) {
      if (p.id === g.moleId) continue;
      const v = this.g.cur.votes[p.id];
      if (v === g.moleId) this.award(p.id, MONEY.moleVote);
      else if (!(passAllowed && v === 'pass')) this.charge(p.id, MONEY.moleMiss);
    }
  }

  startAgentGuess() {
    this.g.cur = { kind: 'agentGuess', votes: {} };
    this.system('Final round: each crew votes on who their Double Agent is.');
    this.setPhase('agent-guess', SECONDS.agentGuess);
  }

  resolveAgents() {
    if (this.phase !== 'agent-guess') return;
    const g = this.g;
    const cur = g.cur;
    cur.result = {};
    for (const t of ['A', 'B']) {
      const votes = Object.entries(cur.votes)
        .filter(([pid]) => (this.player(pid) || {}).team === t)
        .map(([, v]) => v);
      const top = strictTop(votes);
      const found = top === g.agents[t];
      if (found) g.teamScore[t] += 300;
      cur.result[t] = { tally: tally(votes), top, found };
    }
    this.finishRivals();
  }

  // ---------------------------------------------------------------- endings

  finishRivals() {
    const g = this.g;
    const a = Math.round(g.teamScore.A);
    const b = Math.round(g.teamScore.B);
    this.finish(a > b ? 'A' : b > a ? 'B' : 'tie');
  }

  finish(winner) {
    const g = this.g;
    g.winner = winner;
    if (g.mode === 'crew') {
      g.winners = winner === 'crew' ? this.players.filter((p) => p.id !== g.moleId).map((p) => p.id)
        : winner === 'mole' ? [g.moleId] : [];
    } else if (winner === 'tie') {
      g.winners = this.players.map((p) => p.id);
    } else {
      // Loyal members of the winning team, plus the losing team's Double Agent (who secretly sided with the winners).
      g.winners = this.players
        .filter((p) => (this.loyalty(p) === winner))
        .map((p) => p.id);
    }
    if (g.mode === 'crew') g.winners.forEach((pid) => this.pay(pid, MONEY.heistBonus));
    const label = {
      crew: 'The crew cracked the vault and got away clean!',
      mole: 'The Mole wins! The loot is gone.',
      vault: 'The Vault wins. Alarms everywhere!',
      A: `${TEAM_NAMES.A} wins!`,
      B: `${TEAM_NAMES.B} wins!`,
      tie: "It's a tie!",
    }[winner];
    this.system(label);
    this.setPhase('gameover', 0);
  }

  loyalty(p) {
    const g = this.g;
    if (g.mode !== 'rivals') return null;
    return g.agents && g.agents[p.team] === p.id ? other(p.team) : p.team;
  }

  // ---------------------------------------------------------------- views

  changed() {
    this.touched = Date.now();
    this.notify(this);
  }

  view(pid) {
    const me = this.player(pid);
    if (!me) return { gone: true };
    const g = this.g;
    const v = {
      code: this.code,
      phase: this.phase,
      endsIn: this.endsAt ? Math.max(0, this.endsAt - Date.now()) : null,
      phaseSecs: this.phaseSecs,
      hostId: this.hostId,
      settings: this.settings,
      teamNames: TEAM_NAMES,
      me: { id: me.id, name: me.name, team: me.team },
      players: this.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected, team: p.team, bank: p.bank })),
      chat: this.chat.filter((m) => m.to === 'all' || (g && g.mode === 'rivals' && m.to === me.team)),
      startError: this.phase === 'lobby' ? this.startError() : null,
      game: null,
    };
    if (!g) return v;

    const over = this.phase === 'gameover';
    const game = { no: g.no, mode: g.mode, round: g.round, step: g.step, schedule: g.schedule };
    if (g.mode === 'crew') {
      v.me.role = pid === g.moleId ? 'mole' : 'crew';
      Object.assign(game, {
        locks: g.locks,
        alarms: g.alarms,
        maxAlarms: g.maxAlarms,
        locksToWin: LOCKS_TO_WIN,
        totalLocks: TOTAL_LOCKS,
        results: g.results,
        hasMole: !!g.moleId,
        exposedId: g.exposed ? g.moleId : null,
      });
    } else {
      v.me.role = g.agents && g.agents[me.team] === pid ? 'agent' : 'loyal';
      Object.assign(game, {
        teamScore: { A: Math.round(g.teamScore.A), B: Math.round(g.teamScore.B) },
        scale: g.scale,
        hasAgents: !!g.agents,
      });
    }
    if (this.phase === 'briefing') game.ready = [...g.ready];
    game.cur = this.curView(pid, me);
    if (over) {
      Object.assign(game, {
        winner: g.winner,
        winners: g.winners,
        moleId: g.moleId || null,
        agents: g.agents || null,
        scores: Object.fromEntries(this.players.map((p) => [p.id, p.score])),
      });
    }
    v.game = game;
    return v;
  }

  curView(pid, me) {
    const g = this.g;
    const c = g.cur;
    const ph = this.phase;
    if (!c) return null;
    const isMole = g.mode === 'crew' && pid === g.moleId;
    switch (c.kind) {
      case 'trivia': {
        const v = {
          kind: 'trivia',
          category: c.category,
          question: c.question,
          options: c.options,
          safecracker: c.safecracker || null,
          myAnswer: c.answers[pid] ?? null,
          done: Object.keys(c.answers),
        };
        if (isMole && c.tip && ph !== 'trivia-reveal') v.tip = c.answer;
        if (ph === 'trivia-discuss' || ph === 'trivia-reveal') {
          v.tally = [0, 0, 0, 0];
          this.countedAnswers().forEach(([, a]) => v.tally[a]++);
        }
        if (ph === 'trivia-reveal') {
          Object.assign(v, { answer: c.answer, pick: c.pick ?? null, auto: !!c.auto, cracked: c.cracked ?? null,
            byPlayer: c.answers, fastest: c.fastest || null, gain: c.gain || null });
        }
        return v;
      }
      case 'bluff': {
        const v = { kind: 'bluff', prompt: c.prompt, myFake: c.fakes[pid] ?? null, done: Object.keys(c.fakes) };
        if (isMole && c.tip && ph !== 'bluff-reveal') v.tip = c.truth;
        if (ph === 'bluff-vote' || ph === 'bluff-reveal') {
          v.ballot = (this.ballotFor(pid) || []).map((o) => ({ id: o.id, text: o.text, mine: o.authors.includes(pid) }));
          v.myVote = c.votes[pid] ?? null;
          v.done = Object.keys(c.votes);
        }
        if (ph === 'bluff-reveal') {
          Object.assign(v, { truth: c.truth, cracked: c.cracked ?? null, found: c.found, counting: c.counting || null, gain: c.gain || null });
          v.reveal = Object.entries(c.ballots).map(([key, ballot]) => ({
            key,
            options: ballot.map((o) => ({
              text: o.text,
              kind: o.kind,
              authors: o.authors,
              voters: Object.entries(c.votes).filter(([, oid]) => oid === o.id).map(([vp]) => vp),
            })),
          }));
        }
        return v;
      }
      case 'poker': {
        const v = { kind: 'poker', statement: c.statement, bluffer: c.bluffer, bluffTeam: c.bluffTeam,
          myVote: c.votes[pid] ?? null, done: Object.keys(c.votes) };
        if (pid === c.bluffer || ph === 'poker-reveal') v.truth = c.truth;
        if (ph === 'poker-reveal') Object.assign(v, { call: c.call, correct: c.correct, votes: c.votes, gain: c.gain });
        return v;
      }
      case 'interrogate':
      case 'accuse':
      case 'agentGuess': {
        const v = { kind: c.kind, myVote: c.votes[pid] ?? null, done: Object.keys(c.votes) };
        if (ph === 'interrogate-reveal' || ph === 'gameover') {
          Object.assign(v, { tally: c.tally || null, target: c.target ?? null, outcome: c.outcome || null,
            votes: c.votes, result: c.result || null });
        }
        return v;
      }
      default:
        return null;
    }
  }
}

module.exports = { Room, SECONDS, TEAM_NAMES };
