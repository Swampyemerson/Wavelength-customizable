"""
Wavelength (custom) — local-network real-time multiplayer party game.

One FastAPI server, one port. Authoritative game state lives here, in memory.
Players (including the host) connect from their browsers over WebSockets.

Run:
    pip install -r requirements.txt
    python server.py            # or: uvicorn server:app --host 0.0.0.0 --port 8000

Then everyone opens http://<HOST-LAN-IP>:8000 on their phones.
"""

from __future__ import annotations

import asyncio
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
MIN_PLAYERS = 3
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
    author: str           # player name
    used: bool = False


@dataclass
class Round:
    clue_giver: str
    spectrum: Spectrum
    target: int
    clue: Optional[str] = None
    guesses: dict = field(default_factory=dict)   # name -> value (0..100)
    sub_phase: str = "clue"                        # clue | guess | reveal
    points: dict = field(default_factory=dict)     # name -> points (set at reveal)
    clue_giver_points: float = 0.0


@dataclass
class Room:
    code: str
    host: str
    phase: str = "lobby"          # lobby | author | playing | ended
    players: dict = field(default_factory=dict)    # name -> Player
    order: list = field(default_factory=list)      # join order (rotation)
    pool: list = field(default_factory=list)       # list[Spectrum]
    rotation_ptr: int = 0
    current: Optional[Round] = None
    spectrum_seq: int = 0
    connections: dict = field(default_factory=dict)  # name -> WebSocket

    # -- helpers -----------------------------------------------------------
    def connected_players(self) -> list[str]:
        return [n for n in self.order if self.players[n].connected]

    def next_spectrum_id(self) -> int:
        self.spectrum_seq += 1
        return self.spectrum_seq

    def pool_remaining(self) -> int:
        return sum(1 for s in self.pool if not s.used)


rooms: dict[str, Room] = {}


def generate_code() -> str:
    while True:
        code = "".join(random.choices(string.ascii_uppercase, k=4))
        if code not in rooms:
            return code


# ---------------------------------------------------------------------------
# Round / scoring logic (server authoritative)
# ---------------------------------------------------------------------------
def build_pool(room: Room) -> None:
    pool: list[Spectrum] = []
    for name in room.order:
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
    room.pool = pool


def start_next_round(room: Room) -> None:
    """Advance to the next round, or end the game if no valid pairing remains."""
    remaining = [s for s in room.pool if not s.used]
    if not remaining:
        room.phase = "ended"
        room.current = None
        return

    order = room.order
    n = len(order)
    chosen_giver = None
    chosen_spectrum = None

    # Try each player starting at the rotation pointer; pick the first connected
    # player who has at least one eligible (not self-authored) spectrum left.
    for k in range(n):
        idx = (room.rotation_ptr + k) % n
        name = order[idx]
        if not room.players[name].connected:
            continue
        eligible = [s for s in remaining if s.author != name]
        if eligible:
            chosen_giver = name
            chosen_spectrum = random.choice(eligible)
            room.rotation_ptr = (idx + 1) % n
            break

    if chosen_giver is None or chosen_spectrum is None:
        # No connected player can be paired with a remaining spectrum.
        room.phase = "ended"
        room.current = None
        return

    chosen_spectrum.used = True
    room.current = Round(
        clue_giver=chosen_giver,
        spectrum=chosen_spectrum,
        target=random.randint(TARGET_MIN, TARGET_MAX),
        sub_phase="clue",
    )


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
    room.players[r.clue_giver].score += avg


# ---------------------------------------------------------------------------
# Per-player state views (anti-cheat: target hidden until reveal)
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
        "poolRemaining": room.pool_remaining(),
    }

    if room.phase == "author":
        total = len(room.order)
        done = sum(
            1 for n in room.order
            if len(room.players[n].spectrums) >= SPECTRUMS_PER_PLAYER
        )
        state["authorSubmitted"] = (
            p is not None and len(p.spectrums) >= SPECTRUMS_PER_PLAYER
        )
        state["authorDone"] = done
        state["authorTotal"] = total

    if room.phase == "playing" and room.current is not None:
        r = room.current
        is_giver = viewer == r.clue_giver
        needed = required_guessers(room)
        round_view = {
            "subPhase": r.sub_phase,
            "clueGiver": r.clue_giver,
            "youAreClueGiver": is_giver,
            "spectrum": {"left": r.spectrum.left, "right": r.spectrum.right},
            "guessedCount": sum(1 for n in needed if n in r.guesses),
            "guesserTotal": len(needed),
            "yourGuess": r.guesses.get(viewer),
        }
        # Clue is visible to the clue-giver always, and to guessers once given.
        if r.sub_phase in ("guess", "reveal") or is_giver:
            round_view["clue"] = r.clue
        # Target: only the clue-giver sees it before reveal; everyone at reveal.
        if r.sub_phase == "reveal" or (is_giver and r.sub_phase in ("clue", "guess")):
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
        # If everyone has submitted, build the pool and begin.
        if all(
            len(room.players[n].spectrums) >= SPECTRUMS_PER_PLAYER
            for n in room.connected_players()
        ) and len(room.connected_players()) >= MIN_PLAYERS:
            build_pool(room)
            room.phase = "playing"
            room.rotation_ptr = 0
            start_next_round(room)
        await broadcast(room)

    elif action == "submit_clue":
        if room.phase != "playing" or room.current is None:
            return
        r = room.current
        if r.sub_phase != "clue" or name != r.clue_giver:
            return
        clue = (msg.get("clue") or "").strip()
        if not clue:
            return await send_error(ws, "Please enter a clue.")
        r.clue = clue
        r.sub_phase = "guess"
        maybe_reveal(room)  # handles the (unlikely) case of zero guessers
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
        # Reset to lobby, keep players, drop scores and authored spectrums.
        for p in room.players.values():
            p.score = 0.0
            p.spectrums = []
        room.pool = []
        room.current = None
        room.rotation_ptr = 0
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
        # Reassign host if the host left.
        if name == room.host and room.order:
            room.host = room.order[0]
        if not room.order:
            rooms.pop(room.code, None)
            return
        await broadcast(room)
        return

    # Mid-game: if the clue-giver drops, abandon the round and return its
    # spectrum to the pool, then draw the next round.
    if (
        room.phase == "playing"
        and room.current is not None
        and room.current.clue_giver == name
        and room.current.sub_phase in ("clue", "guess")
    ):
        room.current.spectrum.used = False
        start_next_round(room)
    elif room.phase == "playing" and room.current is not None:
        # A guesser dropped — they may have been the one we were waiting on.
        maybe_reveal(room)

    await broadcast(room)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
