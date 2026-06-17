/* Wavelength client — talks to the server over one WebSocket and renders
 * whichever screen the server's state says we should be on. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const SCREENS = [
    "join", "lobby", "author", "waiting",
    "clue", "guess", "clue-wait", "reveal", "final",
  ];

  let ws = null;
  let state = null;          // last state from server
  let myName = null;
  let dials = {};            // cached Dial instances per screen
  let guessReady = false;    // has the user moved the guesser dial at least once
  let lastSubPhase = null;   // to detect round transitions

  // ---- WebSocket ---------------------------------------------------------
  function connect(then) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { hideBanner(); if (then) then(); };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "error") return showBanner(msg.message, true);
      if (msg.type === "state") onState(msg);
    };
    ws.onclose = () => {
      showBanner("Disconnected — reconnecting…", true);
      setTimeout(() => reconnect(), 1500);
    };
    ws.onerror = () => {};
  }

  function reconnect() {
    if (!myName) return;
    connect(() => {
      // Re-attach by name. If we never created/joined, this is harmless.
      if (state && state.code) {
        send({ action: "join_room", code: state.code, name: myName });
      }
    });
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // ---- Banner ------------------------------------------------------------
  function showBanner(text, isError) {
    const b = $("banner");
    b.textContent = text;
    b.classList.toggle("error", !!isError);
    b.classList.remove("hidden");
  }
  function hideBanner() {
    $("banner").classList.add("hidden");
  }

  // ---- Screen routing ----------------------------------------------------
  function show(screen) {
    SCREENS.forEach((s) => $("screen-" + s).classList.toggle("hidden", s !== screen));
  }

  function onState(s) {
    const prev = state;
    state = s;
    myName = s.you;

    if (s.phase === "lobby") { renderLobby(s); show("lobby"); }
    else if (s.phase === "author") {
      if (s.authorSubmitted) { renderWaiting(s); show("waiting"); }
      else { ensureAuthorForms(s); show("author"); }
    } else if (s.phase === "playing") { renderRound(s, prev); }
    else if (s.phase === "ended") { renderFinal(s); show("final"); }

    renderMiniBoard(s);
  }

  // ---- JOIN --------------------------------------------------------------
  $("btn-create").onclick = () => {
    const name = $("join-name").value.trim();
    if (!name) return showBanner("Enter a name first.", true);
    myName = name;
    connect(() => send({ action: "create_room", name }));
  };
  $("btn-join").onclick = () => {
    const name = $("join-name").value.trim();
    const code = $("join-code").value.trim().toUpperCase();
    if (!name) return showBanner("Enter a name first.", true);
    if (!code) return showBanner("Enter a room code.", true);
    myName = name;
    connect(() => send({ action: "join_room", name, code }));
  };

  // ---- LOBBY -------------------------------------------------------------
  function renderLobby(s) {
    $("lobby-code").textContent = s.code;
    $("lobby-count").textContent = s.players.length;
    const ul = $("lobby-players");
    ul.innerHTML = "";
    s.players.forEach((p) => {
      const li = document.createElement("li");
      li.innerHTML =
        `<span class="dot ${p.connected ? "on" : "off"}"></span>` +
        `<span class="pname">${esc(p.name)}</span>` +
        (p.isHost ? `<span class="tag-host">host</span>` : "") +
        (p.name === s.you ? `<span class="tag-you">you</span>` : "");
      ul.appendChild(li);
    });

    const hostBox = $("lobby-host");
    if (s.isHost) {
      hostBox.classList.remove("hidden");
      $("lobby-wait").classList.add("hidden");
      const enough = s.players.length >= s.minPlayers;
      $("btn-start").disabled = !enough;
      $("lobby-start-hint").textContent = enough
        ? `${s.players.length} players ready.`
        : `Need at least ${s.minPlayers} players (have ${s.players.length}).`;
    } else {
      hostBox.classList.add("hidden");
      $("lobby-wait").classList.remove("hidden");
    }
  }
  $("btn-start").onclick = () => send({ action: "start_game" });

  // ---- AUTHOR ------------------------------------------------------------
  let authorBuilt = false;
  function ensureAuthorForms(s) {
    $("author-n").textContent = s.spectrumsPerPlayer;
    if (authorBuilt) return;
    const wrap = $("author-forms");
    wrap.innerHTML = "";
    for (let i = 0; i < s.spectrumsPerPlayer; i++) {
      const card = document.createElement("div");
      card.className = "card spectrum-form";
      card.innerHTML =
        `<span class="snum">#${i + 1}</span>` +
        `<input class="sp-left" type="text" maxlength="24" placeholder="Left end (e.g. Cold)">` +
        `<span class="vs">↔</span>` +
        `<input class="sp-right" type="text" maxlength="24" placeholder="Right end (e.g. Hot)">`;
      wrap.appendChild(card);
    }
    authorBuilt = true;
  }
  $("btn-submit-spectrums").onclick = () => {
    const lefts = document.querySelectorAll(".sp-left");
    const rights = document.querySelectorAll(".sp-right");
    const spectrums = [];
    for (let i = 0; i < lefts.length; i++) {
      spectrums.push({ left: lefts[i].value.trim(), right: rights[i].value.trim() });
    }
    if (spectrums.some((s) => !s.left || !s.right)) {
      return showBanner("Fill in both ends of every spectrum.", true);
    }
    send({ action: "submit_spectrums", spectrums });
  };

  function renderWaiting(s) {
    $("author-progress").textContent = `${s.authorDone} / ${s.authorTotal}`;
  }

  function setLabels(id, spectrum) {
    $(id).innerHTML =
      `<span class="l">◀ ${esc(spectrum.left)}</span>` +
      `<span class="r">${esc(spectrum.right)} ▶</span>`;
  }

  // ---- ROUND -------------------------------------------------------------
  function renderRound(s, prev) {
    const r = s.round;
    if (!r) return;
    const newRound = !prev || !prev.round ||
      prev.round.clueGiver !== r.clueGiver ||
      (prev.phase !== "playing");

    if (r.youAreClueGiver) {
      if (r.subPhase === "clue") renderClueGiver(s, r, newRound);
      else if (r.subPhase === "guess") renderClueWait(s, r);
      else renderReveal(s, r);
    } else {
      if (r.subPhase === "clue") renderGuesserWaiting(s, r);
      else if (r.subPhase === "guess") renderGuesser(s, r, newRound);
      else renderReveal(s, r);
    }
    lastSubPhase = r.subPhase;
  }

  // Clue-giver: sees the target, types a clue.
  function renderClueGiver(s, r, newRound) {
    show("clue");
    if (!dials.clue || newRound) {
      dials.clue = new Dial($("clue-dial"), { interactive: false, value: 50 });
    }
    dials.clue.setTarget(r.target);
    setLabels("clue-labels", r.spectrum);
    if (newRound) $("clue-input").value = "";
    $("btn-submit-clue").disabled = false;
  }
  $("btn-submit-clue").onclick = () => {
    const clue = $("clue-input").value.trim();
    if (!clue) return showBanner("Type a clue first.", true);
    $("btn-submit-clue").disabled = true;
    send({ action: "submit_clue", clue });
  };

  // Clue-giver waiting for guesses.
  function renderClueWait(s, r) {
    show("clue-wait");
    $("clue-wait-text").textContent = `“${r.clue}”`;
    $("clue-wait-progress").textContent = `${r.guessedCount} / ${r.guesserTotal}`;
    if (!dials.cluewait) {
      dials.cluewait = new Dial($("cluewait-dial"), { interactive: false });
    }
    dials.cluewait.setTarget(r.target != null ? r.target : null);
    setLabels("cluewait-labels", r.spectrum);
  }

  // Guesser waiting for the clue.
  function renderGuesserWaiting(s, r) {
    show("guess");
    $("guess-giver").textContent = r.clueGiver;
    $("guess-clue-box").classList.add("hidden");
    $("guess-wait-clue").classList.remove("hidden");
    $("btn-submit-guess").disabled = true;
    $("guess-locked-hint").classList.add("hidden");
    if (!dials.guess) {
      dials.guess = new Dial($("guess-dial"), {
        interactive: true, value: 50,
        onChange: () => { guessReady = true; $("btn-submit-guess").disabled = false; },
      });
    }
    dials.guess.setTarget(null);
    dials.guess.clearMarkers();
    setLabels("guess-labels", r.spectrum);
  }

  // Guesser: drags the pointer, locks a guess.
  function renderGuesser(s, r, newRound) {
    show("guess");
    $("guess-giver").textContent = r.clueGiver;
    $("guess-clue").textContent = r.clue || "";
    $("guess-clue-box").classList.remove("hidden");
    $("guess-wait-clue").classList.add("hidden");

    if (!dials.guess || newRound) {
      guessReady = false;
      dials.guess = new Dial($("guess-dial"), {
        interactive: true, value: 50,
        onChange: () => { guessReady = true; $("btn-submit-guess").disabled = false; },
      });
    }
    dials.guess.setTarget(null);
    setLabels("guess-labels", r.spectrum);
    dials.guess.setInteractive(r.yourGuess == null);

    const locked = r.yourGuess != null;
    if (locked) {
      dials.guess.setValue(r.yourGuess);
      $("btn-submit-guess").disabled = true;
      $("btn-submit-guess").textContent = "Locked ✓";
      $("guess-locked-hint").classList.remove("hidden");
      $("guess-progress").textContent = `(${r.guessedCount} / ${r.guesserTotal})`;
    } else {
      $("btn-submit-guess").textContent = "Lock in guess";
      $("btn-submit-guess").disabled = !guessReady;
      $("guess-locked-hint").classList.add("hidden");
    }
  }
  $("btn-submit-guess").onclick = () => {
    if (!dials.guess) return;
    $("btn-submit-guess").disabled = true;
    send({ action: "submit_guess", value: dials.guess.getValue() });
  };

  // ---- REVEAL ------------------------------------------------------------
  function renderReveal(s, r) {
    show("reveal");
    $("reveal-clue").textContent = `“${r.clue}”`;
    $("reveal-giver").textContent = r.clueGiver;

    dials.reveal = new Dial($("reveal-dial"), { interactive: false });
    dials.reveal.setTarget(r.target);
    setLabels("reveal-labels", r.spectrum);
    (r.guesses || []).forEach((g) => {
      const cls = g.points >= 3 ? "good" : g.points >= 2 ? "ok" : "miss";
      dials.reveal.addMarker(g.value, g.name, cls);
    });

    const ul = $("reveal-scores");
    ul.innerHTML = "";
    const rows = (r.guesses || [])
      .slice()
      .sort((a, b) => b.points - a.points)
      .map((g) => `<li><span>${esc(g.name)}</span><b>+${g.points}</b></li>`);
    rows.push(
      `<li class="giver-row"><span>${esc(r.clueGiver)} <em>(clue-giver)</em></span>` +
      `<b>+${r.clueGiverPoints}</b></li>`
    );
    ul.innerHTML = rows.join("");

    const last = s.poolRemaining === 0;
    if (s.isHost) {
      $("btn-next").classList.remove("hidden");
      $("btn-next").textContent = last ? "See final scores →" : "Next round →";
      $("reveal-wait").classList.add("hidden");
    } else {
      $("btn-next").classList.add("hidden");
      $("reveal-wait").classList.remove("hidden");
    }
  }
  $("btn-next").onclick = () => send({ action: "next_round" });

  // ---- FINAL -------------------------------------------------------------
  function renderFinal(s) {
    const board = s.leaderboard || [];
    const ol = $("final-board");
    ol.innerHTML = "";
    const medals = ["🥇", "🥈", "🥉"];
    board.forEach((p, i) => {
      const li = document.createElement("li");
      li.className = i === 0 ? "winner" : "";
      li.innerHTML =
        `<span class="rank">${medals[i] || i + 1}</span>` +
        `<span class="fname">${esc(p.name)}</span>` +
        `<b>${p.score}</b>`;
      ol.appendChild(li);
    });
    $("btn-again").classList.toggle("hidden", !s.isHost);
  }
  $("btn-again").onclick = () => { authorBuilt = false; send({ action: "play_again" }); };

  // ---- Mini leaderboard --------------------------------------------------
  function renderMiniBoard(s) {
    const mb = $("mini-board");
    if (s.phase !== "playing") { mb.classList.add("hidden"); return; }
    const top = s.players
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map((p) => `<span>${esc(p.name)} <b>${p.score}</b></span>`)
      .join("");
    mb.innerHTML = `<span class="mb-label">Pool left: ${s.poolRemaining}</span>${top}`;
    mb.classList.remove("hidden");
  }

  // ---- util --------------------------------------------------------------
  function esc(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  // Enter-to-submit niceties.
  $("join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-join").click(); });
  $("clue-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-submit-clue").click(); });
})();
