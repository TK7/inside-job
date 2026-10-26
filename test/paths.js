'use strict';
// Drives the rules engine directly to cover endings random bots rarely reach:
// crew wins via Final Accusation, Mole caught in Interrogation, Mole escapes on a tie,
// bluff majority rule, and Poker Face tie-goes-to-bluffer.

process.env.IJ_TIME_SCALE = '1000'; // timers never fire during these tests
const assert = require('assert');
const { Room } = require('../src/room');

function setup(n, mode = 'crew') {
  const room = new Room('TEST', () => {});
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(room.join(`P${i}`, `token-${i}-xxxx`).player.id);
  room.updateSettings(ids[0], { mode });
  if (mode === 'rivals') ids.forEach((id, i) => room.setTeam(id, i % 2 ? 'B' : 'A'));
  assert.deepStrictEqual(room.start(ids[0]), {});
  ids.forEach((id) => room.act(id, { type: 'ready' }));
  return { room, ids, g: room.g };
}
const nonMole = (t) => t.ids.filter((id) => id !== t.g.moleId);

// Everyone answers correctly; the safecracker locks in the right answer.
function winTrivia(t, chooser = () => t.g.cur.answer) {
  const { room, ids } = t;
  assert.strictEqual(room.phase, 'trivia-answer');
  ids.forEach((id) => room.act(id, { type: 'answer', choice: chooser(id) }));
  assert.strictEqual(room.phase, 'trivia-discuss');
  room.act(t.g.cur.safecracker, { type: 'pick', choice: t.g.cur.answer });
  assert.strictEqual(room.phase, 'trivia-reveal');
  room.timeout();
}
// Fakes from everyone, then `finders` vote for the truth and the rest vote for a fake.
function playBluff(t, finders) {
  const { room, ids } = t;
  assert.strictEqual(room.phase, 'bluff-write');
  ids.forEach((id, i) => room.act(id, { type: 'fake', text: `totally fake ${i}` }));
  assert.strictEqual(room.phase, 'bluff-vote');
  const ballot = room.ballotFor(ids[0]);
  const truth = ballot.find((o) => o.kind === 'truth');
  ids.forEach((id) => {
    const choice = finders.includes(id) ? truth : ballot.find((o) => o.kind !== 'truth' && !o.authors.includes(id));
    room.act(id, { type: 'vote', option: choice.id });
  });
  assert.strictEqual(room.phase, 'bluff-reveal');
  const cracked = t.g.cur.cracked;
  room.timeout();
  return cracked;
}

// 1. Crew cracks 3 locks, then catches the Mole in the Final Accusation.
{
  const t = setup(5);
  const { room } = t;
  winTrivia(t);
  assert(playBluff(t, t.ids), 'unanimous truth should crack');
  winTrivia(t);
  assert.strictEqual(t.g.locks, 3);
  assert.strictEqual(room.phase, 'accuse', 'Final Accusation follows 3 locks');
  t.ids.forEach((id) => room.act(id, { type: 'suspect', target: id === t.g.moleId ? nonMole(t)[0] : t.g.moleId }));
  assert.strictEqual(room.phase, 'gameover');
  assert.strictEqual(t.g.winner, 'crew');
  assert(!t.g.winners.includes(t.g.moleId));
  // Crew: 2 trivia (+100 each) + truth (+100) + Mole vote (+200) + heist bonus (+250).
  // Mole: same answers (+300), its own vote is never charged, and no bonus for losing.
  room.players.forEach((p) => assert.strictEqual(p.bank, p.id === t.g.moleId ? 300 : 750, `money for ${p.name}`));
  console.log('  ok  crew wins by naming the Mole (+ exact money for crew and Mole)');
}

// 2. Mole escapes when the accusation ties.
{
  const t = setup(4);
  const { room } = t;
  winTrivia(t);
  playBluff(t, t.ids);
  winTrivia(t);
  const [a, b] = nonMole(t);
  // Votes: two for the mole, two for an innocent → tie → Mole escapes.
  const plan = { [a]: t.g.moleId, [b]: t.g.moleId, [t.g.moleId]: a };
  const lastInnocent = nonMole(t)[2];
  plan[lastInnocent] = a;
  t.ids.forEach((id) => room.act(id, { type: 'suspect', target: plan[id] }));
  assert.strictEqual(t.g.winner, 'mole');
  console.log('  ok  tie in the Final Accusation lets the Mole escape');
}

// 3. Bluff needs MORE than half: 2 of 4 finding the truth is an alarm.
{
  const t = setup(4);
  winTrivia(t);
  assert.strictEqual(playBluff(t, t.ids.slice(0, 2)), false);
  assert.strictEqual(t.g.alarms, 1);
  console.log('  ok  bluff lock fails at exactly half');
}

// 4. Interrogation catches the Mole, who is then benched; crew wins with no accusation.
{
  const t = setup(5);
  const { room } = t;
  winTrivia(t);
  playBluff(t, t.ids.slice(0, 2)); // alarm
  winTrivia(t);
  assert.strictEqual(room.phase, 'interrogate');
  t.ids.forEach((id) => room.act(id, { type: 'suspect', target: id === t.g.moleId ? 'pass' : t.g.moleId }));
  assert.strictEqual(room.phase, 'interrogate-reveal');
  assert.strictEqual(t.g.exposed, true);
  room.timeout();
  // Benched mole can't act, and the remaining 4 completing the phase advances it.
  assert.strictEqual(room.phase, 'bluff-write');
  room.act(t.g.moleId, { type: 'fake', text: 'sneaky' });
  assert.strictEqual(t.g.cur.fakes[t.g.moleId], undefined, 'benched mole cannot submit');
  nonMole(t).forEach((id, i) => room.act(id, { type: 'fake', text: `fake ${i}` }));
  assert.strictEqual(room.phase, 'bluff-vote');
  const ballot = room.ballotFor(t.ids[0]);
  const truth = ballot.find((o) => o.kind === 'truth');
  nonMole(t).forEach((id) => room.act(id, { type: 'vote', option: truth.id }));
  assert.strictEqual(room.phase, 'bluff-reveal');
  room.timeout();
  assert.strictEqual(room.phase, 'gameover');
  assert.strictEqual(t.g.winner, 'crew');
  assert(t.g.scores === undefined); // scores live on players, not g
  console.log('  ok  Interrogation benches the Mole; crew wins without an accusation');
}

// 5. Interrogating an innocent raises an alarm.
{
  const t = setup(4);
  const { room } = t;
  winTrivia(t);
  playBluff(t, t.ids);
  // Wrong trivia so we don't reach 3 locks before the interrogation.
  room.phase === 'trivia-answer' && t.ids.forEach((id) => room.act(id, { type: 'answer', choice: 0 }));
  room.act(t.g.cur.safecracker, { type: 'pick', choice: (t.g.cur.answer + 1) % 4 });
  room.timeout();
  assert.strictEqual(room.phase, 'interrogate');
  const innocent = nonMole(t)[0];
  t.ids.forEach((id) => room.act(id, { type: 'suspect', target: id === innocent ? nonMole(t)[1] : innocent }));
  assert.strictEqual(t.g.cur.outcome, 'innocent');
  assert.strictEqual(t.g.alarms, 2);
  console.log('  ok  wrong Interrogation raises an alarm');
}

// 6. Rivals: Poker Face tie goes to the bluffer; fake answers matching the truth are rejected.
{
  const t = setup(4, 'rivals');
  const { room, ids } = t;
  ids.forEach((id) => room.act(id, { type: 'answer', choice: 0 }));
  room.timeout(); // trivia reveal -> bluff
  const err = room.act(ids[0], { type: 'fake', text: `The ${t.g.cur.truth.toUpperCase()}!` });
  assert(err.error && /Too close/.test(err.error), 'truth-matching fake is rejected');
  room.timeout(); // bluff-write -> vote
  room.timeout(); // vote -> reveal
  room.timeout(); // reveal -> poker
  assert.strictEqual(room.phase, 'poker-pitch');
  const c = t.g.cur;
  room.act(c.bluffer, { type: 'pitchDone' });
  assert.strictEqual(room.phase, 'poker-vote');
  const callers = ids.filter((id) => room.player(id).team !== c.bluffTeam);
  room.act(callers[0], { type: 'call', value: 'believe' });
  room.act(callers[1], { type: 'call', value: 'busted' });
  assert.strictEqual(room.phase, 'poker-reveal');
  assert.strictEqual(c.call, 'split');
  assert.strictEqual(c.correct, false);
  assert.strictEqual(c.gain[c.bluffTeam], 200);
  console.log('  ok  Poker Face tie goes to the bluffer; truth-matching fakes rejected');
}

// 7. Uneven teams are scaled.
{
  const t = setup(5, 'rivals');
  const small = t.g.scale.A > 1 ? 'A' : 'B';
  assert.strictEqual(t.g.scale[small], 1.5);
  console.log('  ok  2 vs 3 teams scale the smaller team by 1.5');
}

// 8. Vault wins on 2 alarms; Play again deals the same crew into a new heist, Back to lobby doesn't.
{
  const t = setup(3);
  const { room, ids } = t;
  const wrong = () => (t.g.cur.answer + 1) % 4;
  ids.forEach((id) => room.act(id, { type: 'answer', choice: wrong() }));
  room.act(t.g.cur.safecracker, { type: 'pick', choice: wrong() });
  room.timeout(); // trivia reveal -> bluff
  assert(!playBluff(t, []), 'nobody finds the truth');
  assert.strictEqual(t.g.alarms, 2);
  assert.strictEqual(room.phase, 'gameover');
  assert.strictEqual(room.g.winner, 'vault');
  const firstNo = room.view(ids[0]).game.no;
  assert.deepStrictEqual(room.playAgain(ids[1], true), {}, 'non-host is ignored');
  assert.strictEqual(room.phase, 'gameover');
  assert.deepStrictEqual(room.playAgain(ids[0], true), {});
  assert.strictEqual(room.phase, 'briefing', 'restart goes straight to a new briefing');
  assert.strictEqual(room.view(ids[2]).game.no, firstNo + 1);
  assert.strictEqual(room.players.length, 3);
  assert(room.players.every((p) => p.score === 0), 'scores reset');

  ids.forEach((id) => room.act(id, { type: 'ready' }));
  while (room.phase !== 'gameover') room.timeout();
  room.playAgain(ids[0], false);
  assert.strictEqual(room.phase, 'lobby');
  console.log('  ok  Vault wins on 2 alarms; Play again restarts in the same room; Back to lobby works');
}

// 9. Money is a running total for the room: right answers pay, misses (wrong or blank) cost half,
//    crew winners get a heist bonus, totals can go negative, and a new game keeps the bank.
{
  const t = setup(3);
  const { room, ids } = t;
  winTrivia(t);
  assert(playBluff(t, ids));
  winTrivia(t);
  assert.strictEqual(room.g.winner, 'crew');
  room.players.forEach((p) => {
    assert.strictEqual(p.score, 550, 'three right answers + $250 bonus');
    assert.strictEqual(p.bank, 550);
  });

  room.playAgain(ids[0], true);
  ids.forEach((id) => room.act(id, { type: 'ready' }));
  const g = room.g;
  assert(room.players.every((p) => p.score === 0 && p.bank === 550), 'new game: score resets, bank carries');
  room.act(ids[0], { type: 'answer', choice: g.cur.answer });
  room.act(ids[1], { type: 'answer', choice: (g.cur.answer + 1) % 4 });
  room.timeout(); // ids[2] never answers
  room.act(g.cur.safecracker, { type: 'pick', choice: g.cur.answer });
  const bank = (i) => room.player(ids[i]).bank;
  assert.deepStrictEqual([bank(0), bank(1), bank(2)], [650, 500, 500], 'right +100, wrong -50, blank -50');

  // A player deep in debt shows a negative total.
  room.player(ids[2]).bank = -20;
  room.charge(ids[2], 50);
  assert.strictEqual(room.view(ids[0]).players.find((p) => p.id === ids[2]).bank, -70);
  console.log('  ok  money: running room total, misses cost half, heist bonus, negatives allowed');
}

// 10. Mole votes: an innocent pick or no vote costs $100; a pass in the Interrogation is free.
{
  const t = setup(5);
  const { room, ids } = t;
  winTrivia(t);
  playBluff(t, ids);
  // Fail the next trivia lock so the Interrogation still happens.
  ids.forEach((id) => room.act(id, { type: 'answer', choice: (t.g.cur.answer + 1) % 4 }));
  room.act(t.g.cur.safecracker, { type: 'pick', choice: (t.g.cur.answer + 1) % 4 });
  room.timeout();
  assert.strictEqual(room.phase, 'interrogate');
  const crew = nonMole(t);
  const before = Object.fromEntries(ids.map((id) => [id, room.player(id).bank]));
  room.act(crew[0], { type: 'suspect', target: 'pass' });
  room.act(crew[1], { type: 'suspect', target: crew[2] });
  // crew[2] and crew[3] don't vote; the Mole votes for crew[1].
  room.act(t.g.moleId, { type: 'suspect', target: crew[1] });
  room.timeout();
  const diff = (id) => room.player(id).bank - before[id];
  assert.deepStrictEqual([diff(crew[0]), diff(crew[1]), diff(crew[2]), diff(crew[3])], [0, -100, -100, -100]);
  assert.strictEqual(diff(t.g.moleId), 0, 'the Mole is never charged for votes');
  console.log('  ok  Mole votes: innocent or blank -$100, pass free, Mole exempt');
}

console.log('All rule-path tests passed.');
process.exit(0); // pending phase timers would otherwise keep the process alive
