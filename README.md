# Wavelength (customizable)

A local-network, real-time multiplayer party game inspired by **Wavelength**, with
one twist: **players author their own spectrums before the round** instead of
drawing from prewritten packs. The host runs a server on their computer; everyone
(including the host) plays from a phone browser. Mobile-first / portrait iPhone.

## How it plays

1. **Lobby** — players join with a name and the 4-letter room code (≥2 players,
   3+ recommended).
2. **Write spectrums** — each player privately writes 3 spectrums (e.g.
   `Cold ↔ Hot`). Nobody sees a target while writing — that's the fairness rule.
3. **Write clues (all at once)** — the server pools everyone's spectrums and
   assigns each player a set to clue (never their own), each with a hidden target.
   On one page, every player writes *all* of their clues up front — they see each
   target and write a clue to land the others on it.
4. **Rounds** — the game rotates through the pre-written clues, alternating which
   player's clue is in play. Each round shows the spectrum + that pre-written clue;
   everyone else drags the dial to guess. On reveal, scores update. Because the
   clues already exist, rounds fly by — nobody waits on a clue-giver mid-round.
5. **Final leaderboard** when every clue has been played (or the host ends it).

> Why clues up front? So players aren't sitting idle while a clue-giver thinks.
> Everyone does their writing during the two authoring phases, then the guessing
> rounds just alternate quickly. The fairness rule still holds: spectrum authors
> never see a target, and the clue-giver (who does) is never the author.

### Scoring

- Dial is a 180° semicircle mapped to `0–100`. Target center `T ∈ [12, 88]`.
- Distance `d = |guess − T|`: `d ≤ 4 → 4` · `d ≤ 8 → 3` · `d ≤ 12 → 2` · else `0`.
- The clue-giver scores the **average** of their guessers' points (good clues win).

All of these are tunable at the top of `server.py`.

## Run it

```bash
pip install -r requirements.txt
python server.py            # listens on 0.0.0.0:8000 (set PORT to change)
```

Then open the app:

- **Host:** `http://localhost:8000` → "Create a room" → share the 4-letter code.
- **Players (same WiFi):** open `http://<HOST-LAN-IP>:8000` on their phones and
  join with the code. Find the host's LAN IP with:
  - macOS/Linux: `ifconfig` or `ip addr`
  - Windows: `ipconfig`

  No port forwarding needed — you're all on the same network.

- **Remote players (optional):** expose the port with a tunnel instead of
  port-forwarding, e.g. `ngrok http 8000` or a Cloudflare Tunnel, and share the
  tunnel URL. (The client auto-uses `wss://` over HTTPS tunnels.)

## Tech

- **Backend:** Python + FastAPI + WebSockets. One server, one port. Authoritative,
  in-memory game state (a dict keyed by room code — no database).
- **Frontend:** a single served vanilla HTML/CSS/JS client. The dial is an SVG
  semicircle, draggable via Pointer Events (touch + mouse).

### Anti-cheat

The target is never sent to guessers before the reveal — it lives server-side and,
during the clueing phase, only the assigned clue-giver's socket receives the
targets for their own assignments. The server is authoritative for the current
phase, whose turn it is, who has guessed, and all scoring. Disconnect /
rejoin-by-name is handled: a clue-giver dropping no longer abandons a round (the
clue is already written), and if someone drops during an authoring phase the game
proceeds without blocking — any spectrums left unclued are simply skipped.

## Files

```
server.py            FastAPI server + WebSocket game logic (authoritative state)
static/index.html    Single-page client markup
static/style.css     Mobile-first styles
static/dial.js       Reusable SVG dial component (draggable, scoring bands)
static/app.js        Client state machine / screen routing
requirements.txt     Python dependencies
```
