"""
Wavelength (custom) — local-network real-time multiplayer party game.

One FastAPI server, one port. Authoritative game state lives here, in memory.
Players (including the host) connect from their browsers over WebSockets.

Flow:
    lobby -> author (write spectrums) -> clueing (write ALL your clues at once)
          -> playing (rotate through pre-written clues; others guess) -> ended

Writing clues up front means nobody waits on a clue-giver mid-round — the
guessing rounds just reveal each pre-written clue and rotate quickly.

Run:
    pip install -r requirements.txt
    python server.py            # or: uvicorn server:app --host 0.0.0.0 --port 8000

Then everyone opens http://<HOST-LAN-IP>:8000 on their phones.
"""

from __future__ import annotations

import os
import random
import string
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------------------
# Tunable game constants
# ---------------------------------------------------------------------------
MIN_PLAYERS = 2
SPECTRUMS_PER_PLAYER = 3
TARGET_MIN = 12          # target center kept off the edges so bands fit
TARGET_MAX = 88
# Proximity bands: (max distance inclusive, points)
SCORE_BANDS = [(4, 4), (8, 3), (12, 2)]


def score_for_distance(d: float) -> int:
    for max_d, pts in SCORE_BANDS:
        if d <= max_d:
            return pts
    return 0


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------
@dataclass
class Player:
    name: str
    connected: bool = True
    score: float = 0.0
    spectrums: list[dict] = field(default_factory=list)  # submitted in author phase


@dataclass
class Spectrum:
    id: int
    left: str
    right: str
    author: str                      # who wrote the spectrum
    giver: Optional[str] = None      # who was assigned to clue it (never the author)
    target: Optional[int] = None     # hidden target, generated at assignment time
    clue: Optional[str] = None       # pre-written by the giver in the clueing phase


@dataclass
class Round:
    spectrum: Spectrum
    sub_phase: str = "guess"                        # guess | reveal
    guesses: dict = field(default_factory=dict)    # name -> value (0..100)
    points: dict = field(default_factory=dict)     # name -> points (set at reveal)
    clue_giver_points: float = 0.0

    @property
    def clue_giver(self) -> str:
        return self.spectrum.giver

    @property
    def target(self) -> int:
        return self.spectrum.target

    @property
    def clue(self) -> Optional[str]:
        return self.spectrum.clue


@dataclass
class Room:
    code: str
    host: str
    phase: str = "lobby"          # lobby | author | clueing | playing | ended
    players: dict = field(default_factory=dict)    # name -> Player
    order: list = field(default_factory=list)      # join order (rotation)
    pool: list = field(default_factory=list)       # list[Spectrum]
    givers: list = field(default_factory=list)     # players with clue assignments
    play_order: list = field(default_factory=list)  # spectrum ids, in play sequence
    play_index: int = -1
    current: Optional[Round] = None
    spectrum_seq: int = 0
    connections: dict = field(default_factory=dict)  # name -> WebSocket

    # -- helpers -----------------------------------------------------------
    def connected_players(self) -> list[str]:
        return [n for n in self.order if self.players[n].connected]

    def next_spectrum_id(self) -> int:
        self.spectrum_seq += 1
        return self.spectrum_seq

    def spectrum_by_id(self, sid: int) -> Optional[Spectrum]:
        for s in self.pool:
            if s.id == sid:
                return s
        return None

    def assigned_to(self, name: str) -> list[Spectrum]:
        return [s for s in self.pool if s.giver == name]

    def rounds_remaining(self) -> int:
        """Rounds not yet started (excludes the current one)."""
        return max(0, len(self.play_order) - (self.play_index + 1))


rooms: dict[str, Room] = {}


def generate_code() -> str:
    while True:
        code = "".join(random.choices(string.ascii_uppercase, k=4))
        if code not in rooms:
            return code


# ---------------------------------------------------------------------------
# Phase transitions & assignment (server authoritative)
# ---------------------------------------------------------------------------
def assign_clues(room: Room) -> None:
    """Build the spectrum pool, assign each one a clue-giver who is NOT its
    author (balanced so everyone clues the same number), and pick hidden
    targets. Runs once when the author phase completes."""
    authors = [
        n for n in room.order
        if room.players[n].connected
        and len(room.players[n].spectrums) >= SPECTRUMS_PER_PLAYER
    ]

    pool: list[Spectrum] = []
    for name in authors:
        for sp in room.players[name].spectrums:
            pool.append(
                Spectrum(
                    id=room.next_spectrum_id(),
                    left=sp["left"],
                    right=sp["right"],
                    author=name,
                )
            )
    random.shuffle(pool)

    # Balanced assignment: each giver clues exactly k spectrums, never their own.
    # (|pool| == k * len(authors), so this is always feasible for >= 2 authors.)
    k = SPECTRUMS_PER_PLAYER
    cap = {n: k for n in authors}
    assignment: dict[int, str] = {}

    def backtrack(i: int) -> bool:
        if i == len(pool):
            return True
        s = pool[i]
        # Prefer the least-loaded eligible giver to keep things balanced; this
        # heuristic means we essentially never actually backtrack.
        cands = [n for n in authors if n != s.author and cap[n] > 0]
        random.shuffle(cands)
        cands.sort(key=lambda n: cap[n])
        for g in cands:
            cap[g] -= 1
            assignment[s.id] = g
            if backtrack(i + 1):
                return True
            cap[g] += 1
            del assignment[s.id]
        return False

    backtrack(0)
    for s in pool:
        s.giver = assignment.get(s.id)
        s.target = random.randint(TARGET_MIN, TARGET_MAX)

    room.pool = pool
    room.givers = [n for n in authors if any(s.giver == n for s in pool)]


def check_author_complete(room: Room) -> bool:
    """Move author -> clueing once every connected player has submitted
    their spectrums (and there are enough of them)."""
    if room.phase != "author":
        return False
    connected = room.connected_players()
    if len(connected) < MIN_PLAYERS:
        return False
    if not all(
        len(room.players[n].spectrums) >= SPECTRUMS_PER_PLAYER for n in connected
    ):
        return False
    assign_clues(room)
    room.phase = "clueing"
    return True


def player_clues_done(room: Room, name: str) -> bool:
    mine = room.assigned_to(name)
    return bool(mine) and all(s.clue for s in mine)


def build_play_order(room: Room) -> None:
    """Interleave clued spectrums by giver so consecutive rounds rotate
    through different players. Unclued spectrums (giver never wrote a clue)
    are dropped."""
    by_giver: dict[str, list[Spectrum]] = {}
    for s in room.pool:
        if s.clue:
            by_giver.setdefault(s.giver, []).append(s)
    for lst in by_giver.values():
        random.shuffle(lst)

    givers = [g for g in room.order if g in by_giver]
    order: list[int] = []
    while any(by_giver[g] for g in givers):
        for g in givers:
            if by_giver[g]:
                order.append(by_giver[g].pop().id)
    room.play_order = order
    room.play_index = -1


def check_clueing_complete(room: Room) -> bool:
    """Move clueing -> playing once every connected giver has written all
    of their clues."""
    if room.phase != "clueing":
        return False
    for name in room.givers:
        if room.players[name].connected and not player_clues_done(room, name):
            return False
    build_play_order(room)
    if not room.play_order:
        room.phase = "ended"
        room.current = None
        return True
    room.phase = "playing"
    start_next_round(room)
    return True


def start_next_round(room: Room) -> None:
    """Advance to the next playable spectrum, or end the game."""
    room.play_index += 1
    while room.play_index < len(room.play_order):
        s = room.spectrum_by_id(room.play_order[room.play_index])
        # A round is playable as long as someone other than the giver is
        # connected to guess (the giver itself may be offline — the clue is
        # already written).
        if s is not None and any(
            n != s.giver for n in room.connected_players()
        ):
            room.current = Round(spectrum=s, sub_phase="guess")
            return
        room.play_index += 1
    room.phase = "ended"
    room.current = None


def required_guessers(room: Room) -> list[str]:
    """Connected players who must guess this round (everyone but the clue-giver)."""
    r = room.current
    return [n for n in room.connected_players() if n != r.clue_giver]


def maybe_reveal(room: Room) -> None:
    """If every required guesser has locked a guess, score and move to reveal."""
    r = room.current
    if r is None or r.sub_phase != "guess":
        return
    needed = required_guessers(room)
    if needed and all(n in r.guesses for n in needed):
        do_reveal(room)


def do_reveal(room: Room) -> None:
    r = room.current
    r.sub_phase = "reveal"
    guesser_points: list[int] = []
    for name, value in r.guesses.items():
        d = abs(value - r.target)
        pts = score_for_distance(d)
        r.points[name] = pts
        room.players[name].score += pts
        guesser_points.append(pts)
    # Clue-giver scores the average of their guessers' points.
    avg = sum(guesser_points) / len(guesser_points) if guesser_points else 0.0
    r.clue_giver_points = avg
    if r.clue_giver in room.players:
        room.players[r.clue_giver].score += avg


# ---------------------------------------------------------------------------
# Per-player state views (anti-cheat: target hidden from guessers until reveal)
# ---------------------------------------------------------------------------
def player_list(room: Room) -> list[dict]:
    out = []
    for name in room.order:
        p = room.players[name]
        entry = {
            "name": name,
            "score": round(p.score, 1),
            "connected": p.connected,
            "isHost": name == room.host,
            "submitted": len(p.spectrums) >= SPECTRUMS_PER_PLAYER,
        }
        if room.phase == "clueing":
            entry["cluesDone"] = player_clues_done(room, name)
        if room.phase == "playing" and room.current is not None:
            r = room.current
            entry["isClueGiver"] = name == r.clue_giver
            entry["guessed"] = name in r.guesses
        out.append(entry)
    return out


def view_for(room: Room, viewer: str) -> dict:
    p = room.players.get(viewer)
    state = {
        "type": "state",
        "phase": room.phase,
        "code": room.code,
        "you": viewer,
        "isHost": viewer == room.host,
        "minPlayers": MIN_PLAYERS,
        "spectrumsPerPlayer": SPECTRUMS_PER_PLAYER,
        "players": player_list(room),
        "poolRemaining": room.rounds_remaining(),
    }

    if room.phase == "author":
        total = len(room.connected_players())
        done = sum(
            1 for n in room.connected_players()
            if len(room.players[n].spectrums) >= SPECTRUMS_PER_PLAYER
        )
        state["authorSubmitted"] = (
            p is not None and len(p.spectrums) >= SPECTRUMS_PER_PLAYER
        )
        state["authorDone"] = done
        state["authorTotal"] = total

    if room.phase == "clueing":
        # Each giver sees only their own assignments — including the target,
        # because they must see it to write a clue. Nobody sees anyone else's.
        mine = room.assigned_to(viewer)
        state["clueing"] = {
            "assignments": [
                {"id": s.id, "left": s.left, "right": s.right, "target": s.target}
                for s in mine
            ],
            "submitted": player_clues_done(room, viewer),
            "done": sum(1 for n in room.givers if player_clues_done(room, n)),
            "total": len(room.givers),
        }

    if room.phase == "playing" and room.current is not None:
        r = room.current
        is_giver = viewer == r.clue_giver
        needed = required_guessers(room)
        round_view = {
            "subPhase": r.sub_phase,
            "clueGiver": r.clue_giver,
            "youAreClueGiver": is_giver,
            "spectrum": {"left": r.spectrum.left, "right": r.spectrum.right},
            "clue": r.clue,                       # pre-written, safe to show all
            "guessedCount": sum(1 for n in needed if n in r.guesses),
            "guesserTotal": len(needed),
            "yourGuess": r.guesses.get(viewer),
        }
        # Target: only the clue-giver sees it before reveal; everyone at reveal.
        if r.sub_phase == "reveal" or is_giver:
            round_view["target"] = r.target
        if r.sub_phase == "reveal":
            round_view["guesses"] = [
                {"name": n, "value": v, "points": r.points.get(n, 0)}
                for n, v in r.guesses.items()
            ]
            round_view["clueGiverPoints"] = round(r.clue_giver_points, 1)
        state["round"] = round_view

    if room.phase == "ended":
        board = sorted(
            ({"name": n, "score": round(room.players[n].score, 1)} for n in room.order),
            key=lambda e: e["score"],
            reverse=True,
        )
        state["leaderboard"] = board

    return state


async def broadcast(room: Room) -> None:
    dead = []
    for name, ws in list(room.connections.items()):
        try:
            await ws.send_json(view_for(room, name))
        except Exception:
            dead.append(name)
    for name in dead:
        room.connections.pop(name, None)


# ---------------------------------------------------------------------------
# FastAPI app + WebSocket handler
# ---------------------------------------------------------------------------
app = FastAPI()
STATIC_DIR = Path(__file__).parent / "static"


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health():
    return {"status": "ok", "rooms": len(rooms)}


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


async def send_error(ws: WebSocket, message: str) -> None:
    await ws.send_json({"type": "error", "message": message})


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    room: Optional[Room] = None
    name: Optional[str] = None

    try:
        while True:
            msg = await ws.receive_json()
            action = msg.get("action")

            # ---- Join / create (before the player is attached to a room) ----
            if room is None:
                if action == "create_room":
                    pname = (msg.get("name") or "").strip()
                    if not pname:
                        await send_error(ws, "Please enter a name.")
                        continue
                    code = generate_code()
                    room = Room(code=code, host=pname)
                    room.players[pname] = Player(name=pname)
                    room.order.append(pname)
                    room.connections[pname] = ws
                    name = pname
                    rooms[code] = room
                    await ws.send_json(view_for(room, name))

                elif action == "join_room":
                    code = (msg.get("code") or "").strip().upper()
                    pname = (msg.get("name") or "").strip()
                    target = rooms.get(code)
                    if not pname:
                        await send_error(ws, "Please enter a name.")
                        continue
                    if target is None:
                        await send_error(ws, "Room not found.")
                        continue
                    existing = target.players.get(pname)
                    if existing is not None:
                        if existing.connected:
                            await send_error(ws, "That name is already taken.")
                            continue
                        # Rejoin by name (reconnect).
                        existing.connected = True
                        target.connections[pname] = ws
                        room, name = target, pname
                        await broadcast(room)
                        continue
                    # New player joining a fresh name.
                    if target.phase != "lobby":
                        await send_error(ws, "Game already in progress.")
                        continue
                    target.players[pname] = Player(name=pname)
                    target.order.append(pname)
                    target.connections[pname] = ws
                    room, name = target, pname
                    await broadcast(room)
                else:
                    await send_error(ws, "Join or create a room first.")
                continue

            # ---- In-room actions ----
            await handle_action(room, name, action, msg, ws)

    except WebSocketDisconnect:
        pass
    except Exception:
        # Don't let one bad message kill the socket silently without cleanup.
        pass
    finally:
        if room is not None and name is not None:
            await handle_disconnect(room, name, ws)


async def handle_action(room: Room, name: str, action: str, msg: dict, ws: WebSocket):
    player = room.players.get(name)
    if player is None:
        return

    if action == "start_game":
        if name != room.host:
            return await send_error(ws, "Only the host can start.")
        if room.phase != "lobby":
            return
        if len(room.connected_players()) < MIN_PLAYERS:
            return await send_error(ws, f"Need at least {MIN_PLAYERS} players.")
        room.phase = "author"
        await broadcast(room)

    elif action == "submit_spectrums":
        if room.phase != "author":
            return
        raw = msg.get("spectrums") or []
        cleaned = []
        for sp in raw:
            left = (sp.get("left") or "").strip()
            right = (sp.get("right") or "").strip()
            if left and right:
                cleaned.append({"left": left, "right": right})
        if len(cleaned) < SPECTRUMS_PER_PLAYER:
            return await send_error(
                ws, f"Please fill in all {SPECTRUMS_PER_PLAYER} spectrums (both ends)."
            )
        player.spectrums = cleaned[:SPECTRUMS_PER_PLAYER]
        check_author_complete(room)
        await broadcast(room)

    elif action == "submit_clues":
        if room.phase != "clueing":
            return
        raw = msg.get("clues") or {}
        # Accept {spectrum_id: clue_text}; only set clues for our assignments.
        mine = room.assigned_to(name)
        provided = {str(k): (v or "").strip() for k, v in raw.items()}
        if any(not provided.get(str(s.id)) for s in mine):
            return await send_error(ws, "Please write a clue for every spectrum.")
        for s in mine:
            s.clue = provided[str(s.id)]
        check_clueing_complete(room)
        await broadcast(room)

    elif action == "submit_guess":
        if room.phase != "playing" or room.current is None:
            return
        r = room.current
        if r.sub_phase != "guess" or name == r.clue_giver:
            return
        try:
            value = float(msg.get("value"))
        except (TypeError, ValueError):
            return
        value = max(0.0, min(100.0, value))
        r.guesses[name] = value
        maybe_reveal(room)
        await broadcast(room)

    elif action == "next_round":
        if name != room.host or room.phase != "playing" or room.current is None:
            return
        if room.current.sub_phase != "reveal":
            return
        start_next_round(room)
        await broadcast(room)

    elif action == "end_game":
        if name != room.host:
            return
        room.phase = "ended"
        room.current = None
        await broadcast(room)

    elif action == "play_again":
        if name != room.host or room.phase != "ended":
            return
        # Reset to lobby, keep players, drop scores / spectrums / assignments.
        for pl in room.players.values():
            pl.score = 0.0
            pl.spectrums = []
        room.pool = []
        room.givers = []
        room.play_order = []
        room.play_index = -1
        room.current = None
        room.spectrum_seq = 0
        room.phase = "lobby"
        await broadcast(room)


async def handle_disconnect(room: Room, name: str, ws: WebSocket):
    # Only clear the connection if this socket is the live one for the player
    # (avoids a stale socket wiping a fresh reconnect).
    if room.connections.get(name) is ws:
        room.connections.pop(name, None)
    player = room.players.get(name)
    if player is None:
        return
    player.connected = False

    # In the lobby, fully drop disconnected players so names free up.
    if room.phase == "lobby":
        room.players.pop(name, None)
        if name in room.order:
            room.order.remove(name)
        if name == room.host and room.order:
            room.host = room.order[0]
        if not room.order:
            rooms.pop(room.code, None)
            return
        await broadcast(room)
        return

    # A disconnect can unblock a phase transition (e.g. we were waiting on the
    # player who just left) or a reveal (they were the last guesser).
    if room.phase == "author":
        check_author_complete(room)
    elif room.phase == "clueing":
        check_clueing_complete(room)
    elif room.phase == "playing" and room.current is not None:
        # Clues are pre-written, so a clue-giver dropping does NOT abandon the
        # round. Only re-check whether the remaining guessers are all in.
        maybe_reveal(room)

    await broadcast(room)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
