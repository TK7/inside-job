(() => {
  'use strict';

  // ------------------------------------------------------------ helpers
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };
  const LETTERS = ['A', 'B', 'C', 'D'];

  let token = store.get('ij-token');
  if (!token) {
    token = (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
    store.set('ij-token', token);
  }

  // Minimal Socket.IO-style client over a native WebSocket (/ws): emit(event, data, ack),
  // on(event, fn), plus 'connect' / 'disconnect'. Reconnects with backoff and pings so dead
  // links are noticed (phones sleeping, Wi-Fi switching).
  function connectSocket() {
    const handlers = {};
    const acks = new Map();
    let ws = null;
    let seq = 0;
    let open = false;
    let wasOpen = false;
    let retry = 0;
    let lastHeard = 0;
    let reconnectTimer = null;
    const queue = [];

    function raw(msg) {
      if (open) ws.send(JSON.stringify(msg));
      else queue.push(msg);
    }
    function dial() {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => {
        open = true;
        wasOpen = true;
        retry = 0;
        lastHeard = Date.now();
        handlers.connect && handlers.connect();
        while (queue.length && open) ws.send(JSON.stringify(queue.shift()));
      };
      ws.onmessage = (ev) => {
        lastHeard = Date.now();
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.ack != null) {
          const cb = acks.get(msg.ack);
          acks.delete(msg.ack);
          if (cb) cb(msg.d);
        } else if (msg.e && handlers[msg.e]) {
          handlers[msg.e](msg.d);
        }
      };
      ws.onclose = () => {
        const had = open;
        open = false;
        acks.clear();
        if (had && handlers.disconnect) handlers.disconnect();
        if (!reconnectTimer) reconnectTimer = setTimeout(dial, Math.min(5000, 300 * 2 ** retry++));
      };
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    }
    setInterval(() => {
      if (!open) return;
      if (Date.now() - lastHeard > 30000) return ws.close(); // no pong: link is dead
      ws.send(JSON.stringify({ e: 'ping' }));
    }, 10000);
    // Phones freeze background tabs; reconnect as soon as the page is visible again.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !ws) return;
      if (ws.readyState === WebSocket.CLOSED) dial();
      else if (open && Date.now() - lastHeard > 15000) ws.close();
    });
    dial();
    return {
      on(event, fn) { handlers[event] = fn; },
      emit(event, data, ack) {
        const msg = { e: event, d: data };
        if (typeof ack === 'function') {
          msg.id = ++seq;
          acks.set(msg.id, ack);
        }
        raw(msg);
      },
      get connected() { return open && wasOpen; },
    };
  }

  const socket = connectSocket();
  let S = null; // latest state from the server
  let deadline = null;
  let channel = 'all';
  let chatOpen = false;
  let seenChat = 0;
  let pendingPick = null;
  let pendingKey = '';
  let lastStage = '';

  // ------------------------------------------------------------ home screen
  const params = new URLSearchParams(location.search);
  $('#name').value = store.get('ij-name') || '';
  $('#code').value = (params.get('code') || '').toUpperCase().slice(0, 4);
  if ($('#code').value && !$('#name').value) $('#name').focus();

  function showHome(message) {
    S = null;
    lastStage = '';
    $('#finale').hidden = true;
    stopConfetti();
    $('#room').hidden = true;
    $('#home').hidden = false;
    $('#home-error').textContent = message || '';
    document.title = 'Inside Job';
  }

  function join(create) {
    const name = $('#name').value.trim();
    const code = $('#code').value.trim().toUpperCase();
    if (!name) return showHome('Pick a nickname first.');
    if (!create && code.length !== 4) return showHome('Room codes are 4 letters.');
    store.set('ij-name', name);
    $('#home-error').textContent = '';
    socket.emit('join', { name, code, token, create }, (res) => {
      if (res.error) return showHome(res.error);
      store.set('ij-room', res.code);
      history.replaceState(null, '', `/?code=${res.code}`);
    });
  }
  $('#join-btn').onclick = () => join(false);
  $('#create-btn').onclick = () => join(true);
  $('#code').addEventListener('input', (e) => (e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '')));
  $('#code').addEventListener('keydown', (e) => e.key === 'Enter' && join(false));
  $('#name').addEventListener('keydown', (e) => e.key === 'Enter' && ($('#code').value ? join(false) : join(true)));

  // ------------------------------------------------------------ socket
  socket.on('connect', () => {
    const code = store.get('ij-room');
    if (!code) return showHome();
    // Rejoin the room we were in (same token keeps our seat).
    socket.emit('join', { code, name: store.get('ij-name') || 'Player', token }, (res) => {
      if (res.error) {
        store.del('ij-room');
        showHome(S ? res.error : '');
      }
    });
  });
  socket.on('disconnect', () => toast('Connection lost. Reconnecting…', true));
  socket.on('state', (state) => {
    if (state.gone) {
      store.del('ij-room');
      return showHome('You were removed from the room.');
    }
    // Tell players when their own money moves (same room, same seat).
    const was = S && S.code === state.code && S.me.id === state.me.id ? S.players.find((p) => p.id === S.me.id) : null;
    const now = state.players.find((p) => p.id === state.me.id);
    S = state;
    deadline = state.endsIn == null ? null : Date.now() + state.endsIn;
    render();
    if (was && now && now.bank !== was.bank) {
      const d = now.bank - was.bank;
      toast(`${d > 0 ? '+' : '−'}$${Math.abs(d).toLocaleString('en-US')} · your total: ${now.bank < 0 ? '−' : ''}$${Math.abs(now.bank).toLocaleString('en-US')}`, d < 0);
    }
  });

  function send(event, data) {
    socket.emit(event, data || {}, (res) => res && res.error && toast(res.error, true));
  }
  const act = (data) => send('act', data);

  let toastTimer;
  function toast(text, err) {
    const el = $('#toast');
    el.textContent = text;
    el.className = 'toast' + (err ? ' err' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3200);
  }

  // ------------------------------------------------------------ lookups
  const P = (id) => (S && S.players.find((p) => p.id === id)) || { name: 'Someone', id };
  const nm = (id) => esc(P(id).name);
  const isHost = () => S.hostId === S.me.id;
  const G = () => S.game;
  const cur = () => (S.game ? S.game.cur : null);
  const teamName = (t) => esc(S.teamNames[t]);
  const other = (t) => (t === 'A' ? 'B' : 'A');
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const teamChip = (t) => `<span class="tag ${t}">${teamName(t)}</span>`;
  // $1,250 / -$150 (red); `signed` adds + for gains, as in "+$300".
  function money(n, signed) {
    n = Math.round(n || 0);
    const text = `${n < 0 ? '−' : signed && n > 0 ? '+' : ''}$${Math.abs(n).toLocaleString('en-US')}`;
    return `<span class="money${n < 0 ? ' neg' : ''}">${text}</span>`;
  }
  function colorFor(id) {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 70% 70%)`;
  }
  function actorsCount() {
    const g = G();
    const c = cur();
    let ps = S.players.filter((p) => p.connected);
    if (g.mode === 'crew' && g.exposedId && ['trivia-answer', 'trivia-discuss', 'bluff-write', 'bluff-vote'].includes(S.phase)) ps = ps.filter((p) => p.id !== g.exposedId);
    if (S.phase === 'poker-vote') ps = ps.filter((p) => p.team !== c.bluffTeam);
    return ps.length;
  }
  const progress = (verb) => `<p class="muted small">${(cur().done || []).length} of ${actorsCount()} ${verb}</p>`;
  const benched = () => G().mode === 'crew' && G().exposedId === S.me.id;

  // ------------------------------------------------------------ render
  function render() {
    $('#home').hidden = true;
    $('#room').hidden = false;
    $('#room-code').textContent = S.code;
    document.title = `Inside Job · ${S.code}`;
    renderStatus();
    renderPlayers();
    renderChat();
    renderStage();
    renderFinale();
    tick();
  }

  function renderStatus() {
    const g = G();
    let html = '';
    if (!g) {
      html = '<span class="round-label">Lobby</span>';
    } else if (g.mode === 'crew') {
      const pips = (n, of, cls) => Array.from({ length: of }, (_, i) => `<span class="pip ${cls} ${i < n ? 'on' : ''}"></span>`).join('');
      html = `<span class="meter"><span class="lbl">Locks</span><span class="pips">${pips(g.locks, g.locksToWin, 'lock')}</span></span>
              <span class="meter"><span class="lbl">Alarms</span><span class="pips">${pips(g.alarms, g.maxAlarms, 'alarm')}</span></span>`;
    } else {
      html = `<span class="score A">${g.teamScore.A}</span><span class="round-label">Round ${Math.min(g.round, 6)}/6</span><span class="score B">${g.teamScore.B}</span>`;
    }
    $('#status').innerHTML = html;
  }

  function renderPlayers() {
    const g = G();
    const c = cur();
    const done = new Set(S.phase === 'briefing' ? g.ready : c && c.done ? c.done : []);
    const over = S.phase === 'gameover';
    $('#players').innerHTML = S.players
      .map((p) => {
        const tags = [];
        if (p.id === S.hostId) tags.push('<span class="tag gold">Host</span>');
        if (g && g.mode === 'rivals') tags.push(`<span class="tag ${p.team}">${p.team === 'A' ? 'Crimson' : 'Cobalt'}</span>`);
        if (!g && S.settings.mode === 'rivals') tags.push(`<span class="tag ${p.team}">${p.team === 'A' ? 'Crimson' : 'Cobalt'}</span>`);
        if (c && c.safecracker === p.id && S.phase.startsWith('trivia')) tags.push('<span class="tag gold">Safecracker</span>');
        if (c && c.bluffer === p.id && S.phase.startsWith('poker')) tags.push('<span class="tag gold">Hot seat</span>');
        if (g && g.mode === 'crew' && g.exposedId === p.id) tags.push('<span class="tag red">Benched Mole</span>');
        if (over && g.moleId === p.id && !g.exposedId) tags.push('<span class="tag red">Mole</span>');
        if (over && g.agents && (g.agents.A === p.id || g.agents.B === p.id)) tags.push('<span class="tag red">Double Agent</span>');
        if (!over && done.has(p.id)) tags.push('<span class="check" title="Done">✓</span>');
        const kick = !g && isHost() && p.id !== S.me.id ? `<button class="kick" data-kick="${p.id}" title="Remove ${esc(p.name)}">✕</button>` : '';
        return `<li class="${p.id === S.me.id ? 'me' : ''}">
          <span class="dot ${p.connected ? '' : 'off'}"></span>
          <span class="pname ${p.connected ? '' : 'off-name'}">${esc(p.name)}${p.id === S.me.id ? ' <span class="muted">(you)</span>' : ''}</span>
          ${tags.join('')}<span class="bank" title="Running total in this room">${money(p.bank)}</span>${kick}</li>`;
      })
      .join('');
  }

  function renderChat() {
    const rivalsGame = G() && G().mode === 'rivals';
    $('#channels').hidden = !rivalsGame;
    if (!rivalsGame) channel = 'all';
    document.querySelectorAll('.ch').forEach((b) => b.classList.toggle('active', b.dataset.ch === channel));
    $('#chat-input').placeholder = channel === 'team' ? `Message ${S.teamNames[S.me.team]} only…` : 'Message everyone…';

    const list = $('#messages');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    list.innerHTML = S.chat
      .map((m) =>
        m.system
          ? `<li class="sys">${esc(m.text)}</li>`
          : `<li class="${m.to !== 'all' ? 'team-msg' : ''}"><span class="who" style="color:${colorFor(m.from)}">${esc(m.name)}</span>${esc(m.text)}</li>`)
      .join('');
    if (nearBottom || S.chat.length !== seenChat) list.scrollTop = list.scrollHeight;
    const mobile = matchMedia('(max-width: 860px)').matches;
    const unread = S.chat.length - seenChat;
    if (!mobile || chatOpen) seenChat = S.chat.length;
    $('#unread').hidden = !(mobile && !chatOpen && unread > 0);
    $('#unread').textContent = unread > 9 ? '9+' : unread;
  }

  // Re-render the stage only when its HTML changes, keeping typed text and focus.
  function renderStage() {
    const key = `${S.phase}|${G() ? G().round : ''}`;
    if (key !== pendingKey) {
      pendingPick = null;
      pendingKey = key;
    }
    const html = stageHtml();
    if (html === lastStage) return;
    lastStage = html;
    const stage = $('#stage');
    const active = document.activeElement;
    const keep = {};
    stage.querySelectorAll('input[id]').forEach((i) => (keep[i.id] = { value: i.value, focus: i === active, start: i.selectionStart }));
    stage.innerHTML = html;
    for (const [id, k] of Object.entries(keep)) {
      const el = document.getElementById(id);
      if (!el || el.dataset.fresh) continue;
      el.value = k.value;
      if (k.focus) {
        el.focus();
        try { el.setSelectionRange(k.start, k.start); } catch { /* not a text input */ }
      }
    }
  }

  function stageHtml() {
    const ph = S.phase;
    if (ph === 'lobby') return lobby();
    if (ph === 'briefing') return briefing();
    if (ph === 'gameover') return gameover();
    if (ph.startsWith('trivia')) return trivia();
    if (ph.startsWith('bluff')) return bluff();
    if (ph.startsWith('poker')) return poker();
    if (ph.startsWith('interrogate')) return interrogate();
    if (ph === 'accuse') return accuse();
    if (ph === 'agent-guess') return agentGuess();
    return '<div class="card">Loading…</div>';
  }

  function header(kindLabel, extra) {
    const g = G();
    const where = g.mode === 'crew' ? `Lock ${Math.min(g.round, 5)} of 5` : `Round ${g.round} of 6`;
    return `<p class="eyebrow">${where} · ${kindLabel}${extra ? ` · ${esc(extra)}` : ''}</p>`;
  }

  // ------------------------------------------------------------ lobby
  function lobby() {
    const s = S.settings;
    const host = isHost();
    const dis = host ? '' : 'disabled';
    const seg = (field, value, title, sub) =>
      `<button class="${s[field] === value ? 'on' : ''}" data-set="${field}" data-v="${value}" ${dis}><strong>${title}</strong><span>${sub}</span></button>`;
    const n = S.players.length;
    let teams = '';
    if (s.mode === 'rivals') {
      const col = (t) => `<div class="team-col ${t}"><h4>${teamName(t)}</h4><ul>${S.players
        .filter((p) => p.team === t)
        .map((p) => `<li>${esc(p.name)}${p.id === S.me.id ? ' <span class="muted">(you)</span>' : ''}</li>`)
        .join('') || '<li class="muted">Nobody yet</li>'}</ul>
        ${S.me.team !== t ? `<button class="btn small" data-team="${t}">Join ${t === 'A' ? 'Crimson' : 'Cobalt'}</button>` : '<span class="muted small">Your team</span>'}</div>`;
      teams = `<div><div class="setting-label">Teams</div><div class="teams">${col('A')}${col('B')}</div>
        ${host ? '<div class="spacer"></div><button class="btn small" data-shuffle>Shuffle teams</button>' : ''}</div>
        <label class="toggle"><input type="checkbox" data-agents ${s.doubleAgents ? 'checked' : ''} ${dis}>
          <span>Double Agents <span class="muted small">(needs 6+ players with 3+ per team; currently ${n >= 6 ? 'eligible' : 'too few players'})</span></span></label>`;
    }
    const modeNote = s.mode === 'crew'
      ? (n >= 4 ? 'With 4+ players, one of you will secretly be the Mole.' : 'With 2–3 players it is pure co-op (no Mole). Get 4+ for a Mole.')
      : 'Two crews compete over 6 rounds of trivia, bluffing and Poker Face.';
    return `
      <div class="card">
        <p class="eyebrow">Room code</p>
        <div class="lobby-code">${esc(S.code)}</div>
        <p class="muted">Friends join at <strong>${esc(location.host)}</strong> with this code, or send them the invite link.</p>
        <div class="row"><button class="btn primary" data-copy>Copy invite link</button><a class="btn" href="/rules" target="_blank" rel="noopener">How to play</a></div>
      </div>
      <div class="card">
        <p class="eyebrow">Game setup ${host ? '' : '<span class="muted">(the host chooses)</span>'}</p>
        <div class="settings">
          <div><div class="setting-label">Mode</div><div class="seg">
            ${seg('mode', 'crew', 'Crew vs. The Vault', 'Co-op against the computer + hidden Mole · 2–8')}
            ${seg('mode', 'rivals', 'Rival Crews', 'Team vs. team · 4–8')}
          </div><p class="muted small">${modeNote}</p></div>
          <div><div class="setting-label">Question pack</div><div class="seg">
            ${seg('pack', 'standard', 'Standard', 'Family-friendly')}
            ${seg('pack', 'adult', 'After Hours 18+', 'Drinks, dating & cheeky facts')}
            ${seg('pack', 'mixed', 'Mixed', 'Both packs')}
          </div></div>
          ${teams}
        </div>
      </div>
      <div class="card">
        ${host
          ? `<button class="btn gold big wide" data-start ${S.startError ? 'disabled' : ''}>Start the heist</button>
             ${S.startError ? `<p class="muted small">${esc(S.startError)}</p>` : `<p class="muted small">${plural(n, 'player')} ready. Everyone gets a 15-second briefing first.</p>`}`
          : `<p>Waiting for <strong>${nm(S.hostId)}</strong> to start the game…</p><p class="muted small">Read <a href="/rules" target="_blank" rel="noopener">How to play</a> while you wait.</p>`}
      </div>`;
  }

  // ------------------------------------------------------------ briefing
  function briefing() {
    const g = G();
    const role = S.me.role;
    const ready = g.ready.includes(S.me.id);
    let card;
    if (g.mode === 'crew') {
      if (role === 'mole') {
        card = `<div class="card role mole"><p class="eyebrow">Your secret role</p><div class="title">You're the Mole</div>
          <p>You work for the Vault. Keep it secret!</p><ul>
          <li>You win if the Vault raises <strong>${g.maxAlarms} alarms</strong>, <em>or</em> if the crew opens the vault but fails to name you in the Final Accusation.</li>
          <li>Some rounds you'll get an <strong>insider tip</strong> showing the real answer. Use it to steer the crew wrong without looking guilty.</li>
          <li>Everyone's answers and votes are revealed after each lock, so don't be obvious.</li>
          <li>Each alarm earns you +$150.</li>${moneyRule()}</ul></div>`;
      } else {
        card = `<div class="card role crew"><p class="eyebrow">Your role</p><div class="title">You're Crew</div>
          <p>Work together to rob the Vault.</p><ul>
          <li>Crack <strong>3 of 5 locks</strong> before the Vault raises <strong>${g.maxAlarms} alarms</strong>.</li>
          <li><strong>Trivia locks:</strong> answer privately, discuss, then the Safecracker locks in the crew's answer.</li>
          <li><strong>Bluff locks:</strong> write a fake answer, then find the real one. More than half the crew must find the truth.</li>
          ${g.hasMole ? '<li><strong>One of you is the Mole.</strong> Watch who steers you wrong. You get one Interrogation mid-game and a Final Accusation at the end.</li>' : '<li>No Mole this time. It\'s pure co-op against the Vault.</li>'}
          ${moneyRule()}</ul></div>`;
      }
    } else if (role === 'agent') {
      card = `<div class="card role agent"><p class="eyebrow">Your secret role</p><div class="title">Double Agent</div>
        <p>You sit with ${teamChip(S.me.team)} but you secretly win if ${teamChip(other(S.me.team))} wins.</p><ul>
        <li>Play along, but quietly cost your team points: wrong answers, bad calls, weak fakes.</li>
        <li>At the end your team votes on who the Double Agent is. If they catch you, they get +300.</li></ul></div>`;
    } else {
      card = `<div class="card role loyal"><p class="eyebrow">Your team</p><div class="title">${teamName(S.me.team)}</div>
        <p>Outscore ${teamChip(other(S.me.team))} over 6 rounds.</p><ul>
        <li><strong>Trivia Race:</strong> first tap locks in. +100 per correct player, +50 for the fastest.</li>
        <li><strong>Smoke & Mirrors:</strong> fool the other team with fakes, and find the truth on your own ballot.</li>
        <li><strong>Poker Face:</strong> one player defends a statement as TRUE. The other team calls Believe or Busted.</li>
        ${g.hasAgents ? '<li><strong>Each team has a secret Double Agent</strong> working for the other side. You\'ll vote on yours at the end (+300).</li>' : ''}
        ${moneyRule()}</ul></div>`;
    }
    function moneyRule() {
      return `<li><strong>Your money:</strong> right answers pay, and a wrong answer or no answer costs half as much.${g.mode === 'crew' ? ' Winners get a $250 heist bonus.' : ''} Your total carries over between games in this room (you have ${money(P(S.me.id).bank)}).</li>`;
    }
    return `${card}<div class="card row"><button class="btn gold big" data-ready ${ready ? 'disabled' : ''}>${ready ? 'Ready ✓' : "I'm ready"}</button>
      <span class="muted small">The game starts when everyone is ready, or when the timer runs out.</span></div>`;
  }

  // ------------------------------------------------------------ trivia
  function trivia() {
    const g = G();
    const c = cur();
    const ph = S.phase;
    const crew = g.mode === 'crew';
    const reveal = ph === 'trivia-reveal';
    const amSafe = c.safecracker === S.me.id;
    let top = '';
    let instr = '';

    if (ph === 'trivia-answer') {
      instr = crew
        ? `Pick your answer privately: +$100 if you're right, −$50 if you're wrong or don't answer. Next, the crew sees the tally and <strong>${nm(c.safecracker)}</strong> (Safecracker) locks in the crew's answer.`
        : 'Answer fast. Your first tap is final. +100 for you and your team if correct (−$50 for you if wrong or no answer), +50 bonus for the fastest correct player.';
      if (benched()) instr = "You've been caught and benched. Watch the crew work.";
    } else if (ph === 'trivia-discuss') {
      instr = amSafe
        ? "<strong>You're the Safecracker.</strong> Read the chat, then tap an answer and confirm to lock it in for the crew. If time runs out, the most popular answer is used."
        : `Discuss in chat. <strong>${nm(c.safecracker)}</strong> is the Safecracker and will lock in the crew's answer.`;
    } else if (crew) {
      const how = c.auto ? "Time ran out, so the crew's most popular answer was used" : `${nm(c.safecracker)} locked in ${LETTERS[c.pick]}`;
      top = c.cracked
        ? `<div class="banner good"><span class="big">Lock cracked!</span><span>${how}.</span></div>`
        : `<div class="banner bad"><span class="big">Alarm!</span><span>${how}. Wrong answer!</span></div>`;
    } else {
      const fast = c.fastest ? ` Fastest: <strong>${nm(c.fastest)}</strong> (+50).` : '';
      top = `<div class="banner neutral"><span>Answer: <strong>${LETTERS[c.answer]}. ${esc(c.options[c.answer])}</strong>.${fast}
        <br>${teamChip('A')} +${Math.round(c.gain.A)} · ${teamChip('B')} +${Math.round(c.gain.B)}</span></div>`;
    }

    const tip = c.tip != null ? `<div class="tip-box">🕵️ <strong>Insider tip</strong> (only you can see this): the answer is <strong>${LETTERS[c.tip]}. ${esc(c.options[c.tip])}</strong></div>` : '';
    const totalVotes = c.tally ? c.tally.reduce((a, b) => a + b, 0) : 0;
    const byOption = [[], [], [], []];
    if (reveal && c.byPlayer) for (const [pid, a] of Object.entries(c.byPlayer)) byOption[a].push(pid);

    const opts = c.options
      .map((o, i) => {
        const cls = ['opt'];
        let disabled = true;
        let action = '';
        if (ph === 'trivia-answer') {
          if (c.myAnswer === i) cls.push('chosen');
          disabled = benched() || (!crew && c.myAnswer != null);
          action = `data-answer="${i}"`;
        } else if (ph === 'trivia-discuss') {
          if (pendingPick === i) cls.push('chosen');
          else if (c.myAnswer === i && !amSafe) cls.push('chosen');
          disabled = !amSafe;
          action = `data-pick="${i}"`;
        } else {
          if (i === c.answer) cls.push('correct');
          else if (crew && i === c.pick) cls.push('wrong');
          else if (!crew && i === c.myAnswer) cls.push('wrong');
        }
        if (c.tip === i) cls.push('tip');
        const count = c.tally ? `<span class="count">${c.tally[i]}</span>` : '';
        const bar = c.tally && totalVotes ? `<span class="bar" style="width:${(c.tally[i] / totalVotes) * 100}%"></span>` : '';
        const who = reveal && byOption[i].length ? `<span class="chips">${byOption[i].map((p) => `<span class="chip">${nm(p)}</span>`).join('')}</span>` : '';
        const mine = c.myAnswer === i && ph !== 'trivia-answer' ? '<span class="sub">your answer</span>' : '';
        return `<button class="${cls.join(' ')}" ${action} ${disabled ? 'disabled' : ''}><span class="letter">${LETTERS[i]}</span>${count}${esc(o)}${mine}${who}${bar}</button>`;
      })
      .join('');

    const confirm = ph === 'trivia-discuss' && amSafe && pendingPick != null
      ? `<div class="spacer"></div><button class="btn gold big wide" data-lock>Lock in ${LETTERS[pendingPick]}: ${esc(c.options[pendingPick])}</button>` : '';
    const footer = ph === 'trivia-answer' ? progress('answered') : reveal ? '<p class="muted small">Next round starting soon…</p>' : '';

    return `${top}<div class="card">${header(crew ? 'Crack the Code' : 'Trivia Race', c.category)}
      <p class="question">${esc(c.question)}</p>${instr ? `<p class="instruction">${instr}</p>` : ''}${reveal ? '' : tip}
      <div class="options">${opts}</div>${confirm}${footer}</div>`;
  }

  // ------------------------------------------------------------ bluff
  function blankify(text) {
    return esc(text).replace(/_{2,}/, '<span style="border-bottom:2px solid var(--gold);padding:0 22px"></span>');
  }

  function bluff() {
    const g = G();
    const c = cur();
    const ph = S.phase;
    const crew = g.mode === 'crew';
    let body = '';
    let top = '';
    const tip = c.tip ? `<div class="tip-box">🕵️ <strong>Insider tip</strong> (only you can see this): the real answer is <strong>${esc(c.tip)}</strong></div>` : '';

    if (ph === 'bluff-write') {
      const instr = crew
        ? "Write a believable <strong>fake</strong> answer. Everyone then hunts for the real one among the fakes. +50 for each player you fool, but if more than half the crew is fooled, the lock fails."
        : "Write a believable <strong>fake</strong> answer. It goes on the <strong>other team's</strong> ballot. +50 for each opponent you fool.";
      body = benched()
        ? '<p class="instruction">You\'ve been caught and benched. Watch the crew work.</p>'
        : `<p class="instruction">${instr}</p>${tip}
          <form class="fake-form" data-fake-form><input id="fake" maxlength="60" placeholder="Your fake answer" autocomplete="off"><button class="btn gold">${c.myFake ? 'Update' : 'Submit'}</button></form>
          ${c.myFake ? `<p class="small">Your fake: <strong>“${esc(c.myFake)}”</strong> <span class="muted">(you can change it until time's up)</span></p>` : ''}`;
      body += progress('written');
    } else if (ph === 'bluff-vote') {
      const instr = `Which answer is <strong>real</strong>? Pick one. You can't pick your own fake.${crew ? ' More than half the crew must find the truth to crack the lock.' : " Your ballot has the other team's fakes."}`;
      body = benched()
        ? '<p class="instruction">You\'ve been caught and benched. Watch the crew vote.</p>'
        : `<p class="instruction">${instr}</p>${tip}`;
      body += `<div class="ballot">${c.ballot
        .map((o) => `<button class="opt ${c.myVote === o.id ? 'chosen' : ''}" data-vote="${o.id}" ${o.mine || benched() ? 'disabled' : ''}>${esc(o.text)}${o.mine ? '<span class="sub">your fake</span>' : ''}</button>`)
        .join('')}</div>${progress('voted')}`;
    } else {
      if (crew) {
        top = c.cracked
          ? `<div class="banner good"><span class="big">Lock cracked!</span><span>${c.found} of ${c.counting} found the truth.</span></div>`
          : `<div class="banner bad"><span class="big">Alarm!</span><span>Only ${c.found} of ${c.counting} found the truth. More than half was needed.</span></div>`;
      } else {
        top = `<div class="banner neutral"><span>The truth: <strong>${esc(c.truth)}</strong><br>${teamChip('A')} +${Math.round(c.gain.A)} · ${teamChip('B')} +${Math.round(c.gain.B)}</span></div>`;
      }
      body = c.reveal
        .map((b) => {
          const label = b.key === 'all' ? '' : `<p class="setting-label">${teamName(b.key)}'s ballot</p>`;
          const rows = b.options
            .map((o) => {
              const kind = o.kind === 'truth' ? '<span class="tag green">TRUTH</span>'
                : o.kind === 'decoy' ? '<span class="tag">Vault decoy</span>'
                : `<span class="tag gold">Fake by ${o.authors.map(nm).join(', ')}</span>`;
              const voters = o.voters.length ? `<span class="chips">${o.voters.map((v) => `<span class="chip">${nm(v)}</span>`).join('')}</span>` : '<span class="sub">no votes</span>';
              return `<div class="opt ${o.kind === 'truth' ? 'correct' : ''}" style="padding-left:16px">${kind} ${esc(o.text)}${voters}</div>`;
            })
            .join('');
          return `${label}<div class="ballot">${rows}</div>`;
        })
        .join('<div class="spacer"></div>');
      body += '<p class="muted small">Next round starting soon…</p>';
    }
    return `${top}<div class="card">${header('Smoke & Mirrors')}<p class="question">${blankify(c.prompt)}</p>${body}</div>`;
  }

  // ------------------------------------------------------------ poker face
  function poker() {
    const c = cur();
    const ph = S.phase;
    const me = S.me;
    const bluffer = nm(c.bluffer);
    const callers = other(c.bluffTeam);
    const truthCard = (t) => `<div class="truth-card ${t ? 'T' : 'F'}">${t ? "It's TRUE" : "It's FALSE"}</div>`;
    let body = '';
    let top = '';

    if (ph === 'poker-pitch') {
      if (me.id === c.bluffer) {
        body = `${truthCard(c.truth)}<p class="instruction">Only you know this. Convince ${teamChip(callers)} that the statement is <strong>TRUE</strong> using All chat, and answer their questions. If they call it right, they score +200. If you fool them, your team does.</p>
          <button class="btn gold" data-pitch-done>Done pitching, go to the vote</button>`;
      } else if (me.team === c.bluffTeam) {
        body = `<p class="instruction">Your teammate <strong>${bluffer}</strong> is defending this statement as TRUE. You don't know the real answer either, but help sell it in chat!</p>`;
      } else {
        body = `<p class="instruction"><strong>${bluffer}</strong> claims this is <strong>TRUE</strong>. Grill them in All chat. Next you'll vote <strong>Believe</strong> or <strong>Busted</strong>.</p>`;
      }
    } else if (ph === 'poker-vote') {
      if (me.team !== c.bluffTeam) {
        body = `<p class="instruction">Is <strong>${bluffer}</strong> telling the truth? Majority decides for your team, and a tie goes to the bluffer.</p>
          <div class="options"><button class="opt ${c.myVote === 'believe' ? 'chosen' : ''}" data-call="believe" style="padding-left:16px">✅ Believe: it's true</button>
          <button class="opt ${c.myVote === 'busted' ? 'chosen' : ''}" data-call="busted" style="padding-left:16px">🚨 Busted: it's false</button></div>${progress('voted')}`;
      } else {
        body = `${me.id === c.bluffer ? truthCard(c.truth) : ''}<p class="instruction">${teamChip(callers)} is deciding whether to believe ${bluffer}…</p>${progress('voted')}`;
      }
    } else {
      const callText = c.call === 'split' ? 'split their vote (a tie goes to the bluffer)' : `called <strong>${c.call === 'believe' ? 'Believe' : 'Busted'}</strong>`;
      top = c.correct
        ? `<div class="banner good"><span class="big">Called it!</span><span>${teamChip(callers)} ${callText} and earns +200.</span></div>`
        : `<div class="banner bad"><span class="big">Fooled!</span><span>${teamChip(callers)} ${callText}. ${bluffer} wins +200 for ${teamChip(c.bluffTeam)}.</span></div>`;
      const votes = Object.entries(c.votes || {}).map(([p, v]) => `<span class="chip">${nm(p)}: ${v === 'believe' ? 'Believe' : 'Busted'}</span>`).join('');
      body = `${truthCard(c.truth)}<div class="chips">${votes || '<span class="muted small">No votes were cast.</span>'}</div><p class="muted small">Next round starting soon…</p>`;
    }
    return `${top}<div class="card">${header('Poker Face', `${S.teamNames[c.bluffTeam]} bluffs`)}<div class="statement">“${esc(c.statement)}”</div>${body}</div>`;
  }

  // ------------------------------------------------------------ deduction votes
  function suspectButtons(ids, extra) {
    const c = cur();
    return `<div class="suspects">${ids
      .map((id) => `<button class="opt ${c.myVote === id ? 'chosen' : ''}" data-suspect="${id}">${nm(id)}${P(id).connected ? '' : '<span class="sub">offline</span>'}</button>`)
      .join('')}${extra || ''}</div>`;
  }

  function interrogate() {
    const c = cur();
    const g = G();
    if (S.phase === 'interrogate-reveal') {
      const tallyChips = Object.entries(c.tally || {}).map(([k, n]) => `<span class="chip">${k === 'pass' ? 'Pass' : nm(k)}: ${n}</span>`).join('');
      const banner = c.outcome === 'caught'
        ? `<div class="banner good"><span class="big">Mole caught!</span><span><strong>${nm(c.target)}</strong> was the Mole and is benched for the rest of the job.</span></div>`
        : c.outcome === 'innocent'
          ? `<div class="banner bad"><span class="big">Wrong person!</span><span><strong>${nm(c.target)}</strong> was innocent. The Vault raises an alarm.</span></div>`
          : '<div class="banner neutral"><span class="big">Pass</span><span>Nobody goes in the van. The Mole is still out there…</span></div>';
      return `${banner}<div class="card"><p class="eyebrow">Interrogation votes</p><div class="chips">${tallyChips || '<span class="muted">No votes</span>'}</div><p class="muted small">Next round starting soon…</p></div>`;
    }
    const others = S.players.filter((p) => p.id !== S.me.id).map((p) => p.id);
    const pass = `<button class="opt ${c.myVote === 'pass' ? 'chosen' : ''}" data-suspect="pass">Pass <span class="sub">no accusation</span></button>`;
    return `<div class="card"><p class="eyebrow">Interrogation · one chance only</p><div class="title">Who's the Mole?</div>
      <p class="instruction">Talk it over in chat, then vote someone into the van or vote to pass. The top choice wins, and a tie means pass.
      Catch the Mole and they're benched for the rest of the job. Accuse an innocent player and the Vault gets an alarm (${g.alarms}/${g.maxAlarms} so far).
      ${S.me.role === 'mole' ? '<br><strong>You are the Mole.</strong> Blend in!' : ''}</p>
      ${suspectButtons(others, pass)}${progress('voted')}</div>`;
  }

  function accuse() {
    const others = S.players.filter((p) => p.id !== S.me.id).map((p) => p.id);
    return `<div class="card"><p class="eyebrow">The vault is open</p><div class="title">Final Accusation</div>
      <p class="instruction">The crew cracked 3 locks, but the Mole is still hiding among you. Everyone votes. If the Mole gets the <strong>most votes</strong>, the crew wins. If not (a tie counts as not), the Mole escapes with the loot.
      ${S.me.role === 'mole' ? '<br><strong>You are the Mole.</strong> Vote for someone else and argue for it!' : ''}</p>
      ${suspectButtons(others)}${progress('voted')}</div>`;
  }

  function agentGuess() {
    const mates = S.players.filter((p) => p.team === S.me.team && p.id !== S.me.id).map((p) => p.id);
    return `<div class="card"><p class="eyebrow">Final round</p><div class="title">Unmask the Double Agent</div>
      <p class="instruction">Vote for the teammate you think secretly works for ${teamChip(other(S.me.team))}. If most of ${teamChip(S.me.team)} picks the right person, your team gets +300. Use <strong>My team</strong> chat to plan.
      ${S.me.role === 'agent' ? '<br><strong>You are the Double Agent.</strong> Point the finger elsewhere!' : ''}</p>
      ${suspectButtons(mates)}${progress('voted')}</div>`;
  }

  // ------------------------------------------------------------ game over
  function gameover() {
    const g = G();
    const c = cur();
    const iWon = g.winners.includes(S.me.id);
    const titles = outcomeTitles(g);
    const good = g.winner === 'tie' || iWon;

    let reveal = '';
    if (g.mode === 'crew' && g.moleId) {
      reveal = `<p>The Mole was <strong>${nm(g.moleId)}</strong>.</p>`;
      if (c && c.kind === 'accuse' && c.tally) {
        reveal += `<p class="muted small">Final accusation: ${Object.entries(c.tally).map(([k, n]) => `${nm(k)} (${n})`).join(', ') || 'no votes'}</p>`;
      }
    }
    if (g.mode === 'rivals' && g.agents) {
      reveal = `<p>Double Agents: <strong>${nm(g.agents.A)}</strong> in ${teamChip('A')} and <strong>${nm(g.agents.B)}</strong> in ${teamChip('B')}.</p>`;
      if (c && c.result) {
        reveal += ['A', 'B'].map((t) => `<p class="muted small">${teamName(t)} ${c.result[t].found ? 'unmasked their agent (+300)' : 'missed their agent'}.</p>`).join('');
      }
    }

    // Ranked by the room's running total; "This game" shows how each player did in this heist.
    const rows = S.players
      .slice()
      .sort((a, b) => b.bank - a.bank || g.scores[b.id] - g.scores[a.id])
      .map((p) => {
        let role = '';
        if (g.mode === 'crew') role = p.id === g.moleId ? '<span class="tag red">Mole</span>' : '<span class="tag">Crew</span>';
        else role = `<span class="tag ${p.team}">${p.team === 'A' ? 'Crimson' : 'Cobalt'}</span>${g.agents && (g.agents.A === p.id || g.agents.B === p.id) ? ' <span class="tag red">Double Agent</span>' : ''}`;
        return `<tr><td>${esc(p.name)}${p.id === S.me.id ? ' <span class="muted">(you)</span>' : ''}</td><td>${role}</td>
          <td class="num">${money(g.scores[p.id], true)}</td><td class="num total">${money(p.bank)}</td></tr>`;
      })
      .join('');

    return `<div class="banner ${good ? 'good' : 'bad'}"><div><div class="big">${esc(titles[0])}</div><div>${esc(titles[1])}</div>
      <div class="small" style="margin-top:6px">${g.winner === 'tie' ? 'Nobody loses tonight.' : iWon ? 'You won!' : 'You lost this one.'}</div></div></div>
      <div class="card">${reveal}<p class="eyebrow">The take${g.mode === 'crew' ? ' · each winner got a $250 heist bonus' : ''}</p>
      <table class="scores"><tr><th>Player</th><th></th><th class="num">This game</th><th class="num">Room total</th></tr>${rows}</table></div>
      <div class="card row">${againButtons()}<button class="btn" data-leave>Leave room</button></div>`;
  }

  // Only the branch for the actual outcome is built: crew games have no team scores.
  function outcomeTitles(g) {
    switch (g.winner) {
      case 'crew': return ['The crew got away clean!', 'The vault is cracked and the loot is split.'];
      case 'mole': return ['The Mole wins!', g.locks >= 3 ? 'The crew opened the vault, but the Mole slipped away with the loot.' : 'The Vault raised enough alarms. The heist is blown.'];
      case 'vault': return ['The Vault wins', 'Too many alarms. The crew is going to prison.'];
      case 'A': return [`${S.teamNames.A} wins!`, `${g.teamScore.A} to ${g.teamScore.B}`];
      case 'B': return [`${S.teamNames.B} wins!`, `${g.teamScore.B} to ${g.teamScore.A}`];
      default: return ["It's a tie!", `${g.teamScore.A} all`];
    }
  }

  function againButtons() {
    return isHost()
      ? `<button class="btn gold big" data-again="restart">Play again</button>
         <button class="btn" data-again="lobby" title="Change mode, question pack or teams first">Back to lobby</button>`
      : `<span class="muted">Waiting for ${nm(S.hostId)} to start the next heist…</span>`;
  }

  // ------------------------------------------------------------ finale popup
  // Shown once per game when it ends: robber with the cash (and confetti) for the winners,
  // robber behind bars for the losers.
  let finaleShown = null;
  function renderFinale() {
    const el = $('#finale');
    const g = G();
    if (S.phase !== 'gameover' || !g) {
      el.hidden = true;
      stopConfetti();
      return;
    }
    const id = `${S.code}#${g.no}`;
    if (finaleShown === id) {
      // Keep the host's buttons in sync (e.g. host changed) while it stays open.
      const slot = el.querySelector('.finale-actions');
      if (slot && !el.hidden) slot.innerHTML = againButtons();
      return;
    }
    finaleShown = id;
    const [title, line] = outcomeTitles(g);
    const won = g.winner === 'tie' || g.winners.includes(S.me.id);
    const you = g.winner === 'tie' ? 'Nobody loses tonight.' : won ? 'You won!' : 'You lost this one.';
    el.innerHTML = `<div class="finale-card ${won ? 'won' : 'lost'}" role="dialog" aria-modal="true" aria-labelledby="finale-title">
        <div class="finale-art">${won ? robberArt(true) : robberArt(false)}</div>
        <h2 id="finale-title">${esc(title)}</h2>
        <p>${esc(line)}</p>
        <p class="finale-you">${you}</p>
        <p class="finale-money">This game ${money(g.scores[S.me.id], true)} · Room total ${money(P(S.me.id).bank)}</p>
        <div class="finale-actions">${againButtons()}</div>
        <button class="btn finale-close" data-close>See the scores</button>
      </div>`;
    el.hidden = false;
    if (won) startConfetti();
  }
  $('#finale').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && 'again' in b.dataset) return send('again', { restart: b.dataset.again === 'restart' });
    if ((b && 'close' in b.dataset) || e.target.id === 'finale') {
      $('#finale').hidden = true;
      stopConfetti();
    }
  });

  function robberArt(rich) {
    const ink = '#1b1e25';
    const stripes = Array.from({ length: 5 }, (_, i) => `<rect x="84" y="${128 + i * 14}" width="72" height="7" fill="${ink}"/>`).join('');
    const body = `
      <rect x="84" y="122" width="72" height="72" rx="14" fill="#eef0f4"/>${stripes}
      <circle cx="120" cy="90" r="30" fill="#f2c39b"/>
      <path d="M89 86 Q89 54 120 54 Q151 54 151 86 Z" fill="${ink}"/>
      <rect x="87" y="80" width="66" height="8" rx="4" fill="#2c313c"/>
      <circle cx="120" cy="52" r="7" fill="#2c313c"/>
      <rect x="92" y="88" width="56" height="15" rx="7.5" fill="${ink}"/>
      <ellipse cx="108" cy="95.5" rx="6" ry="4.2" fill="#fff"/><ellipse cx="132" cy="95.5" rx="6" ry="4.2" fill="#fff"/>
      <circle cx="${rich ? 110 : 107}" cy="${rich ? 95 : 97}" r="2.3" fill="${ink}"/><circle cx="${rich ? 134 : 131}" cy="${rich ? 95 : 97}" r="2.3" fill="${ink}"/>`;
    if (rich) {
      const bill = (x, y, r) => `<g transform="translate(${x} ${y}) rotate(${r})"><rect x="-15" y="-8" width="30" height="16" rx="2" fill="#4fbf72" stroke="#2b7a47" stroke-width="1.5"/><circle r="5" fill="#8fe0a9"/><text y="3.5" text-anchor="middle" font-size="9" font-weight="700" fill="#2b7a47">$</text></g>`;
      return `<svg viewBox="0 0 240 200" aria-label="A grinning masked robber hoisting a sack of cash">
        ${bill(34, 40, -20)}${bill(206, 34, 18)}${bill(30, 120, 12)}${bill(212, 132, -14)}${bill(64, 16, 8)}
        <path d="M154 134 L186 96" stroke="#f2c39b" stroke-width="11" stroke-linecap="round"/>
        <path d="M86 134 L56 108" stroke="#f2c39b" stroke-width="11" stroke-linecap="round"/>
        <path d="M168 62 Q160 90 170 104 Q194 116 214 100 Q222 84 206 62 Z" fill="#c9a35a" stroke="#8f6f2e" stroke-width="2.5"/>
        <path d="M172 62 Q187 52 204 62" stroke="#8f6f2e" stroke-width="5" fill="none" stroke-linecap="round"/>
        <text x="191" y="94" text-anchor="middle" font-size="26" font-weight="800" fill="#6e5220">$</text>
        <g transform="translate(46 100) rotate(-25)"><rect x="-16" y="-9" width="32" height="18" rx="2" fill="#4fbf72" stroke="#2b7a47" stroke-width="1.5"/><rect x="-12" y="-13" width="32" height="18" rx="2" fill="#5fd383" stroke="#2b7a47" stroke-width="1.5"/></g>
        ${body}
        <path d="M108 108 Q120 120 132 108" stroke="${ink}" stroke-width="3" fill="none" stroke-linecap="round"/>
      </svg>`;
    }
    // A wider gap in the middle keeps the robber's face visible between the bars.
    const bars = [40, 64, 88, 145, 169, 193].map((x) => `<rect x="${x}" y="22" width="7" height="176" rx="3" fill="url(#steel)"/>`).join('');
    return `<svg viewBox="0 0 240 200" aria-label="A glum masked robber in a striped suit behind prison bars">
      <defs><linearGradient id="steel" x1="0" x2="1"><stop offset="0" stop-color="#7d8696"/><stop offset=".5" stop-color="#d7dce4"/><stop offset="1" stop-color="#6c7484"/></linearGradient></defs>
      <rect x="30" y="16" width="180" height="184" rx="6" fill="#262b35"/>
      <rect x="36" y="22" width="168" height="178" fill="#1f232c"/>
      ${body}
      <path d="M108 113 Q120 104 132 113" stroke="${ink}" stroke-width="3" fill="none" stroke-linecap="round"/>
      <path d="M152 70 q-4 8 0 11 q4 -3 0 -11" fill="#7cc4ff"/>
      ${bars}
      <rect x="30" y="16" width="180" height="10" rx="3" fill="url(#steel)"/>
      <rect x="30" y="160" width="180" height="8" rx="3" fill="url(#steel)"/>
      <circle cx="91.5" cy="140" r="8.5" fill="#f2c39b"/><circle cx="148.5" cy="140" r="8.5" fill="#f2c39b"/>
      <rect x="88" y="136" width="7" height="3" fill="url(#steel)"/><rect x="145" y="136" width="7" height="3" fill="url(#steel)"/>
    </svg>`;
  }

  let confettiRaf = null;
  function startConfetti() {
    const canvas = $('#confetti');
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = (canvas.width = innerWidth * dpr);
    const H = (canvas.height = innerHeight * dpr);
    const colors = ['#d9ad55', '#f1cd7d', '#3ecf8e', '#5b8cff', '#ef5a5f', '#ffffff'];
    const bits = Array.from({ length: 180 }, () => ({
      x: Math.random() * W, y: -Math.random() * H * 0.6, w: (6 + Math.random() * 6) * dpr, h: (8 + Math.random() * 8) * dpr,
      vx: (Math.random() - 0.5) * 2.4 * dpr, vy: (2 + Math.random() * 3) * dpr, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.25,
      c: colors[Math.floor(Math.random() * colors.length)],
    }));
    const until = Date.now() + 5000;
    stopConfetti();
    canvas.hidden = false;
    const frame = () => {
      ctx.clearRect(0, 0, W, H);
      let alive = false;
      for (const b of bits) {
        b.x += b.vx; b.y += b.vy; b.rot += b.vr; b.vy += 0.03 * dpr;
        if (b.y > H && Date.now() < until) { b.y = -20; b.vy = (2 + Math.random() * 3) * dpr; }
        if (b.y <= H) alive = true;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.rot); ctx.fillStyle = b.c; ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); ctx.restore();
      }
      confettiRaf = alive ? requestAnimationFrame(frame) : (stopConfetti(), null);
    };
    confettiRaf = requestAnimationFrame(frame);
  }
  function stopConfetti() {
    if (confettiRaf) cancelAnimationFrame(confettiRaf);
    confettiRaf = null;
    $('#confetti').hidden = true;
  }

  // ------------------------------------------------------------ timer
  function tick() {
    const wrap = $('#timer');
    if (!S || deadline == null || !S.phaseSecs) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    const left = Math.max(0, deadline - Date.now());
    $('#timer-bar').style.width = `${(left / (S.phaseSecs * 1000)) * 100}%`;
    $('#timer-text').textContent = Math.ceil(left / 1000);
    wrap.classList.toggle('low', left < 5500);
  }
  setInterval(tick, 250);

  // ------------------------------------------------------------ input
  $('#stage').addEventListener('click', (e) => {
    const b = e.target.closest('button, input[type=checkbox]');
    if (!b || b.disabled) return;
    const d = b.dataset;
    if (d.set) send('settings', { [d.set]: d.v });
    else if ('agents' in d) send('settings', { doubleAgents: b.checked });
    else if (d.team) send('team', { team: d.team });
    else if ('shuffle' in d) send('shuffle');
    else if ('start' in d) send('start');
    else if ('copy' in d) copyInvite();
    else if ('ready' in d) act({ type: 'ready' });
    else if (d.answer) act({ type: 'answer', choice: Number(d.answer) });
    else if (d.pick) { pendingPick = Number(d.pick); lastStage = ''; renderStage(); }
    else if ('lock' in d) act({ type: 'pick', choice: pendingPick });
    else if (d.vote) act({ type: 'vote', option: d.vote });
    else if ('pitchDone' in d) act({ type: 'pitchDone' });
    else if (d.call) act({ type: 'call', value: d.call });
    else if (d.suspect) act({ type: 'suspect', target: d.suspect });
    else if ('again' in d) send('again', { restart: d.again === 'restart' });
    else if ('leave' in d) leave();
  });

  $('#stage').addEventListener('submit', (e) => {
    if (!e.target.matches('[data-fake-form]')) return;
    e.preventDefault();
    const input = $('#fake');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('act', { type: 'fake', text }, (res) => {
      if (res && res.error) return toast(res.error, true);
      input.value = '';
      toast('Fake submitted. Nice.');
    });
  });

  $('#players').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kick]');
    if (b && confirm('Remove this player from the room?')) send('kick', { id: b.dataset.kick });
  });

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    send('chat', { text, channel });
    input.value = '';
  });
  $('#channels').addEventListener('click', (e) => {
    const b = e.target.closest('.ch');
    if (!b) return;
    channel = b.dataset.ch;
    renderChat();
  });
  $('#chat-toggle').addEventListener('click', () => {
    if (!matchMedia('(max-width: 860px)').matches) return;
    chatOpen = !chatOpen;
    $('#chat-panel').classList.toggle('open', chatOpen);
    if (S) renderChat();
  });

  function inviteLink() {
    return `${location.origin}/?code=${S.code}`;
  }
  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteLink());
      toast('Invite link copied!');
    } catch {
      prompt('Copy this invite link:', inviteLink());
    }
  }
  $('#code-chip').onclick = () => S && copyInvite();

  function leave() {
    const midGame = S && S.phase !== 'lobby' && S.phase !== 'gameover';
    if (midGame && !confirm('Leave the game? You can rejoin from this device with the same code.')) return;
    socket.emit('leave', {}, () => {});
    store.del('ij-room');
    history.replaceState(null, '', '/');
    showHome();
  }
  $('#leave-btn').onclick = leave;

  if (!store.get('ij-room')) showHome();
})();
