# Inside Job — Game Design (approved)

A real-time bank-vault heist party game for 2–8 players. Everyone plays remotely in a web
browser on their own device and joins with a 4-letter room code or an invite link.
Trivia cracks the locks, bluffing hides the truth, and a hidden Mole may be sabotaging the
crew from the inside.

Decisions from review:
- Theme and name: **Inside Job**, a bank-vault heist.
- Content: the family-friendly **Standard** pack is the default. The bonus **After Hours (18+)**
  pack and a **Mixed** option can be chosen in the lobby.
- Remote play: there's no shared TV. Every player has their own screen, and a built-in chat
  replaces table talk (team chat in Rival Crews).
- Hosting: a web app at a public URL that friends can open without an account.

The player-facing rules live in `public/rules.html` (served at `/rules`) and are linked from
every screen. Each phase screen also says what to do right now.

---

## Modes

| Mode | Players | Who vs. who |
|---|---|---|
| **Crew vs. The Vault** | 2–8 | Everyone vs. the computer. With 4+ players, one secret **Mole** works for the Vault. |
| **Rival Crews** | 4–8 | Two teams (Crimson vs. Cobalt) compete. With 6+ players, optional secret **Double Agents** (one per team). |

Target length: 10–15 minutes per game. Phases end early once everyone has acted.

---

## Mode 1 — Crew vs. The Vault (co-op + hidden traitor)

### Goal
The Vault has **5 locks**. Crack **3 locks** before the Vault raises **3 alarms**.
Each round is one lock attempt: success = lock cracked, failure = alarm raised.
With 2–3 players there's no Mole, and the Vault wins on **2 alarms**.

### The Mole (4+ players)
- One player is secretly the Mole. The Mole wins if the crew fails **or** the Mole survives
  the Final Accusation.
- **Insider tip:** each round the Mole has a 50% chance of being shown the correct answer.

### Round order
Trivia → Bluff → Trivia → Interrogation (Mole games only) → Bluff → Trivia.
The game ends as soon as the crew has 3 locks or the Vault has enough alarms.

### Trivia lock — "Crack the Code" (20 s answer + 30 s discussion)
1. Everyone privately picks 1 of 4 answers.
2. The tally is shown (counts only) and the crew discusses in chat.
3. The **Safecracker** (rotates each round) locks in the crew's answer. If time runs out,
   the most popular answer is used.
4. Correct → lock cracked. Wrong → alarm. Everyone's answers are then revealed by name.

### Bluff lock — "Smoke & Mirrors" (45 s write + 30 s vote)
1. A true but obscure fact with a blank is shown.
2. Everyone writes a fake answer. A fake that matches the real answer is rejected.
3. The ballot shows the truth, every fake, and Vault decoys (2 with ≤4 players, otherwise 1).
4. Everyone votes for the truth (not their own fake).
5. More than half the crew finds the truth → lock cracked, otherwise → alarm.
   All authors and votes are revealed.

### Interrogation (once, after round 3, Mole games only, 60 s)
Everyone votes for a player to lock "in the van", or votes to pass. The top choice wins, and a tie means pass.
- **Caught the Mole:** the Mole is exposed and benched. They can't answer, vote or
  be Safecracker any more, and the Final Accusation is skipped.
- **Wrong person:** +1 alarm. **Pass:** nothing happens.

### Final Accusation (60 s)
If the crew cracks 3 locks with the Mole still hidden, everyone votes. The Mole must get
strictly the most votes, or the Mole escapes with the loot and wins.

### Personal "cut" (MVP leaderboard, shown at the end)
| Action | Points |
|---|---|
| Correct private trivia answer | +100 |
| Found the truth in a bluff round | +100 |
| Each player fooled by your fake | +50 |
| Mole: each alarm raised | +150 |
| Voted for the Mole (Interrogation or Final Accusation) | +200 |

Only the winning side's cuts count. The other side's cuts are greyed out.

---

## Mode 2 — Rival Crews (team vs. team)

Players pick teams in the lobby, and the host can shuffle. Each team needs at least 2 players. 6 rounds:
Trivia Race → Smoke & Mirrors → Poker Face (Crimson bluffs) → Trivia Race →
Smoke & Mirrors → Poker Face (Cobalt bluffs) → Double Agent guess (if enabled).
Points earned by individual players are scaled by (largest team size ÷ own team size), so
smaller teams aren't disadvantaged. Highest team score wins.

- **Trivia Race (20 s):** same question for everyone. Answers lock on first tap. Each
  correct player gets +100 for their team, and the fastest correct player in the room gets +50.
- **Smoke & Mirrors (45 s + 30 s):** everyone writes a fake. Your ballot shows the truth,
  the *other* team's fakes and one Vault decoy. You get +100 per teammate who finds the truth and
  +50 per opponent fooled by your fake.
- **Poker Face (45 s pitch + 20 s vote):** one player is privately told whether a
  statement is TRUE or FALSE, and must convince the other team it's TRUE in chat. The other
  team votes Believe or Busted, and the majority is the call (a tie favours the bluffer).
  A correct call gives the calling team +200. Otherwise the bluffer's team gets +200.
- **Double Agents (optional, 6+ players with 3+ per team):** one player per team secretly
  wins if the *rival* team wins. At the end each team votes on its Double Agent, and a correct guess
  gives +300.

---

## Lobby & flow
- The first player creates a room and becomes host. Host powers pass on automatically if the host leaves.
- Others join with the code or the invite link (`/?code=ABCD`) and a nickname.
- The host picks mode, content pack and options, then starts. A 15 s briefing shows each player
  their secret role.
- Refreshing or reconnecting keeps your seat (a browser token stored on the device).
- New players can't join mid-game. After the game the host can start another round with the
  same group.

## Tech
- Node.js + Socket.IO. The server owns all game state, timers and secret info, and each player
  is only sent what they're allowed to see.
- Vanilla HTML/CSS/JS client with no build step, mobile-first.
- Content packs live in `content/*.json`. Questions aren't repeated within a room until the
  pack runs out.
