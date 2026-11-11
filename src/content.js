'use strict';
// Loads the question packs and hands out items without repeating them inside a room.
//
// Pack format (content/<pack>.json):
//   trivia: { c: category, q: question, o: [correct, wrong, wrong, wrong] }
//   bluff:  { q: "fact with a ____ blank", a: answer, alts?: [accepted variants], d: [3 Vault decoys] }
//   poker:  { s: statement, t: true|false }

// Static requires (no fs) so the packs bundle into the Cloudflare Worker as well as run in Node.
const SOURCES = {
  standard: require('../content/standard.json'),
  adult: require('../content/adult.json'),
};

const PACKS = ['standard', 'adult'];
const KINDS = ['trivia', 'bluff', 'poker'];

const packs = {};
for (const name of PACKS) {
  const data = SOURCES[name];
  packs[name] = {};
  for (const kind of KINDS) {
    packs[name][kind] = (data[kind] || []).map((item, i) => ({ ...item, id: `${name}:${kind}:${i}` }));
  }
}

function pool(pack, kind) {
  if (pack === 'mixed') return [...packs.standard[kind], ...packs.adult[kind]];
  return (packs[pack] || packs.standard)[kind];
}

function pick(pack, kind, used) {
  const all = pool(pack, kind);
  let fresh = all.filter((x) => !used.has(x.id));
  if (!fresh.length) {
    all.forEach((x) => used.delete(x.id));
    fresh = all;
  }
  const item = fresh[Math.floor(Math.random() * fresh.length)];
  used.add(item.id);
  return item;
}

function counts() {
  return Object.fromEntries(PACKS.map((p) => [p, Object.fromEntries(KINDS.map((k) => [k, packs[p][k].length]))]));
}

module.exports = { pick, counts };
