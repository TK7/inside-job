# Inside Job

A real-time bank-vault heist party game for 2–8 players. Each player uses their own device
and joins with a 4-letter room code.

- **Crew vs. The Vault**: co-op against the computer. With 4+ players, a hidden **Mole** works
  for the Vault.
- **Rival Crews**: two teams compete in trivia races, bluffing and Poker Face, with optional
  secret Double Agents.

Player rules are at **`/rules`** (`public/rules.html`), linked from every screen.
Design notes are in [GAME_DESIGN.md](GAME_DESIGN.md).

## Run it

Requires Node.js 18+.

```bash
npm install
npm start          # http://localhost:3000 (people on your Wi-Fi can use http://<your-PC-IP>:3000)
```

## Put it online for friends

### Option A: from your PC, right now (free, no account)

```bash
npm run live
```

This starts the game and opens a public HTTPS tunnel through [localhost.run](https://localhost.run)
using the OpenSSH client built into Windows. It prints a link like `https://abc123.lhr.life`.
Send that link to your friends. Keep the window open while you play. The free link changes
whenever the tunnel reconnects, and the game is only up while your PC is running it.

### Option B: permanent link (free Render account)

1. Push this folder to a GitHub repository.
2. In [Render](https://render.com), choose **New → Blueprint** and pick the repo. `render.yaml`
   sets everything up.
3. You get a permanent URL like `https://inside-job.onrender.com`. On the free plan, the first
   visit after the app has been idle takes about a minute to wake it up.

Any Node host that supports WebSockets works (Railway, Fly.io, a VPS). Run `npm start` and set
`PORT` if needed.

## Tests

```bash
npm test
```

- `test/paths.js` drives the rules engine directly through every ending: crew win by
  accusation, Mole escape on a tie, Interrogation catch and miss, the bluff majority rule,
  the Poker Face tie rule and team-size scaling.
- `test/simulate.js` starts the real server and plays 13 complete games with bot players over
  Socket.IO (2–8 players, both modes, all packs, an idle player, a mid-game reconnect). It checks
  that no player ever receives secret info (answers, roles, other teams' chat).

## Project layout

```
server.js            HTTP + Socket.IO server, room codes, per-player state pushes
src/room.js          lobby, chat and the full rules engine for both modes
src/content.js       question-pack loader (no repeats within a room)
content/standard.json  default family-friendly pack
content/adult.json     "After Hours" 18+ bonus pack
public/              web client (index.html, app.js, style.css, rules.html)
scripts/go-live.js   server + public tunnel in one command
```

### Adding questions

Edit `content/*.json`. Trivia options list the **correct answer first** (they're shuffled
in-game). Bluff items need the true answer `a`, optional accepted variants `alts`, and three
Vault decoys `d`. Poker statements are `{ "s": "...", "t": true | false }`.
