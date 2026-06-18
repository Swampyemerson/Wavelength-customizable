/* Wavelength client — talks to the server over one WebSocket and renders
 * whichever screen the server's state says we should be on. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const SCREENS = [
    "join", "lobby", "author", "clues", "waiting",
    "guess", "clue-wait", "reveal", "final",
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
      if (s.authorSubmitted) {
        renderWaiting("Spectrums locked in ✓",
          "Waiting for everyone to finish writing…",
          `${s.authorDone} / ${s.authorTotal}`);
        show("waiting");
      } else { ensureAuthorForms(s); show("author"); }
    } else if (s.phase === "clueing") {
      if (s.clueing.submitted) {
        renderWaiting("Clues locked in ✓",
          "Waiting for everyone to finish their clues…",
          `${s.clueing.done} / ${s.clueing.total}`);
        show("waiting");
      } else { ensureCluesForms(s); show("clues"); }
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

  function renderWaiting(title, text, progress) {
    $("waiting-title").textContent = title;
    $("waiting-text").textContent = text;
    $("waiting-progress").textContent = progress;
  }

  // ---- CLUEING (write all your clues at once) ----------------------------
  // Keyed by the set of assigned spectrum ids so we rebuild only when the
  // assignment actually changes (e.g. on play-again), not on every state push.
  let cluesKey = null;
  let cluesDials = {};
  function ensureCluesForms(s) {
    const a = s.clueing.assignments;
    $("clues-count").textContent = a.length;
    const key = a.map((x) => x.id).join(",");
    if (key === cluesKey) return;
    cluesKey = key;
    cluesDials = {};
    const wrap = $("clues-forms");
    wrap.innerHTML = "";
    a.forEach((sp, i) => {
      const card = document.createElement("div");
      card.className = "card clue-form";
      card.innerHTML =
        `<div class="clue-form-head">#${i + 1}</div>` +
        `<div class="dial-wrap" id="cluedial-${sp.id}"></div>` +
        `<div class="dial-labels" id="cluelabels-${sp.id}"></div>` +
        `<input class="clue-write" data-id="${sp.id}" type="text" maxlength="80" ` +
        `placeholder="Your clue for the marked target…">`;
      wrap.appendChild(card);
      cluesDials[sp.id] = new Dial($("cluedial-" + sp.id), { interactive: false });
      cluesDials[sp.id].setTarget(sp.target);
      setLabels("cluelabels-" + sp.id, sp);
    });
  }
  $("btn-submit-clues").onclick = () => {
    const inputs = document.querySelectorAll(".clue-write");
    const clues = {};
    let missing = false;
    inputs.forEach((inp) => {
      const v = inp.value.trim();
      if (!v) missing = true;
      clues[inp.dataset.id] = v;
    });
    if (missing) return showBanner("Write a clue for every spectrum.", true);
    send({ action: "submit_clues", clues });
  };

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
      prev.round.clue !== r.clue ||
      (prev.phase !== "playing");

    if (r.subPhase === "reveal") renderReveal(s, r);
    else if (r.youAreClueGiver) renderClueWait(s, r);  // their clue is pre-written
    else renderGuesser(s, r, newRound);
    lastSubPhase = r.subPhase;
  }

  // Clue-giver waiting for guesses (clue was written in the clueing phase).
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

  // Guesser: drags the pointer, locks a guess. The clue is already shown.
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
  $("btn-again").onclick = () => {
    authorBuilt = false;
    cluesKey = null;
    send({ action: "play_again" });
  };

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
})();
