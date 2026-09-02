/* =========================================================================
   Ludora — ui.js
   The single UI layer: renders every screen from the loaded profile,
   drives the game controller, and owns routing, themes, view tiers,
   toasts, PWA install + service-worker update flow, and the serverless
   multiplayer lobby/room UI. All game rules live in the engine; the UI
   never mutates game state directly.
   ========================================================================= */
(function (global) {
  'use strict';
  var E = global.LudoraEngine, Board = global.LudoraBoard, Game = global.LudoraGame,
      Store = global.LudoraStore, Persist = global.LudoraPersist,
      Profile = global.LudoraProfile, Audio2 = global.LudoraAudio,
      Net = global.LudoraNet, Mp = global.LudoraMp, Qr = global.LudoraQr;

  var APP_VERSION = '1.4.0';
  /* player palette (matches engine/board): 0=Red, 1=Green, 2=Yellow, 3=Blue */
  var COLORS = [[239,68,68],[34,197,94],[251,191,36],[59,130,246]];
  var PLAYER_NAMES = ['Red', 'Green', 'Yellow', 'Blue'];
  var AV_COLORS = ['#C2413B', '#2E8A54', '#3D6BB5', '#33807B', '#5F5FA8', '#BC7A2C', '#B25579', '#A9822F'];
  var AV_GLYPHS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

  var profile = null;
  var inited = false;
  var installEvent = null;
  var mpState = { room: null, invite: {}, connecting: false, guest: null };
  var activeMatch = null;
  var podEls = [];               // per-seat control pod refs (game screen)
  var lastPodValue = [];         // last shown die value per seat (kept across renders)
  var playerGlyphs = ['A', 'B', 'C', 'D'];
  var passState = { count: 2, colors: [0, 1, 2, 3], names: ['Player 1', 'Player 2', 'Player 3', 'Player 4'], avatars: [0,1,2,3], team: false, teamNames: ['Team A', 'Team B'] };
  var quickState = { aiName: 'Aria', aiLevel: 1, color: 0 };
  var dailyState = null;
  var overlayOpen = false;

  /* ========================= helpers ========================= */
  function $(id) { return document.getElementById(id); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'dataset') Object.keys(attrs[k]).forEach(function (d) { e.dataset[d] = attrs[k][d]; });
      else if (k === 'style') e.style.cssText = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    if (html != null) e.innerHTML = html;
    return e;
  }
  function avatarHTML(idx, size) {
    var c = AV_COLORS[idx % AV_COLORS.length], g = AV_GLYPHS[idx % AV_GLYPHS.length];
    return '<span class="avatar" style="background:' + c + ';width:' + (size||32) + 'px;height:' + (size||32) + 'px;font-size:' + Math.round((size||32)*0.42) + 'px">' + g + '</span>';
  }
  function colorCss(c) { return 'rgb(' + COLORS[c][0] + ',' + COLORS[c][1] + ',' + COLORS[c][2] + ')'; }
  function colorLight(c) { var p = COLORS[c]; return 'rgb(' + Math.min(255,p[0]+90) + ',' + Math.min(255,p[1]+90) + ',' + Math.min(255,p[2]+90) + ')'; }

  /* ========================= toasts ========================= */
  function toast(msg, kind, icon) {
    var host = $('toasts');
    if (!host) return;
    var t = el('div', { class: 'toast ' + (kind || '') });
    t.innerHTML = '<span class="t-tile">' + (icon ? '<svg class="ic"><use href="#i-' + icon + '"/></svg>' : '') + '</span><span>' + esc(msg) + '</span>';
    host.appendChild(t);
    setTimeout(function () { t.classList.add('out'); setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260); }, 2600);
  }

  function announce(text) {
    var s = $('sr-live');
    if (s) s.textContent = text || '';
  }

  /* ========================= profile ========================= */
  function getProfile() {
    if (profile) return profile;
    try { profile = Profile.loadProfile(); } catch (e) { profile = Profile.defaultProfile(); }
    return profile;
  }
  function reloadProfile() { profile = Profile.loadProfile(); return profile; }
  function saveProfile() { try { Profile.saveProfile(getProfile()); } catch (e) {} }

  /* ========================= appearance & view ========================= */
  function systemLight() {
    try { return !!(global.matchMedia && global.matchMedia('(prefers-color-scheme: light)').matches); }
    catch (e) { return false; }
  }
  function applyAppearance() {
    var s = getProfile().settings;
    var theme = s.theme === 'auto' ? (systemLight() ? 'light' : 'dark') : s.theme;
    var root = document.documentElement;
    root.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#F2F3F7' : '#0B0C10');
  }
  function applyView() {
    var layout = getProfile().settings.layout;
    var root = document.documentElement;
    var v = layout;
    if (layout === 'auto') {
      var w = global.innerWidth || 1024;
      v = w >= 1100 ? 'desktop' : (w >= 700 ? 'tablet' : 'phone');
    }
    root.setAttribute('data-view', v);
  }

  /* ========================= navigation ========================= */
  var SCREENS = ['scr-home','scr-quick','scr-pass','scr-game','scr-end','scr-mp','scr-room','scr-profile','scr-daily','scr-rules','scr-settings'];
  var nav = { stack: ['scr-home'] };
  function show(id, opts) {
    opts = opts || {};
    SCREENS.forEach(function (s) {
      var elx = $(s);
      if (!elx) return;
      var active = s === id;
      if (active) {
        elx.classList.add('active');
        elx.classList.remove('leaving');
        if (opts.dir) elx.setAttribute('data-nav', opts.dir);
      } else {
        if (elx.classList.contains('active')) { elx.classList.add('leaving'); setTimeout(function () { elx.classList.remove('leaving'); }, 300); }
        elx.classList.remove('active');
      }
    });
    if (opts.dir === 'back') { /* keep history */ }
    else if (nav.stack[nav.stack.length - 1] !== id) { /* not pushed via nav.push */ }
  }
  function renderScreen(id) {
    switch (id) {
      case 'scr-quick': renderQuick(); break;
      case 'scr-pass': renderPass(); break;
      case 'scr-daily': renderDaily(); break;
      case 'scr-mp': renderMp(); break;
      case 'scr-profile': renderProfile(); break;
      case 'scr-rules': renderRules(); break;
      case 'scr-settings': renderSettings(); break;
      case 'scr-room': renderRoom(); break;
      case 'scr-home': refreshHome(); break;
      /* game + end are rendered by the match wiring, not hero navigation */
    }
  }
  function navigate(id, dir) {
    if (id === 'scr-home') { goHome(); return; }
    var cur = nav.stack[nav.stack.length - 1];
    if (cur === id) return;
    nav.stack.push(id);
    renderScreen(id);
    show(id, { dir: dir || 'push' });
  }
  function back() {
    // if a modal sheet is open, close it instead of navigating
    var menu = $('pauseMenu');
    if (menu && !menu.classList.contains('hidden')) { menu.classList.add('hidden'); overlayOpen = false; return; }
    if (nav.stack.length > 1) {
      nav.stack.pop();
      var prev = nav.stack[nav.stack.length - 1];
      if (prev === 'scr-home') { goHome(); return; }
      show(prev, { dir: 'back' });
      return;
    }
    goHome();
  }
  nav.canBack = function () { return nav.stack.length > 1; };
  nav.push = navigate;

  function goHome() {
    var g = Game.active();
    if (g && !g.destroyed) {
      try {
        if (g.cfg && g.cfg.mode === 'online') { /* never persist online matches */ }
        else g.save();
      } catch (e) {}
      Game.destroy();
    }
    if (mpState.room) { try { mpState.room.close('left-ui'); } catch (e) {} mpState.room = null; mpState.invite = {}; }
    activeMatch = null;
    nav.stack = ['scr-home'];
    show('scr-home');
    refreshHome();
    applyAppearance(); applyView();
  }

  var popstateHandler = function (e) {
    if (e && e.state && e.state.s) {
      if (e.state.s === 'scr-home') { back(); }
      else navigate(e.state.s, 'back');
    }
  };

  /* edge-swipe back (Android 10 gesture nav) */
  var swipeStart = null;
  function touchStart(e) {
    var t = e.touches && e.touches[0];
    if (t && t.clientX < 24) swipeStart = { x: t.clientX, y: t.clientY };
    else swipeStart = null;
  }
  function touchEnd(e) {
    if (!swipeStart) return;
    var t = e.changedTouches && e.changedTouches[0];
    if (!t) { swipeStart = null; return; }
    var dx = t.clientX - swipeStart.x, dy = t.clientY - swipeStart.y;
    swipeStart = null;
    var menu = $('pauseMenu');
    if (menu && !menu.classList.contains('hidden')) { menu.classList.add('hidden'); overlayOpen = false; return; }
    if (dx > 60 && Math.abs(dy) < 40) back();
  }

  /* ========================= match wiring ========================= */
  /* Build the four player control pods (one per seat) with their own die,
     identity, turn state and homes tracker. Kept in sync with engine state. */
  /* Flat pip die (one face, 9 pips). The heavy six-face CSS cube adds ~216
     DOM nodes in a 4-player game; a single face is equivalent for the player
     and lets the browser composite with far less work. */
  var PIP_ON = { 1:[4], 2:[2,6], 3:[2,4,6], 4:[1,3,7,9], 5:[1,3,5,7,9], 6:[1,3,4,6,7,9] };
  var PIP_GRID = '<i class="pip"></i><i class="pip"></i><i class="pip"></i><i class="pip"></i><i class="pip"></i>' +
                 '<i class="pip"></i><i class="pip"></i><i class="pip"></i><i class="pip"></i>';
  function setPips(cube, value) {
    if (!cube) return;
    var on = PIP_ON[value] || PIP_ON[1];
    var pips = cube.children;
    for (var i = 0; i < pips.length; i++) pips[i].classList.toggle('on', on.indexOf(i + 1) >= 0);
  }
  function seatPodTemplate() {
    return '<div class="sp-top"><span class="sp-avatar"></span>' +
      '<div class="sp-id"><div class="sp-name"></div><div class="sp-sub"></div></div>' +
      '<span class="sp-team" style="display:none"></span></div>' +
      '<div class="sp-homes"></div>' +
      '<div class="sp-dice"><button class="sp-roll" aria-label="Roll the dice"><div class="sp-cube">' + PIP_GRID + '</div></button>' +
      '<span class="sp-hint">Roll</span></div>';
  }
  function ensureSeatPods(st) {
    var bar = $('seatBar'); if (!bar) return false;
    if (podEls.length === st.seats.length && bar.children.length === st.seats.length) return true;
    bar.innerHTML = '';
    podEls = [];
    lastPodValue = [];           // fresh match: no stale die value carries over
    var laneMap = (Board && Board.SIDE_OF) || ['bottom', 'left', 'top', 'right'];
    for (var i = 0; i < st.seats.length; i++) {
      var pod = document.createElement('div');
      pod.className = 'seat-pod';
      pod.setAttribute('data-seat', String(i));
      /* real four-side placement: each pod hugs the board side its yard faces */
      var side = laneMap[st.seats[i].color] || 'bottom';
      pod.setAttribute('data-side', side);
      pod.classList.add('side-' + side);
      pod.innerHTML = seatPodTemplate();
      bar.appendChild(pod);
      var ref = {
        root: pod,
        avatar: pod.querySelector('.sp-avatar'),
        name: pod.querySelector('.sp-name'),
        sub: pod.querySelector('.sp-sub'),
        team: pod.querySelector('.sp-team'),
        status: pod.querySelector('.sp-sub'),   /* reuse sub for status text */
        statusRoot: null,
        dot: null,
        homes: pod.querySelector('.sp-homes'),
        dice: pod.querySelector('.sp-roll'),
        cube: pod.querySelector('.sp-cube'),
        hint: pod.querySelector('.sp-hint')
      };
      ref.dice.addEventListener('click', (function (idx) { return function () { rollForSeat(idx); }; })(i));
      podEls.push(ref);
      lastPodValue[i] = 1;       // neutral until the first roll of the match
    }
    return true;
  }
  function rollForSeat(idx) {
    var g = activeMatch; if (!g || !g.st) return;
    if (g.st.turn !== idx) return;
    var s = g.st.seats[idx]; if (!s || s.kind !== 'human') return;
    if (!g.isLocalSeat(idx)) return;
    g.rollRequest();
  }
  function seatStatus(st, i) {
    var g = activeMatch, s = st.seats[i];
    var active = st.turn === i;
    var isLocal = g ? g.isLocalSeat(i) : true;
    var online = !!(g && g.cfg && g.cfg.mode === 'online');
    if (active && s.kind === 'ai') return { cls: 'status-ai', text: 'Thinking' };
    if (active && s.kind === 'human') {
      if (online && !isLocal) return { cls: 'status-waiting', text: g.seatIsRemote(i) ? 'Waiting' : 'Rolling' };
      var phase = st.phase;
      var txt = phase === 'move' ? 'Pick a pawn' : (phase === 'anim' ? 'Moving…' : 'Your turn');
      return { cls: 'status-turn', text: txt };
    }
    if (s.kind === 'ai') return { cls: 'status-ai', text: 'AI' };
    if (online && g.seatIsRemote(i) && g.netHost && !g.netHost.isSeatLive(i)) return { cls: 'status-offline', text: 'Offline' };
    if (online) return { cls: 'status-waiting', text: g.isLocalSeat(i) ? 'Your turn' : 'Waiting' };
    return { cls: 'status-waiting', text: 'Waiting' };
  }
  /* Set the four-side lane sizes on the board wrapper so the grid reserves a
     gutter for each occupied side (left/right/top/bottom) and the board keeps
     the centre. Mirrors the lane math the controller uses to size the canvas. */
  function layoutSeatPods(st) {
    var wrap = $('boardWrap'); if (!wrap || !st) return;
    var Lane = (Board && Board.podLanes) ? Board.podLanes() : { x: 104, y: 120 };
    var laneMap = (Board && Board.SIDE_OF) || ['bottom', 'left', 'top', 'right'];
    var sides = { top: false, bottom: false, left: false, right: false };
    st.seats.forEach(function (s) { sides[laneMap[s.color] || 'bottom'] = true; });
    wrap.style.setProperty('--lane-l', sides.left ? (Lane.x + 'px') : '0px');
    wrap.style.setProperty('--lane-r', sides.right ? (Lane.x + 'px') : '0px');
    wrap.style.setProperty('--lane-t', sides.top ? (Lane.y + 'px') : '0px');
    wrap.style.setProperty('--lane-b', sides.bottom ? (Lane.y + 'px') : '0px');
  }
  function syncSeatPods(st, d) {
    if (!ensureSeatPods(st)) return;
    layoutSeatPods(st);
    var g = activeMatch;
    for (var i = 0; i < st.seats.length; i++) {
      var ref = podEls[i]; if (!ref) continue;
      var s = st.seats[i];
      var color = s.color;
      var active = st.turn === i;
      var localHuman = s.kind === 'human' && g && g.isLocalSeat(i);
      /* identity */
      ref.root.style.color = colorCss(color);
      ref.root.style.setProperty('--sp-bg', colorCss(color));
      ref.avatar.style.background = colorCss(color);
      ref.avatar.textContent = playerGlyphs[(s.avatar != null ? s.avatar : color) % playerGlyphs.length];
      /* never show a fake generic name: if no real name loaded, say so */
      ref.name.textContent = (s.name && String(s.name).trim()) ? s.name : 'Name unavailable';
      ref.name.setAttribute('title', ref.name.textContent);
      ref.sub.textContent = s.kind === 'ai' ? 'Robo' + (color + 1) : (active ? 'Active' : (s.kind === 'human' ? 'Human' : ''));
      /* team badge */
      if (ref.team) {
        var ti = st.team ? st.team[i] : null;
        if (ti != null) {
          ref.team.textContent = (st.teamName && st.teamName[ti]) || ('Team ' + (ti + 1));
          ref.team.style.display = '';
          ref.team.setAttribute('data-ti', String(ti));
        } else {
          ref.team.textContent = '';
          ref.team.style.display = 'none';
        }
      }
      /* status */
      var status = seatStatus(st, i);
      ref.root.classList.toggle('active', active);
      ref.root.classList.toggle('inactive', !active);
      ref.root.classList.remove('status-offline', 'status-waiting', 'status-ai', 'status-turn');
      ref.root.classList.add(status.cls || 'status-waiting');
      /* show status text in the sub label */
      ref.sub.textContent = active ? status.text : (s.kind === 'ai' ? 'AI' : 'Waiting');
      /* homes */
      var homes = 0;
      for (var t = 0; t < 4; t++) if (st.tokens[i][t] === E.HOME) homes++;
      var hh = '';
      for (var k = 0; k < 4; k++) hh += '<i class="' + (k < homes ? 'on' : '') + '"></i>';
      ref.homes.innerHTML = hh;
      /* die interactivity */
      var handoffWait = !!(g && g.awaitingHandoff);
      var canRoll = active && localHuman && st.phase === 'roll' && !handoffWait;
      ref.dice.disabled = !canRoll;
      ref.dice.classList.toggle('dim', !active && !canRoll);
      ref.dice.classList.toggle('busy', !!(d && d.state === 'rolling' && active));
      ref.hint.classList.toggle('show', canRoll && (!d || d.state === 'ready' || d.state === 'done'));
      /* keep the die on the last shown value */
      setPips(ref.cube, lastPodValue[i] || 1);
      ref.cube.classList.toggle('rolling', !!(d && d.state === 'rolling' && active));
    }
    updateTurnChip(st);
  }
  function updateTurnChip(st) {
    var chip = $('turnChip'); if (!chip || !st) return;
    var seat = st.turn, s = st.seats[seat];
    var stateText = s.kind === 'ai' ? 'Thinking…' : (st.phase === 'move' ? 'Choose a pawn' : 'Tap to roll');
    chip.innerHTML = avatarHTML(s.avatar != null ? s.avatar : seat, 28) +
      '<div class="grow"><div class="t">' + esc(s.name || ('Player ' + (seat + 1))) + '</div>' +
      '<div class="s">' + stateText + '</div></div>';
  }

  /* updateHud: updates seat pods and the foot turn chip (no top pills bar) */
  function updateHud(d) {
    var g = activeMatch; if (!g) return;
    if (g.st) syncSeatPods(g.st, d);
  }

  function updateDice(d) {
    var g = activeMatch; if (!g || !g.st) return;
    var st = g.st, turn = st.turn, ref = podEls[turn];
    if (ref) {
      if (d && (d.state === 'rolling' || d.state === 'done')) {
        lastPodValue[turn] = d.value || lastPodValue[turn] || 1;
        setPips(ref.cube, lastPodValue[turn]);
      }
      ref.cube.classList.toggle('rolling', !!(d && d.state === 'rolling'));
      /* canInteract: only in roll phase, only the active human local seat */
      var canInteract = !!(st.phase === 'roll' && st.seats[turn].kind === 'human' && g.isLocalSeat(turn) &&
        (!d || d.state === 'ready' || d.state === 'done'));
      ref.dice.disabled = !canInteract;
      ref.dice.classList.toggle('busy', !!(d && d.state === 'rolling'));
      /* hint shows only when the player CAN roll */
      ref.hint.classList.toggle('show', canInteract && st.phase === 'roll');
    }
    syncSeatPods(st, d);
  }

  /* ---- shared match wiring for local + online ---------- */
  function wireMatch(g, cfg) {
    activeMatch = g;
    g.onEnd = function (r) { handleEnd(g, r); };
    g.onToast = function (d) { if (d && d.text) toast(d.text, d.kind || 'info', 'info'); };
    g.onAnnounce = function (d) { if (d) announce(d.text); };
    g.onAchievement = function (d) { handleAchievement(g, d); };
    g.onDice = function (d) { updateDice(d); };
    g.onTurn = function (d) { if (g.st) syncSeatPods(g.st, d); };
    g.onHud = function (d) { updateHud(d); };
    g.onHandoff = function (d) {
      var banner = $('handoffBanner'), ov = $('handoffOverlay');
      if (banner && d.seatInfo) {
        banner.classList.remove('hidden');
        banner.innerHTML = avatarHTML(d.seat.avatar != null ? d.seat.avatar : d.seat, 28) + '<span class="hb-name">' + esc(d.seatInfo.name) + '</span>';
      }
      if (ov && d.seatInfo) {
        ov.classList.remove('hidden');
        ov.innerHTML = '<div class="ho-card">' + avatarHTML(d.seat.avatar != null ? d.seat.avatar : d.seat, 88) +
          '<h2>' + esc(d.seatInfo.name) + '</h2><p>Pass the device to the next player.</p><div class="tapline">Tap to continue</div></div>';
      }
    };
    var banner = $('handoffBanner');
    if (banner) { banner.classList.add('hidden'); banner.onclick = function () { g.ackHandoff(); banner.classList.add('hidden'); }; }
    var ov = $('handoffOverlay');
    if (ov) { ov.classList.add('hidden'); ov.onclick = function () { g.ackHandoff(); ov.classList.add('hidden'); }; }
    if (g.st) { ensureSeatPods(g.st); syncSeatPods(g.st, null); }
  }

  function startMatch(cfg, savedState, dailyKey) {
    var canvas = $('board');
    var g = Game.start(canvas, cfg, savedState);
    wireMatch(g, cfg);
    if (cfg.mode !== 'online') { var nc = $('netChip'); if (nc) nc.classList.add('hidden'); }
    updateOfflineBadge();
    if (g.begin && g.pendingBegin) g.begin();
    show('scr-game', { dir: cfg.mode === 'online' ? 'present' : 'push' });
  }

  function setNetChip(state, text) {
    var chip = $('netChip'); if (!chip) return;
    chip.classList.remove('hidden');
    chip.setAttribute('data-net', state || 'connected');
    var tx = $('netChipText'); if (tx) tx.textContent = text || 'Connected';
  }
  function updateOfflineBadge() {
    var badge = $('offlineBadge'); if (!badge) return;
    var off = (typeof navigator !== 'undefined' && navigator.onLine === false);
    badge.classList.toggle('hidden', !off);
    if (off && activeMatch && activeMatch.cfg && activeMatch.cfg.mode !== 'online') { /* show */ }
  }

  /* ---- real gameplay achievements, only from live engine events ---- */
  function achievementToast(name, sub) {
    var host = $('achHost'); if (!host) return;
    var t = el('div', { class: 'ach-toast' });
    t.innerHTML = '<span class="ach-icon"><svg class="ic"><use href="#i-star"/></svg></span>' +
      '<span class="ach-body"><span class="ach-k">Achievement unlocked</span>' +
      '<span class="ach-n">' + esc(name) + '</span>' + (sub ? '<span class="ach-s">' + esc(sub) + '</span>' : '') + '</span>';
    host.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () { t.classList.add('out'); setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 320); }, 2800);
  }
  function handleAchievement(g, ev) {
    if (!ev || ev.seat == null || !ev.kind) return;
    var prof = getProfile();
    var s = g.st && g.st.seats[ev.seat];
    var isHuman = !!(s && s.kind === 'human');
    var youSeat = g.youSeat;
    /* only grant to the local profile: the human's own seat in AI/daily/online,
       or any human seat in pass & play (a single device owner plays them all). */
    var eligible = (youSeat != null) ? (ev.seat === youSeat) : isHuman;
    if (!eligible) return;
    var res = Profile.applyGameEvent(prof, { seat: ev.seat, kind: ev.kind, youSeat: ev.seat, extra: ev.extra || {} });
    saveProfile();
    if (res.newAchievements && res.newAchievements.length) {
      res.newAchievements.forEach(function (a) {
        var meta = Profile.ACHIEVEMENTS[a.id];
        achievementToast(meta ? meta.name : a.id, meta ? meta.desc : '');
      });
    }
  }

  function handleEnd(g, r) {
    var prof = getProfile();
    try {
      var youSeat = r.youSeat;
      var winnerSeat = r.winner;
      var youStats = youSeat != null && r.stats && r.stats[youSeat] ? r.stats[youSeat] : null;
      var hardWin = youSeat === winnerSeat && r.maxAiLevel === 2;
      var teamWin = r.teamWin != null ? r.teamWin : null;
      var youTeam = (r.team && youSeat != null) ? r.team[youSeat] : null;
      Profile.applyMatchResult(prof, {
        mode: r.mode, winnerSeat: winnerSeat, youSeat: youSeat,
        teamWin: teamWin, youTeam: youTeam,
        seatCount: r.seats.length, maxAiLevel: r.maxAiLevel, hardWin: hardWin,
        winnerName: r.seats[winnerSeat] ? r.seats[winnerSeat].name : '',
        seatNames: r.seats.map(function (s) { return s.name; }),
        durationS: r.durationS, you: youStats ? {
          captures: youStats.captures, sixes: youStats.sixes,
          timesCaptured: youStats.timesCaptured, turns: youStats.turns, homes: youStats.homes
        } : null
      });
      saveProfile();
    } catch (e) {}
    showEnd(r);
  }

  /* generate falling confetti into a host node */
  function confettiBurst(host) {
    if (!host) return;
    var colors = ['#EF4444', '#22C55E', '#FBBF24', '#3B82F6', '#FF7AB6', '#5FD8C7', '#F5C64C'];
    var n = 72, html = '', i;
    for (i = 0; i < n; i++) {
      var c = colors[i % colors.length];
      var x = (Math.random() * 100).toFixed(1);
      var delay = (Math.random() * 1.2).toFixed(2);
      var dur = (2.4 + Math.random() * 2.0).toFixed(2);
      var s = (6 + Math.random() * 8).toFixed(1);
      var rot = (Math.random() * 360).toFixed(0);
      var drift = ((Math.random() * 2 - 1) * 40).toFixed(1);
      html += '<i style="left:' + x + '%;width:' + s + 'px;height:' + (s * 0.5).toFixed(1) + 'px;background:' + c +
        ';animation-delay:' + delay + 's;animation-duration:' + dur + 's;--drift:' + drift + 'px;--rot:' + rot + 'deg"></i>';
    }
    host.innerHTML = html;
  }

  function showEnd(r) {
    var scr = $('scr-end'); if (!scr) return;
    var prof = getProfile(), lvl = Profile.levelFromXp(prof.xp).level;
    var isTeam = r.teamWin != null;
    var winTeamIdx = r.teamWin;
    var winnerSeat = r.winner != null ? r.winner : (r.rankings && r.rankings[0] != null ? r.rankings[0] : 0);
    var winnerName = r.seats && r.seats[winnerSeat] ? r.seats[winnerSeat].name : 'Player';
    var winnerColor = r.seats && r.seats[winnerSeat] ? r.seats[winnerSeat].color : 0;

    /* standings: in team mode, group by team; winners' team first */
    var ranked = r.rankings || r.seats.map(function (_, i) { return i; });
    var rows = ranked.map(function (seatIdx, i) {
      var s = r.seats[seatIdx];
      var teamBadge = '';
      var isWinMember = isTeam && r.team && r.team[seatIdx] === winTeamIdx;
      if (r.team && r.team[seatIdx] != null) {
        var tn = (r.teamName && r.teamName[r.team[seatIdx]]) || ('Team ' + (r.team[seatIdx] + 1));
        teamBadge = '<span class="rank-team' + (isWinMember ? ' win' : '') + '">' + esc(tn) + '</span>';
      }
      return '<div class="rank-row' + ((i === 0 || isWinMember) ? ' win' : '') + '">' +
        '<span class="pos ' + (i === 0 ? 'p1' : '') + '">' + (i + 1) + '</span>' +
        avatarHTML(s.avatar != null ? s.avatar : seatIdx, 30) +
        '<span class="t">' + esc(s.name || 'Name unavailable') + '</span>' + teamBadge +
        '<span class="stat"><svg class="ic"><use href="#i-home"/></svg>' + r.stats[seatIdx].homes + '</span></div>';
    }).join('');

    var title, sub;
    if (isTeam) {
      title = (r.teamName && r.teamName[winTeamIdx]) || ('Team ' + (winTeamIdx + 1));
      var members = r.seats.map(function (s, i) { return r.team[i] === winTeamIdx ? (s.name || 'Name unavailable') : null; })
        .filter(Boolean).join(' & ');
      title = (title + ' wins!');
      sub = 'Team-Up victory — ' + (members || title) + (r.mode === 'daily' ? ' · Daily' : '');
    } else {
      title = (winnerName || 'Player') + ' wins!';
      sub = r.mode === 'daily' ? 'Daily Challenge complete' : (r.mode === 'pass' ? 'Pass & Play' : 'Match over');
    }

    scr.innerHTML =
      '<div id="confetti"></div>' +
      '<div class="end-head" style="--win:' + colorCss(winnerColor) + '">' +
      avatarHTML((r.seats && r.seats[winnerSeat] && r.seats[winnerSeat].avatar != null) ? r.seats[winnerSeat].avatar : 0, 84) +
      '<div class="crown"><svg class="ic"><use href="#i-crown"/></svg></div>' +
      '<h2>' + esc(title) + '</h2>' +
      '<div class="sub">' + esc(sub) + '</div></div>' +
      '<div class="end-body">' + rows +
      '<div class="xp-block"><div class="xp-line"><span>Level ' + lvl + '</span><span>' + prof.xp + ' XP</span></div>' +
      '<div class="xp-bar"><i style="width:' + Math.min(100, (prof.xp % 100)) + '%"></i></div></div></div>' +
      '<div class="end-actions"><button class="btn btn-primary" id="endRematch"><svg class="ic"><use href="#i-refresh"/></svg> Play again</button>' +
      '<button class="btn btn-tint" id="endHome"><svg class="ic"><use href="#i-home"/></svg> Home</button></div>';
    $('endRematch').onclick = function () {
      var cfg = activeMatch ? activeMatch.cfg : null;
      if (cfg) { startMatch(cfg, null, cfg.dailyKey); } else goHome();
    };
    $('endHome').onclick = function () { goHome(); };
    confettiBurst($('confetti'));
    applyAppearance(); applyView();
    show('scr-end', { dir: 'present' });
  }

  /* ========================= screens ========================= */
  function renderHome() {
    var scr = $('scr-home'); if (!scr) return;
    var prof = getProfile();
    var lvl = Profile.levelFromXp(prof.xp).level;
    var saved = null;
    try { saved = Game.saved(); } catch (e) {}
    var continueCard = saved ? '<button class="card" id="btnContinue" style="width:100%;text-align:left">' +
      '<span class="t">Continue match</span><span class="s">' + esc((saved.cfg && saved.cfg.mode) || 'Quick Match') + '</span></button>' : '';
    var isInstalled = (typeof navigator !== 'undefined' && navigator.standalone === true) || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    var canInstall = !!installEvent && !isInstalled;
    var isIOS = typeof navigator !== 'undefined' && /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent) && !/CriOS/.test(navigator.userAgent);
    scr.innerHTML =
      '<div class="home-cols">' +
        '<div class="home-hero"><svg class="mark" viewBox="0 0 96 96"><use href="#i-pawn"/></svg>' +
          '<h1>Ludora</h1><p>Ludo · Tabletop</p></div>' +
        '<div class="home-side">' + continueCard +
          '<div class="home-actions">' +
            homeAction('btnQuick', 'i-bolt', 'Quick Match', 'vs smart AI', 0) +
            homeAction('btnPass', 'i-people', 'Pass & Play', 'one device, friends', 1) +
            homeAction('btnDaily', 'i-calendar', 'Daily Challenge', 'today\u2019s puzzle', 2) +
            homeAction('btnMp', 'i-swords', 'Play Online', 'peer-to-peer, no server', 3) +
          '</div>' +
          '<div class="home-foot">' +
            '<button class="btn btn-tint" id="btnProfile" style="--d:0"><svg class="ic"><use href="#i-user"/></svg>Profile</button>' +
            '<button class="btn btn-tint" id="btnRules" style="--d:1"><svg class="ic"><use href="#i-info"/></svg>Rules</button>' +
            '<button class="btn btn-tint" id="btnSettings" style="--d:2"><svg class="ic"><use href="#i-buzz"/></svg>Settings</button>' +
            (canInstall ? '<button class="btn btn-tint" id="btnInstall" style="--d:3"><svg class="ic"><use href="#i-download"/></svg>Install Ludora</button>' : '') +
          '</div>' +
          (isIOS && !isInstalled ? '<div class="ios-hint" style="font-size:11px;color:rgba(255,255,255,.7);margin-top:6px;text-align:center;">Add to Home Screen: tap Share, then Add to Home Screen</div>' : '') +
          '<div class="home-build">Ludora v' + APP_VERSION + '</div>' +
        '</div>' +
      '</div>';
    $('btnQuick').onclick = function () { navigate('scr-quick'); };
    $('btnPass').onclick = function () { navigate('scr-pass'); renderPass(); };
    $('btnDaily').onclick = function () { navigate('scr-daily'); renderDaily(); };
    $('btnMp').onclick = function () { navigate('scr-mp'); renderMp(); };
    $('btnProfile').onclick = function () { navigate('scr-profile'); renderProfile(); };
    $('btnRules').onclick = function () { navigate('scr-rules'); renderRules(); };
    $('btnSettings').onclick = function () { navigate('scr-settings'); renderSettings(); };
    var btnInstall = $('btnInstall');
    if (btnInstall) btnInstall.onclick = function () { if (installEvent) installEvent.prompt(); };
    var cont = $('btnContinue');
    if (cont) cont.onclick = function () {
      var pkt = Game.saved();
      if (pkt) startMatch(pkt.cfg, pkt.st, pkt.cfg && pkt.cfg.dailyKey);
    };
    applyAppearance(); applyView();
  }
  function homeAction(id, icon, title, sub, d) {
    return '<button class="btn btn-tint" id="' + id + '" style="--d:' + d + '">' +
      '<svg class="ic"><use href="#i-' + icon + '"/></svg>' +
      '<span class="grow"><span class="t">' + title + '</span><span class="s">' + sub + '</span></span>' +
      '<svg class="ic chev"><use href="#i-chev"/></svg></button>';
  }

  function renderQuick() {
    var scr = $('scr-quick'); if (!scr) return;
    var prof = getProfile();
    var theme = prof.cosmetics.board, diceT = prof.cosmetics.dice, tokenT = prof.cosmetics.token;
    var levels = [
      { id: 0, name: 'Easy' }, { id: 1, name: 'Medium' }, { id: 2, name: 'Hard' }
    ];
    var lineup = '<div class="ai-lineup" id="qLineup"><div class="ch">' + avatarHTML(0, 36) +
      '<span>' + esc(quickState.aiName) + '</span><span class="lvl">' + levels[quickState.aiLevel].name + '</span></div></div>';
    scr.innerHTML =
      '<div class="nav"><button class="navbtn" id="qBack"><svg class="ic"><use href="#i-back"/></svg></button>' +
      '<div class="title">Quick Match</div></div>' +
      '<div class="setup setup-body"><div class="label">Opponent</div>' + lineup +
      '<div class="label">Difficulty</div>' +
      '<div class="seg" id="qLevel" style="--n:3">' + levels.map(function (l, i) {
        return '<button data-v="' + l.id + '" class="' + (l.id === quickState.aiLevel ? 'on' : '') + '">' + l.name + '</button>';
      }).join('') + '</div>' +
      '<div class="diff-desc" id="qDiff">' + descFor(quickState.aiLevel) + '</div>' +
      '</div><div style="flex:1"></div>' +
      '<button class="btn btn-primary" id="qStart"><svg class="ic"><use href="#i-play"/></svg> Start game</button>';
    $('qBack').onclick = function () { back(); };
    $$('#qLevel button', scr).forEach(function (b) {
      b.onclick = function () {
        quickState.aiLevel = +b.dataset.v;
        $$('#qLevel button', scr).forEach(function (x) { x.classList.toggle('on', x === b); });
        $('qDiff').textContent = descFor(quickState.aiLevel);
      };
    });
    $('qStart').onclick = function () { startQuickMatch(); };
  }
  function descFor(lvl) {
    return lvl === 0 ? 'Relaxed. The AI plays loosely and often misses tactics.'
      : lvl === 1 ? 'Balanced. Solid moves with a little natural variance.'
      : 'Ruthless. Full evaluation, threat modelling, near-perfect play.';
  }
  function startQuickMatch() {
    var prof = getProfile();
    var cfg = {
      mode: 'quick',
      seats: [
        { color: quickState.color, kind: 'human', name: 'You', avatar: prof.avatar },
        { color: 2, kind: 'ai', name: quickState.aiName, ai: quickState.aiLevel }
      ],
      rules: {},
      theme: prof.cosmetics.board, dice: prof.cosmetics.dice, tokenShape: prof.cosmetics.token,
      youColor: quickState.color
    };
    startMatch(cfg, null, null);
  }

  function renderPass() {
    var scr = $('scr-pass'); if (!scr) return;
    var levels = [1, 2, 3, 4];
    scr.innerHTML =
      '<div class="nav"><button class="navbtn" id="pBack"><svg class="ic"><use href="#i-back"/></svg></button>' +
      '<div class="title">Pass & Play</div></div>' +
      '<div class="setup setup-body"><div class="label">Players</div>' +
      '<div class="seg" id="pCount" style="--n:4">' + levels.map(function (n) {
        return '<button data-n="' + n + '" class="' + (n === passState.count ? 'on' : '') + '">' + n + '</button>';
      }).join('') + '</div>' +
      '<div class="label">Mode</div>' +
      '<div class="seg" id="pTeam" style="--n:2">' +
        '<button data-t="0" class="' + (passState.team ? '' : 'on') + '">Classic</button>' +
        '<button data-t="1" class="' + (passState.team ? 'on' : '') + '">Team Up</button></div>' +
      '<div id="pTeamNote" class="mp-note hidden"></div>' +
      '<div id="teamPanel" class="team-panel' + (passState.team ? '' : ' hidden') + '"></div>' +
      '<div class="label">Seats</div><div id="pSeats"></div></div>' +
      '<div style="flex:1"></div>' +
      '<button class="btn btn-primary" id="pStart"><svg class="ic"><use href="#i-play"/></svg> Start game</button>';
    $('pBack').onclick = function () { back(); };
    $$('#pCount button', scr).forEach(function (b) {
      b.onclick = function () {
        passState.count = +b.dataset.n;
        $$('#pCount button', scr).forEach(function (x) { x.classList.toggle('on', x === b); });
        syncPassTeam();
        renderPassSeats();
      };
    });
    $$('#pTeam button', scr).forEach(function (b) {
      b.onclick = function () {
        var t = +b.dataset.t === 1;
        if (t && passState.count !== 4) {
          toast('Team-Up needs 4 players', 'info', 'info');
          return;
        }
        passState.team = t;
        $$('#pTeam button', scr).forEach(function (x) { x.classList.toggle('on', x === b); });
        syncPassTeam();
        renderPassSeats();
      };
    });
    syncPassTeam();
    renderPassSeats();
    $('pStart').onclick = function () { startPassMatch(); };
  }

  /* render the team panel + note, and gate the Start button when appropriate */
  function syncPassTeam() {
    var scr = $('scr-pass'); if (!scr) return;
    var panel = $('teamPanel'), note = $('pTeamNote');
    if (!panel) return;
    var isFour = passState.count === 4;
    if (passState.team && isFour) {
      if (note) note.classList.add('hidden');
      var tA = passState.teamNames[0] || 'Team A', tB = passState.teamNames[1] || 'Team B';
      var memA = passState.names[0].trim() || 'Player 1', memA2 = passState.names[2].trim() || 'Player 3';
      var memB = passState.names[1].trim() || 'Player 2', memB2 = passState.names[3].trim() || 'Player 4';
      panel.innerHTML =
        '<div class="team-card team-a"><div class="team-head"><input class="team-name" id="teamNameA" maxlength="12" value="' + esc(tA) + '" aria-label="Team A name">' +
        '<span class="team-members">' + esc(memA) + ' &amp; ' + esc(memA2) + '</span></div>' +
        '<div class="team-score">Team score <b id="teamScoreA">0</b> home</div></div>' +
        '<div class="team-card team-b"><div class="team-head"><input class="team-name" id="teamNameB" maxlength="12" value="' + esc(tB) + '" aria-label="Team B name">' +
        '<span class="team-members">' + esc(memB) + ' &amp; ' + esc(memB2) + '</span></div>' +
        '<div class="team-score">Team score <b id="teamScoreB">0</b> home</div></div>';
      var inA = $('teamNameA'), inB = $('teamNameB');
      if (inA) inA.addEventListener('input', function () { passState.teamNames[0] = inA.value || 'Team A'; });
      if (inB) inB.addEventListener('input', function () { passState.teamNames[1] = inB.value || 'Team B'; });
      panel.classList.remove('hidden');
    } else {
      panel.innerHTML = '';
      panel.classList.add('hidden');
      if (note) {
        if (passState.team && !isFour) {
          note.classList.remove('hidden');
          note.innerHTML = '<i class="ic" style="width:14px;height:14px;display:inline-block;vertical-align:-2px"></i> Switch to 4 players to use Team-Up.';
        } else note.classList.add('hidden');
      }
    }
  }
  function renderPassSeats() {
    var scr = $('scr-pass'); if (!scr) return;
    var host = $('pSeats'); if (!host) return;
    var html = '';
    for (var i = 0; i < passState.count; i++) {
      var c = passState.colors[i];
      var swatches = '';
      for (var ci = 0; ci < 4; ci++) {
        var on = passState.colors[i] === ci;
        swatches += '<button class="mini-swatch' + (on ? ' on' : '') + '" data-i="' + i + '" data-c="' + ci +
          '" style="background:' + colorCss(ci) + '" aria-label="Color ' + ci + '"></button>';
      }
      html += '<div class="seat-row" data-i="' + i + '">' +
        '<input class="mp-text" id="pName' + i + '" maxlength="18" value="' + esc(passState.names[i]) + '" aria-label="Player ' + (i + 1) + ' name">' +
        '<span class="mini-swatches">' + swatches + '</span></div>';
    }
    host.innerHTML = html;
    $$('#pSeats .mini-swatch', scr).forEach(function (sw) {
      sw.onclick = function () { swapPassColor(+sw.dataset.i, +sw.dataset.c); };
    });
    $$('#pSeats input', scr).forEach(function (inp) {
      inp.addEventListener('input', function () {
        passState.names[+inp.id.replace('pName', '')] = inp.value;
        syncPassTeam();
      });
    });
  }
  function swapPassColor(seat, color) {
    var holder = passState.colors[seat];
    var other = passState.colors.indexOf(color);
    if (other >= 0 && other !== seat) { passState.colors[other] = holder; }
    passState.colors[seat] = color;
    renderPassSeats();
  }
  function startPassMatch() {
    var prof = getProfile();
    var names = [];
    var seats = [];
    for (var i = 0; i < passState.count; i++) {
      var nm = passState.names[i] && passState.names[i].trim() ? passState.names[i].trim() : 'Player ' + (i + 1);
      names.push(nm);
      seats.push({ color: passState.colors[i], kind: 'human', name: nm, avatar: passState.avatars[i % 4] });
    }
    var cfg = {
      mode: 'pass',
      seats: seats,
      rules: {},
      theme: prof.cosmetics.board, dice: prof.cosmetics.dice, tokenShape: prof.cosmetics.token
    };
    if (passState.team && passState.count === 4) {
      /* Team A = P1+P3, Team B = P2+P4 (by seat order) */
      cfg.teams = [[0, 2], [1, 3]];
      cfg.teamNames = [passState.teamNames[0] || 'Team A', passState.teamNames[1] || 'Team B'];
      cfg.rules = { teamHomeTarget: 8 };
    }
    startMatch(cfg, null, null);
  }

  function renderDaily() {
    var scr = $('scr-daily'); if (!scr) return;
    var today = Profile.dateKey();
    var daily = Profile.dailyFor(today);
    dailyState = daily;
    var prof = getProfile();
    var doneToday = !!(prof.daily.done && prof.daily.done[today]);
    var streak = prof.daily.streak || 0;
    var cells = '';
    for (var i = 0; i < 7; i++) {
      var idx = streak - 6 + i;
      cells += streak >= i + 1 ? '<div class="streak-cell done"><svg class="ic"><use href="#i-check"/></svg></div>'
        : '<div class="streak-cell' + (idx === streak ? ' today' : '') + '">' + (i + 1) + '</div>';
    }
    scr.innerHTML =
      '<div class="nav"><button class="navbtn" id="dBack"><svg class="ic"><use href="#i-back"/></svg></button>' +
      '<div class="title">Daily</div></div>' +
      '<div class="daily-card"><div class="type">' + esc(daily.type) + '</div><h2>' + esc(daily.name) + '</h2>' +
      '<p class="desc">' + esc(daily.desc) + '</p>' +
      '<div class="reward"><svg class="ic"><use href="#i-gold"/></svg> Earn bonus XP</div></div>' +
      '<div class="label">Streak</div><div class="streak-strip">' + cells + '</div>' +
      '<div style="flex:1"></div>' +
      '<button class="btn btn-primary" id="dPlay"' + (doneToday ? ' disabled' : '') + '>' +
      '<svg class="ic"><use href="#i-play"/></svg> ' + (doneToday ? 'Completed today' : 'Play challenge') + '</button>';
    $('dBack').onclick = function () { back(); };
    var b = $('dPlay');
    if (b && !doneToday) b.onclick = function () { startDailyMatch(); };
  }
  function startDailyMatch() {
    var prof = getProfile();
    var cfg = {
      mode: 'daily',
      seats: dailyState.seats,
      rules: dailyState.rules || {},
      theme: prof.cosmetics.board, dice: prof.cosmetics.dice, tokenShape: prof.cosmetics.token,
      dailyKey: Profile.dateKey(), youColor: 0
    };
    startMatch(cfg, null, cfg.dailyKey);
  }

  function renderRules() {
    var scr = $('scr-rules'); if (!scr) return;
    scr.innerHTML =
      '<div class="nav"><button class="navbtn" id="rBack"><svg class="ic"><use href="#i-back"/></svg></button>' +
      '<div class="title">Rules</div></div>' +
      '<div class="rule"><div class="t">Goal</div><div class="d">Get all four tokens home first, or reach the capture target.</div></div>' +
      '<div class="rule"><div class="t">Roll</div><div class="d">Roll a six to release a token from the yard. A six grants an extra roll.</div></div>' +
      '<div class="rule"><div class="t">Capture</div><div class="d">Land on an opponent to send it back to its yard. Safe stars protect you.</div></div>' +
      '<div class="rule"><div class="t">Three sixes</div><div class="d">Three consecutive sixes forfeit the turn.</div></div>' +
      '<div class="rule"><div class="t">Lane</div><div class="d">Once in the home lane a token can never be captured.</div></div>';
    $('rBack').onclick = function () { back(); };
  }

  function renderProfile() {
    var scr = $('scr-profile'); if (!scr) return;
    var prof = getProfile();
    var lvl = Profile.levelFromXp(prof.xp).level;
    scr.innerHTML =
      '<div class="nav"><button class="navbtn" id="prBack"><svg class="ic"><use href="#i-back"/></svg></button>' +
      '<div class="title">Profile</div></div>' +
      '<div class="prof-head"><div class="lvl-ring"><svg viewBox="0 0 68 68"><circle cx="34" cy="34" r="28" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="4"/>' +
      '<circle cx="34" cy="34" r="28" fill="none" stroke="#EDEDF0" stroke-width="4" stroke-dasharray="176" stroke-dashoffset="' + (176 * (1 - (prof.xp % 100) / 100)) + '"/></svg><span class="n">' + lvl + '</span></div>' +
      '<div><div class="prof-name">' + esc(prof.name) + '</div>' +
      '<div class="prof-sub">' + prof.xp + ' XP</div></div></div>' +
      '<div class="label">Statistics</div>' +
      '<div class="stat-grid">' +
      statCell(prof.stats.matches, 'Matches') + statCell(prof.stats.wins, 'Wins') + statCell(prof.stats.bestStreak, 'Best Streak') +
      statCell(prof.stats.captures, 'Captures') + statCell(prof.stats.sixes, 'Sixes') + statCell(prof.stats.homes, 'Home') +
      '</div>' +
      '<div class="label">Recent</div>' +
      (prof.history.length ? historyHTML(prof.history) : '<div class="mp-note">No matches yet.</div>');
    $('prBack').onclick = function () { back(); };
  }
  function statCell(v, k) { return '<div class="stat-cell"><div class="n">' + v + '</div><div class="l">' + k + '</div></div>'; }
  function historyHTML(h) {
    var colors = { w: '#22C55E', l: '#EF4444', p: '#8B8FA3' };
    return '<div style="display:flex;flex-direction:column;gap:6px">' + h.slice(0, 8).map(function (e) {
      var res = e.result === 'w' ? 'w' : (e.result === 'l' ? 'l' : 'p');
      var label = e.result === 'w' ? 'Win' : (e.result === 'l' ? 'Loss' : 'Play');
      var modeText = e.mode === 'daily' ? 'Daily' : (e.mode === 'online' ? 'Online' : (e.mode === 'pass' ? 'Pass & Play' : 'Quick Match'));
      return '<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;background:var(--glass-bg);border:1px solid var(--glass-border)">' +
        '<span style="font-size:11px;font-weight:750;letter-spacing:.06em;color:' + colors[res] + '">' + label + '</span>' +
        '<div style="flex:1;min-width:0"><div style="font-size:13.5px;font-weight:640">' + esc(modeText) + '</div>' +
        '<div style="font-size:11px;color:var(--text-2)">' + esc(e.seatNames[0] || '') + '</div></div></div>';
    }).join('') + '</div>';
  }

  function renderSettings() {
    var scr = $('scr-settings'); if (!scr) return;
    var prof = getProfile();
    var s = prof.settings;
    if (s.sfxVol == null) s.sfxVol = 0.8;
    if (s.musicVol == null) s.musicVol = 0.4;
    var themes = [{ v: 'dark', n: 'Dark' }, { v: 'light', n: 'Light' }, { v: 'auto', n: 'Auto' }];
    var layouts = [{ v: 'phone', n: 'Phone' }, { v: 'tablet', n: 'Tablet' }, { v: 'desktop', n: 'Desktop' }, { v: 'auto', n: 'Auto' }];
    scr.innerHTML =
      '<div class="nav"><button class="navbtn" id="sBack"><svg class="ic"><use href="#i-back"/></svg></button>' +
      '<div class="title">Settings</div></div>' +
      '<div class="label">Appearance</div><div class="seg" id="setTheme" style="--n:3">' +
      themes.map(function (t) { return '<button data-v="' + t.v + '" class="' + (s.theme === t.v ? 'on' : '') + '">' + t.n + '</button>'; }).join('') + '</div>' +
      '<div class="label">Layout</div><div class="seg" id="setLayout" style="--n:4">' +
      layouts.map(function (l) { return '<button data-v="' + l.v + '" class="' + ((s.layout || 'auto') === l.v ? 'on' : '') + '">' + l.n + '</button>'; }).join('') + '</div>' +
      '<div class="label">Audio</div><div class="list">' +
      '<button class="list-row" id="optSound"><div class="tile t-gray" style="margin-right:4px"><svg class="ic ic-sm"><use href="#i-sound"/></svg></div><span class="t grow">Sound effects</span>' +
      '<span class="toggle' + (s.sound !== false ? ' on' : '') + '" id="togSound"></span></button>' +
      '<div class="list-row"><div class="tile t-gray" style="margin-right:4px"><svg class="ic ic-sm"><use href="#i-sound"/></svg></div><span class="t grow">SFX volume</span>' +
      '<div class="settings-range"><input type="range" id="sfxVol" min="0" max="1" step="0.05" value="' + (s.sfxVol || 0.8) + '">' +
      '<span class="val" id="sfxVolVal">' + Math.round((s.sfxVol || 0.8) * 100) + '</span></div></div>' +
      '<button class="list-row" id="optHaptics"><div class="tile t-gray" style="margin-right:4px"><svg class="ic ic-sm"><use href="#i-buzz"/></svg></div><span class="t grow">Vibration</span>' +
      '<span class="toggle' + (s.haptics !== false ? ' on' : '') + '" id="togHaptics"></span></button></div>' +
      '<div style="flex:1"></div>';
    $('sBack').onclick = function () { back(); };
    $$('#setTheme button', scr).forEach(function (b) {
      b.onclick = function () {
        s.theme = b.dataset.v;
        $$('#setTheme button', scr).forEach(function (x) { x.classList.toggle('on', x === b); });
        saveProfile(); applyAppearance();
      };
    });
    $$('#setLayout button', scr).forEach(function (b) {
      b.onclick = function () {
        s.layout = b.dataset.v;
        $$('#setLayout button', scr).forEach(function (x) { x.classList.toggle('on', x === b); });
        saveProfile(); applyView();
      };
    });
    var togSound = $('togSound');
    if (togSound) togSound.onclick = function () {
      s.sound = !(s.sound !== false); togSound.classList.toggle('on', s.sound !== false);
      saveProfile(); Audio2.setEnabled(s.sound !== false);
    };
    var sfxSlider = $('sfxVol');
    if (sfxSlider) sfxSlider.addEventListener('input', function () {
      s.sfxVol = parseFloat(sfxSlider.value);
      var vv = $('sfxVolVal'); if (vv) vv.textContent = Math.round(s.sfxVol * 100);
      if (Audio2.setVolume) Audio2.setVolume(s.sfxVol);
      saveProfile();
    });
    var togH = $('togHaptics');
    if (togH) togH.onclick = function () { s.haptics = !(s.haptics !== false); togH.classList.toggle('on', s.haptics !== false); saveProfile(); Audio2.setHaptics(s.haptics !== false); };
  }

  /* ========================= multiplayer ========================= */
  function mpSupported() {
    return !!(global.RTCPeerConnection || global.webkitRTCPeerConnection);
  }
  function renderMp() {
    var scr = $('scr-mp'); if (!scr) return;
    var supported = mpSupported();
    var supportHint = supported ? '' :
      '<div class="state-hint error" role="status"><svg class="ic"><use href="#i-unavailable"/></svg><span>WebRTC is' +
      ' not supported in this browser — online multiplayer is&nbsp;unavailable. You can still play offline.</span></div>';
    scr.innerHTML =
      '<div class="nav"><button class="navbtn" id="mpBack"><svg class="ic"><use href="#i-back"/></svg></button>' +
      '<div class="title">Multiplayer</div></div>' +
      '<div class="setup setup-body">' +
      '<div class="mp-note">Peer-to-peer over WebRTC. No account, no server — share an invite code and play directly.</div>' +
      supportHint +
      '<button class="btn btn-primary" id="mpCreate" style="margin-top:16px"><svg class="ic"><use href="#i-swords"/></svg> Create a room</button>' +
      '<div class="label">Join a game</div>' +
      '<textarea class="mp-input" id="mpJoinCode" placeholder="Paste an invite code or share link" aria-label="Invite code"></textarea>' +
      '<div id="mpStatus" class="state-hint hidden" role="status"></div>' +
      '<button class="btn btn-tint" id="mpConnect" style="margin-top:12px"><svg class="ic"><use href="#i-chev"/></svg> Connect</button>' +
      '</div>';
    $('mpBack').onclick = function () { back(); };
    $('mpCreate').onclick = function () { createRoom(); };
    var conn = $('mpConnect');
    conn.onclick = function () { connectToRoom(); };
    setMpStatus(null, null);
  }
  function setMpStatus(cls, msg) {
    var elx = $('mpStatus'); if (!elx) return;
    if (!msg) { elx.classList.add('hidden'); elx.innerHTML = ''; return; }
    var icon = cls === 'error' ? 'i-unavailable' : (cls === 'loading' ? 'i-loader' : (cls === 'ok' ? 'i-check' : 'i-info'));
    elx.classList.remove('hidden');
    elx.className = 'state-hint ' + (cls === 'loading' ? 'loading' : (cls || ''));
    elx.innerHTML = (cls === 'loading'
      ? '<span class="spinner"></span>'
      : '<svg class="ic"><use href="#' + icon + '"/></svg>') + '<span>' + esc(msg) + '</span>';
  }
  function createRoom() {
    var room = new Mp.Room({ size: 2, hostName: getProfile().name || 'Host', hostAvatar: getProfile().avatar || 0 });
    mpState.room = room;
    mpState.invite = {};
    room.onEvent = function (name, data) { roomEvent(name, data); };
    /* open an invite for seat 1 so others can join */
    room.inviteSeat(1).then(function (inv) {
      mpState.invite[1] = inv;
      renderRoom();
    }).catch(function () { renderRoom(); });
    navigate('scr-room');
    renderRoom();
  }
  function roomEvent(name, data) {
    if (name === 'seats') renderRoomSeats(false);
    if (name === 'start') { /* handled by guest side */ }
  }
  function renderRoom() {
    var scr = $('scr-room'); if (!scr || !mpState.room) return;
    var prof = getProfile();
    scr.innerHTML =
      '<div class="nav"><button class="navbtn" id="rBack" aria-label="Leave room"><svg class="ic"><use href="#i-back"/></svg></button>' +
      '<div class="title">Room</div></div>' +
      '<div style="text-align:center;padding:14px 0 4px"><div class="room-id-chip" id="roomIdChip">' + esc(mpState.room.id) + '</div>' +
      '<div class="mp-note">Share this room. Invite codes are per seat.</div></div>' +
      '<div class="label">Seats</div><div id="roomSeats"></div>' +
      '<div style="flex:1"></div>' +
      '<div class="row" style="gap:8px">' +
      '<button class="btn btn-tint" id="rCopyId"><svg class="ic"><use href="#i-share"/></svg> Copy ID</button>' +
      '<button class="btn btn-tint" id="rShareId"><svg class="ic"><use href="#i-share"/></svg> Share</button></div>' +
      '<button class="btn btn-primary" id="rStart" style="margin-top:12px"><svg class="ic"><use href="#i-play"/></svg> Start Match</button> ' +
      '<div style="flex:1"></div>';
    $('rBack').onclick = function () { goHome(); };
    $('rCopyId').onclick = function () { copyId(); };
    $('rShareId').onclick = function () { shareId(); };
    renderRoomSeats(true);
    var start = $('rStart');
    updateStartGate();
    if (start) start.onclick = function () { startOnlineMatch(); };
  }

  var seatSig = {};
  function seatSignature(room, i) {
    var seat = room.seats[i]; if (!seat) return 'gone';
    return seat.kind + '|' + (seat.name || '') + '|' + seat.connected + '|' + seat.ready;
  }
  function seatCardHTML(seat, i) {
    if (seat.kind === 'ai') {
      return '<div class="seat-card" id="seatCard' + i + '"><span class="role">AI</span>' + avatarHTML((seat.avatar != null ? seat.avatar : i), 38) +
        '<div class="grow"><div class="t">' + esc(seat.name || ('AI ' + (seat.seat + 1))) + '</div><div class="s">Ready</div></div>' +
        '<span class="state"><span class="dot on"></span>Ready</span></div>';
    }
    if (seat.kind === 'remote' && seat.connected) {
      return '<div class="seat-card" id="seatCard' + i + '"><span class="role">Player</span>' + avatarHTML((seat.avatar != null ? seat.avatar : i), 38) +
        '<div class="grow"><div class="t">' + esc(seat.name || ('Seat ' + seat.seat)) + '</div><div class="s">' + (seat.ready ? 'Ready' : esc(seat.name || ('Seat ' + seat.seat)) + ' connected') + '</div></div>' +
        '<span class="state"><span class="dot on"></span>' + (seat.ready ? 'Ready' : '…') + '</span></div>';
    }
    /* open seat → always show a reply box so the host can paste an answer */
    return '<div class="seat-card" id="inviteBox' + i + '" style="flex-direction:column;align-items:stretch;gap:8px">' +
      '<div class="row"><span class="role">Open</span><div class="grow"><div class="t">Seat ' + (seat.seat + 1) + '</div><div class="s">Waiting for a player</div></div></div>' +
      '<textarea class="mp-input" id="invAns' + i + '" placeholder="Paste the reply code here" aria-label="Reply code"></textarea>' +
      '<button class="btn btn-tint" id="invAccept' + i + '">Accept reply</button></div>';
  }
  function htmlToEl(html) {
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.firstChild;
  }
  function wireInviteBtn(i) {
    var bt = document.getElementById('invAccept' + i);
    if (bt) bt.onclick = function () {
      var sN = +this.id.replace(/\D+/g, '');
      var ta = document.getElementById('invAns' + sN);
      var code = ta ? ta.value.trim() : '';
      if (code) acceptInvite(sN, code);
    };
  }
  function renderRoomSeats(force) {
    var scr = $('scr-room'); if (!scr || !mpState.room) return;
    var host = $('roomSeats'); if (!host) return;
    var room = mpState.room;
    for (var i = 1; i < room.seats.length; i++) {
      var seat = room.seats[i];
      var sig = seatSignature(room, i);
      var changed = force || seatSig[i] !== sig;
      seatSig[i] = sig;
      var wantId = (seat.kind === 'ai' || (seat.kind === 'remote' && seat.connected)) ? 'seatCard' + i : 'inviteBox' + i;
      if (!changed && document.getElementById(wantId)) { wireInviteBtn(i); continue; }
      var oldSeat = document.getElementById('seatCard' + i);
      var oldInv = document.getElementById('inviteBox' + i);
      if (oldSeat) oldSeat.remove();
      if (oldInv) oldInv.remove();
      host.appendChild(htmlToEl(seatCardHTML(seat, i)));
      wireInviteBtn(i);
    }
    /* host seat */
    if (!document.getElementById('seatCard0')) {
      var hs = el('div', { class: 'seat-card', id: 'seatCard0' });
      hs.innerHTML = '<span class="role">Host</span>' + avatarHTML(room.seats[0].avatar || 0, 38) +
        '<div class="grow"><div class="t">' + esc(room.seats[0].name || 'Host') + '</div><div class="s">Connected</div></div>' +
        '<span class="state"><span class="dot on"></span>You</span>';
      host.appendChild(hs);
    }
    updateStartGate();
  }
  function updateStartGate() {
    var start = $('rStart'); if (!start || !mpState.room) return;
    var ok = mpState.room.allReady();
    start.disabled = !ok;
    if (ok) { start.classList.remove('disabled'); }
  }
  function copyId() {
    var room = mpState.room; if (!room) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(room.id).then(function () {
        toast('Room ID copied', 'good', 'info');
      }).catch(function () {
        toast('Copy failed — copy the code above', 'info', 'info');
      });
    } else {
      toast('Copy not supported here — copy the code above', 'info', 'info');
    }
  }
  function shareId() {
    var room = mpState.room, inv = mpState.invite[1];
    var code = inv ? inv.code : room.id;
    var url = location.origin + '/#j=' + code;
    if (navigator.share) {
      navigator.share({ title: 'Join my Ludora game', url: url }).catch(function () {});
    } else {
      toast('Sharing unsupported — share this code: ' + code, 'info', 'share');
    }
  }
  function acceptInvite(seat, code) {
    var room = mpState.room; if (!room) return;
    var peer = room.seats[seat] && room.seats[seat].peer;
    if (!peer) { toast('No pending invite for that seat', 'info', 'info'); return; }
    peer.acceptAnswer(code).then(function () {
      toast('Connected!', 'good', 'check');
    }).catch(function (e) { toast('That reply code did not work', 'info', 'info'); });
  }

  function connectToRoom() {
    var btn = $('mpConnect');
    var codeEl = $('mpJoinCode');
    var code = codeEl ? codeEl.value.trim() : '';
    if (mpState.connecting) return;
    if (!mpSupported()) { setMpStatus('error', 'WebRTC is not supported in this browser — online play is unavailable.'); return; }
    mpState.connecting = true;
    if (btn) btn.disabled = true;
    function release() { mpState.connecting = false; if (btn) btn.disabled = false; }
    if (!code) { setMpStatus('error', 'Paste an invite code or share link first.'); release(); return; }
    setMpStatus('loading', 'Connecting…');
    /* extract LUD-code from a full URL */
    var m = code.match(/LUD[01]\.[A-Za-z0-9_-]+/);
    if (m) code = m[0];
    try {
      var peer = new Net.Peer({ label: 'guest' });
      peer.acceptOffer(code).then(function (answer) {
        var guest = new Mp.Guest({ peer: peer, name: getProfile().name || 'Guest', avatar: getProfile().avatar || 0 });
        guest.token = null;
        guest.onEvent = function (name, data) { guestEvent(name, data); };
        /* re-use the offer for the answer: the peer keeps the host's seat/token */
        guest._offerAnswer = answer;
        var payload = { t: 'a', sdp: answer.sdp, room: '', seat: 0, secret: '' };
        return guest.peer.acceptAnswerPayload(payload);
      }).then(function () {
        setMpStatus('ok', 'Connected — waiting for the game to start.');
        toast('You are in!', 'good', 'check');
      }).catch(function (e) {
        setMpStatus('error', e && /unsupported|available/i.test(e.message) ? 'WebRTC is not available in this browser.' : 'Could not connect — check the code.');
        toast('Could not connect — check the code', 'info', 'info');
      }).finally(release);
    } catch (e) {
      setMpStatus('error', 'WebRTC is not available in this browser — online play is unavailable.');
      toast('WebRTC is not available here', 'info', 'info');
      release();
    }
  }
  function guestEvent(name, data) {
    if (name === 'welcome') { toast('Connected to room', 'good', 'check'); }
  }
  function startOnlineMatch() {
    var room = mpState.room; if (!room) return;
    if (!room.allReady()) { toast('Everyone must be ready first', 'info', 'info'); return; }
    var prof = getProfile();
    var cfg = room.buildCfg({ board: prof.cosmetics.board, dice: prof.cosmetics.dice, token: prof.cosmetics.token });
    var g = Game.start($('board'), cfg, null);
    g.netHost = room;
    room.match = g;
    wireMatch(g, cfg);
    setNetChip('connected', 'Connected');
    room.started();
    g.begin && g.begin();
    show('scr-game', { dir: 'present' });
  }

  /* ========================= PWA / install ========================= */
  function setInstallEvent(ev) { installEvent = ev; }
  function safeToReload() {
    var g = Game.active();
    if (g && !g.destroyed && g.st) {
      if (g.st.phase === 'over') return { safe: true };
      return { safe: false, reason: g.cfg && g.cfg.mode === 'online' ? 'online' : 'match' };
    }
    if (mpState.room && mpState.room.state !== 'closed') return { safe: false, reason: 'room' };
    return { safe: true };
  }
  function modeLabels() {
    return { quick: 'Quick Match', pass: 'Pass & Play', daily: 'Daily Challenge', online: 'Online Match' };
  }

  /* ========================= init ========================= */
  function init() {
    if (inited) return;
    inited = true;
    getProfile();
    Profile.loadProfile();
    renderHome();
    /* pre-render every static screen so navigation is instant and screens
       are never left empty even if the user jumps straight to one */
    renderQuick(); renderPass(); renderDaily(); renderMp();
    renderProfile(); renderRules(); renderSettings();
    show('scr-home');
    applyAppearance(); applyView();
    /* global navigation listeners */
    window.addEventListener('popstate', popstateHandler);
    document.addEventListener('touchstart', touchStart, { passive: true });
    document.addEventListener('touchend', touchEnd, { passive: true });
    /* connectivity (offline / back online) */
    window.addEventListener('online', onConnectivity);
    window.addEventListener('offline', onConnectivity);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) onConnectivity();
    /* default game overlay hide */
    var menu = $('pauseMenu'); if (menu) menu.classList.add('hidden');
    var pauseBtn = $('pauseBtn');
    if (pauseBtn) pauseBtn.onclick = function () { openPause(); };
    var pmR = $('pmResume'); if (pmR) pmR.onclick = function () { closePause(); };
    var pmQ = $('pmQuit'); if (pmQ) pmQ.onclick = function () { closePause(); goHome(); };
    /* clean continuation affordances */
    refreshHome();
  }
  function openPause() {
    var menu = $('pauseMenu'); if (!menu) return;
    var g = Game.active();
    if (g) g.pause();
    menu.innerHTML = '<div class="action-sheet">' +
      '<div class="as-caption">Paused</div>' +
      '<div class="as-group"><button class="as-row" id="pmResume"><svg class="ic"><use href="#i-play"/></svg> Resume</button>' +
      '<button class="as-row" id="pmQuit"><svg class="ic"><use href="#i-home"/></svg> Save &amp; quit</button></div></div>';
    $('pmResume').onclick = function () { closePause(); };
    $('pmQuit').onclick = function () { closePause(); goHome(); };
    menu.classList.remove('hidden');
    overlayOpen = true;
  }
  function closePause() {
    var menu = $('pauseMenu'); if (!menu) return;
    menu.classList.add('hidden');
    var g = Game.active();
    if (g) { try { g.resumePaused && g.resumePaused(); } catch (e) {} }
    overlayOpen = false;
  }
  function refreshHome() {
    var scr = $('scr-home'); if (!scr) return;
    if (inited) renderHome();
  }

  function onConnectivity() {
    var online = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    updateOfflineBadge();
    var nc = $('netChip');
    if (nc && !nc.classList.contains('hidden') && activeMatch && activeMatch.cfg && activeMatch.cfg.mode === 'online') {
      setNetChip(online ? 'connected' : 'offline', online ? 'Connected' : 'Offline — reconnecting');
    }
    if (online && mpState.room && mpState.room.state !== 'closed') {
      /* attempt a live re-sync with the room when the connection returns */
      try { if (mpState.room.online) mpState.room.online(); } catch (e) {}
    }
  }
  function toggleOfflineBadge(show) {
    var badge = $('offlineBadge'); if (badge) badge.classList.toggle('hidden', !show);
  }

  var UI = {
    APP_VERSION: APP_VERSION,
    init: init,
    show: show,
    goHome: goHome,
    refreshHome: refreshHome,
    profile: getProfile,
    reloadProfile: reloadProfile,
    applyAppearance: applyAppearance,
    applyView: applyView,
    toast: toast,
    safeToReload: safeToReload,
    setInstallEvent: setInstallEvent,
    modeLabels: modeLabels,
    nav: nav,
    _mpState: function () { return mpState; }
  };
  global.LudoraUI = UI;
  if (typeof module !== 'undefined' && module.exports) module.exports = global.LudoraUI;
})(typeof window !== 'undefined' ? window : globalThis);
