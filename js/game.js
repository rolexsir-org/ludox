/* =========================================================================
   Ludora — game.js
   Match controller: turn flow, dice, animation pipeline, AI scheduling,
   pass & play handoff, autosave/resume. Optimized for instant feel:
   ROLL → MOVE → RESULT → NEXT with no dead time.
   ========================================================================= */
(function (global) {
  'use strict';
  var E = global.LudoraEngine, Board = global.LudoraBoard, AI = global.LudoraAI,
      Audio2 = global.LudoraAudio, Store = global.LudoraStore;

  var G = null; // active match instance

  /* ---------- fair dice: crypto randomness, rejection sampled ---------- */
  function rollValue() {
    try {
      var a = new Uint8Array(1);
      for (;;) {
        crypto.getRandomValues(a);
        if (a[0] < 252) return (a[0] % 6) + 1;
      }
    } catch (e) { return 1 + Math.floor(Math.random() * 6); }
  }

  function Match() {
    this.st = null;           // engine state
    this.cfg = null;          // {mode, seats, theme, dice, tokenShape, youColor, dailyKey}
    this.canvas = null; this.ctx = null; this.staticCv = null;
    this.m = null; this.dpr = 1; this.cssS = 0;
    this.view = { anims: [], particles: [], halos: [], targets: [] };
    this.legal = [];          // current legal moves (when awaiting human choice)
    this.running = false; this.raf = 0; this.lastFrame = 0;
    this.timers = []; this.destroyed = false;
    this.lastHumanSeat = -1;
    this.awaitingHandoff = false;
    this.diceBusy = false;
    this.speed = 1;           // anim speed multiplier
    /* network play */
    this.netHost = null;      // Room (authoritative host)
    this.netGuest = null;     // Guest controller (render-only replica)
    this.netSeq = 0;
    this._idleFrame = false;
    this._drawList = [];      // reused buffer — no per-frame allocation
    this.reducedMotion = false;
    try {
      this.reducedMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {}
    if (this.reducedMotion) this.speed = 0.5;
  }

  Match.prototype.start = function (canvas, cfg, savedState) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cfg = cfg;
    if (savedState) {
      this.st = savedState;
      this.migrateResume();
    } else {
      this.st = E.createGame({ mode: cfg.mode, seats: cfg.seats, rules: cfg.rules, teams: cfg.teams, teamNames: cfg.teamNames });
    }
    var settings = (global.LudoraProfile && LudoraProfile.loadProfile().settings) || {};
    this.speed = settings.animSpeed === 'fast' ? 1 : 1.35;
    this.youSeat = this.findYouSeat();
    this.lastBegun = -1;
    this.arrivalPt = null;
    this._loopBound = this.loop.bind(this);
    this.resize(true);
    this.observeBoard();
    this.save();
    this.running = true;
    this.pendingBegin = true;
    this.raf = requestAnimationFrame(this._loopBound);
  };

  Match.prototype.observeBoard = function () {
    if (this.ro || typeof ResizeObserver === 'undefined') return;
    var self = this;
    this.ro = new ResizeObserver(function () { if (!self.destroyed) self.resize(); });
    this.ro.observe(this.canvas.parentElement);
  };

  /* Called by the UI after event handlers are attached. */
  Match.prototype.begin = function () {
    if (!this.pendingBegin || this.destroyed) return;
    this.pendingBegin = false;
    if (this.st.phase === 'move') this.representMovePhase();
    else this.enterTurn(true);
  };

  Match.prototype.migrateResume = function () {
    if (this.st.phase === 'move') {
      this.legal = E.legalMoves(this.st, this.st.lastRoll || 0);
      if (!this.legal.length) { this.st.phase = 'roll'; this.st.lastRoll = null; }
    }
  };

  /* ---------- layout ---------- */
  /* reserve a lane for each occupied board side so the four player pods can
     hug the board without covering it. */
  Match.prototype.occupiedSides = function () {
    var sides = { top: false, bottom: false, left: false, right: false };
    if (this.cfg && this.cfg.seats) {
      var laneMap = Board.SIDE_OF || ['bottom', 'left', 'top', 'right'];
      this.cfg.seats.forEach(function (s) { sides[laneMap[s.color] || 'bottom'] = true; });
    }
    return sides;
  };
  Match.prototype.podLanes = function () {
    var L = (Board && Board.podLanes) ? Board.podLanes() : { x: 104, y: 120 };
    var s = this.occupiedSides();
    return { x: (s.left ? L.x : 0) + (s.right ? L.x : 0), y: (s.top ? L.y : 0) + (s.bottom ? L.y : 0) };
  };
  Match.prototype.resize = function (force) {
    this.wake();
    var wrap = this.canvas.parentElement;
    var lanes = this.podLanes();
    /* small content padding on #boardWrap (left+right = 24, top+bottom = 10) */
    var PAD_X = 24, PAD_Y = 10;
    var availW, availH;
    if (wrap && wrap.clientWidth > 0 && wrap.clientHeight > 0) {
      availW = wrap.clientWidth - PAD_X - lanes.x;
      availH = wrap.clientHeight - PAD_Y - lanes.y;
    } else {
      /* layout not ready yet (early frame / hidden tab): sane fallback */
      var iw = global.innerWidth || 360, ih = global.innerHeight || 640;
      availW = Math.min(iw - 40, ih - 220);
      availH = availW;
    }
    var S = Math.max(160, Math.floor(Math.min(availW, availH)));
    if (!force && S === this.cssS && this.m) return;   // nothing to do
    this.cssS = S;
    this.dpr = Math.min(global.devicePixelRatio || 1, 2.5);
    this.canvas.style.width = S + 'px';
    this.canvas.style.height = S + 'px';
    this.canvas.width = Math.round(S * this.dpr);
    this.canvas.height = Math.round(S * this.dpr);
    this.m = Board.metrics(S);
    this.rebuildStatic();
  };
  Match.prototype.rebuildStatic = function () {
    var cv = this.staticCv = this.staticCv || document.createElement('canvas');
    cv.width = Math.round(this.cssS * this.dpr);
    cv.height = cv.width;
    var c = cv.getContext('2d');
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    Board.drawStatic(c, this.m, this.cfg.theme || 'ivory');
  };

  /* ---------- helpers ---------- */
  Match.prototype.after = function (ms, fn) {
    var self = this;
    var id = setTimeout(function () {
      var i = self.timers.indexOf(id);
      if (i >= 0) self.timers.splice(i, 1);
      if (!self.destroyed) fn();
    }, ms / this.speed + (ms >= 400 ? 20 : 0));
    this.timers.push(id);
    return id;
  };
  Match.prototype.clearTimers = function () {
    this.timers.forEach(clearTimeout);
    this.timers.length = 0;
  };
  Match.prototype.save = function () {
    if (this.st.phase === 'over') { Store.remove(Store.keys.match); return; }
    if (this.cfg.mode === 'online') return;   // host-authoritative: never resume online matches locally
    if (this.st.phase === 'anim') return; // keep the last stable save point
    Store.save(Store.keys.match, {
      v: 1, savedAt: Date.now(),
      cfg: this.cfg,
      st: this.st
    });
  };

  /* ---------- turn flow ---------- */
  Match.prototype.enterTurn = function (first) {
    if (this.destroyed || this.st.phase === 'over') return;
    this.wake();
    var seat = this.st.turn;
    var seatInfo = this.st.seats[seat];
    if (seat !== this.lastBegun) { E.beginsTurn(this.st); this.lastBegun = seat; }
    this.legal = [];
    this.view.halos = [];
    this.view.targets = [];
    this.emit('hud');
    this.emit('turn', { seat: seat, seatInfo: seatInfo });

    var needsHandoff = this.needsHandoff(seat);
    if (this.pauseRequested) { this.freezeNow(); return; }
    if (needsHandoff) {
      this.awaitingHandoff = true;
      this.emit('handoff', { seat: seat, seatInfo: seatInfo });
      return;
    }
    this.armRoll();
  };

  Match.prototype.freezeNow = function () {
    this.paused = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.save();
  };

  Match.prototype.needsHandoff = function (seat) {
    if (this.cfg.mode === 'online') return false;
    var s = (global.LudoraProfile && LudoraProfile.loadProfile().settings) || {};
    if (s.handoff !== 'quick' && s.handoff !== 'full') return false;   // 'off': never interrupt
    if (this.st.seats.length < 2) return false;
    var humans = this.st.seats.filter(function (s) { return s.kind === 'human'; }).length;
    if (humans < 2) return false; // single human device player: no ceremony
    var s = this.st.seats[seat];
    if (s.kind !== 'human') return false;
    return seat !== this.lastHumanSeat;
  };
  Match.prototype.ackHandoff = function () {
    if (!this.awaitingHandoff) return;
    this.awaitingHandoff = false;
    this.lastHumanSeat = this.st.turn;
    this.armRoll();
  };

  Match.prototype.armRoll = function () {
    if (this.destroyed || this.st.phase === 'over' || this.paused) return;
    var seat = this.st.turn, s = this.st.seats[seat];
    var self = this;
    if (this.netGuest) {
      /* guests are snapshot-driven; only their own turn arms the dice */
      if (this.isLocalSeat(seat) && s.kind === 'human') {
        this.emit('dice', { state: 'ready' });
        this.announce('Your turn — tap to roll');
      } else {
        this.emit('dice', { state: 'remote-wait' });
      }
      return;
    }
    if (s.kind === 'human') {
      if (this.seatIsRemote(seat)) {
        if (this.netHost && this.netHost.isSeatLive(seat)) {
          this.emit('dice', { state: 'remote-wait' });
          this.announce('Waiting for ' + s.name);
          return;
        }
        /* disconnected remote player: keep the game visibly moving */
        this.emit('dice', { state: 'remote-wait' });
        this.emit('toast', { text: s.name + ' is disconnected — turn skipped', kind: 'info' });
        this.announce(s.name + ' is disconnected, turn skipped');
        this.after(1100, function () { self.endTurnFlow(false); });
        return;
      }
      this.lastHumanSeat = seat;
      this.emit('dice', { state: 'ready' });
      this.announce(this.st.moveNo === 0 ? 'Your turn — tap to roll' : 'Your turn');
    } else {
      this.emit('dice', { state: 'ai-wait' });
      this.after(360 + Math.random() * 320, this.doRoll.bind(this));
    }
  };

  /* Emit a real gameplay achievement event to the UI. `kind` maps to a
     profile achievement. We only ever emit from actual engine transitions. */
  Match.prototype.gameEvent = function (seat, kind, extra) {
    if (this.destroyed || seat == null) return;
    this.emit('achievement', { seat: seat, kind: kind, youSeat: this.youSeat, extra: extra || {} });
  };

  Match.prototype.doRoll = function () {
    if (this.destroyed || this.diceBusy || this.st.phase !== 'roll') return;
    this.wake();
    this.diceBusy = true;
    this.legal = [];
    /* online: the roll comes from the host's PRE-COMMITTED dice batch so
       every peer can verify it (commit–reveal); offline: crypto RNG as always */
    var reveal = null;
    var value;
    if (this.netHost && this.netHost.nextDice) {
      reveal = this.netHost.nextDice();
      value = reveal.value;
    } else {
      value = rollValue();
    }
    this._diceReveal = reveal;
    var r = E.registerRoll(this.st, value);
    this.emit('dice', { state: 'rolling', value: value });
    Audio2.play('roll'); Audio2.haptic('roll');
    if (value === 6) {
      /* six achievements come only from a real 6 roll */
      var seatNow = this.st.turn;
      this.gameEvent(seatNow, 'six', { roll: value });
      if (this.st.sixChain >= 2) this.gameEvent(seatNow, 'doubleSix', { chain: this.st.sixChain });
    }
    var self = this;
    this.after(430, function () {
      if (self.destroyed || self.st.phase === 'over') return;   // match ended mid-roll
      self.diceBusy = false;
      Audio2.play('land', value); Audio2.haptic('land');
      self.announce(self.st.seats[self.st.turn].name + ' rolled ' + value);
      if (r.forfeit) {
        self.emit('toast', { text: 'Three sixes — turn passes', kind: 'info' });
        self.announce('Three sixes — turn passes');
        Audio2.play('noMove'); Audio2.haptic('noMove');
        self.netSyncHost('rolled', self._diceReveal ? { value: value, salt: self._diceReveal.salt, di: self._diceReveal.di, epoch: self._diceReveal.epoch } : { value: value, outcome: 'forfeit', seat: self.st.turn });
        self.after(560, function () { self.endTurnFlow(false); });
        return;
      }
      if (value === 6) { Audio2.play('six'); Audio2.haptic('six'); }
      self.legal = E.legalMoves(self.st, value);
      self.st.phase = 'move';
      self.save();
      if (!self.legal.length) {
        self.announce('No moves for ' + self.st.seats[self.st.turn].name);
        Audio2.play('noMove'); Audio2.haptic('noMove');
        self.netSyncHost('rolled', self._diceReveal ? { value: value, salt: self._diceReveal.salt, di: self._diceReveal.di, epoch: self._diceReveal.epoch } : { value: value, outcome: 'nomoves', seat: self.st.turn });
        self.after(600, function () { self.endTurnFlow(value === 6); });
        return;
      }
      var seat = self.st.turn, s = self.st.seats[seat];
      if (self.legal.length === 1) {
        self.view.halos = [self.legal[0].token];
        self.emit('hud');
        self.netSyncHost('rolled', self._diceReveal ? { value: value, salt: self._diceReveal.salt, di: self._diceReveal.di, epoch: self._diceReveal.epoch } : { value: value, outcome: 'auto', seat: seat });
        self.after(200, function () { self.executeMove(self.legal[0]); });
      } else if (s.kind === 'ai') {
        self.emit('hud', { thinking: true });
        self.netSyncHost('rolled', self._diceReveal ? { value: value, salt: self._diceReveal.salt, di: self._diceReveal.di, epoch: self._diceReveal.epoch } : { value: value, outcome: 'auto', seat: seat });
        self.after(AI.thinkDelay(s.ai), function () {
          self.executeMove(AI.chooseMove(self.st, seat, value, s.ai));
        });
      } else {
        self.view.halos = self.legal.map(function (mv) { return mv.token; });
        self.view.targets = self.legal.map(function (mv) { return mv; });
        self.emit('dice', { state: 'done', value: value });
        self.emit('hud');
        var mine = self.isLocalSeat(seat);
        self.netSyncHost('rolled', self._diceReveal ? { value: value, salt: self._diceReveal.salt, di: self._diceReveal.di, epoch: self._diceReveal.epoch } : { value: value, outcome: mine ? 'choose' : 'auto', seat: seat });
      }
    });
  };

  Match.prototype.executeMove = function (move) {
    if (this.destroyed) return;
    this.wake();
    if (this.netGuest) {
      /* guests never mutate state: forward the request, host will echo it back */
      if (this.st.phase === 'move' && this.isLocalSeat(this.st.turn) && move && isToken(move.token)) {
        this.netGuest.requestMove(move.token);
        this.view.halos = []; this.view.targets = [];
      }
      return;
    }
    /* defense-in-depth: even local callers must pass the engine's own
       legality check for the CURRENT position before anything mutates */
    if (this.st.phase !== 'move') return;
    var seatNow = this.st.turn;
    try {
      if (!E.assertMoveLegal(this.st, seatNow, move)) return;
    } catch (e) {
      /* a stray/malicious move must never crash the match */
      this.emit('toast', { text: 'Invalid move ignored', kind: 'info' });
      return;
    }
    this.view.halos = []; this.view.targets = [];
    this.st.phase = 'anim';
    this.arrivalPt = null;
    this.emit('hud');
    var seat = this.st.turn;
    var events = E.applyMove(this.st, move); // engine commits instantly; visuals follow
    if (E.isStrict && E.isStrict()) { try { E.assertInvariants(this.st); } catch (e) { this.emit('toast', { text: 'State error — match kept safe', kind: 'info' }); this.finish(); return; } }
    this.netSyncHost('moved', {
      seat: seat,
      move: { token: move.token, from: move.from, to: move.to },
      captures: events.captures, home: events.home, win: events.win,
      extra: (this.st.lastRoll === 6) || events.captures.length > 0 || events.home
    });
    this.animateMove(seat, move, events);
  };
  function isToken(v) { return typeof v === 'number' && v >= 0 && v <= 3 && Math.floor(v) === v; }

  Match.prototype.endTurnFlow = function (extra) {
    if (this.destroyed) return;
    if (this.st.phase === 'over') { this.finish(); return; }
    E.endTurn(this.st, extra);
    if (E.isStrict && E.isStrict()) { try { E.assertInvariants(this.st); } catch (e) { this.emit('toast', { text: 'State error — match kept safe', kind: 'info' }); } }
    this.save();
    this.emit('hud');
    this.netSyncHost('turn', { seat: this.st.turn, extra: !!extra });
    this.after(110, this.enterTurn.bind(this));
  };

  Match.prototype.finish = function () {
    if (this._finished) return;
    this._finished = true;
    this.announce(this.st.seats[this.st.winner] ? this.st.seats[this.st.winner].name + ' wins the match' : 'Match over');
    this.netSyncHost('end', { winner: this.st.winner, rankings: this.st.rankings });
    Store.remove(Store.keys.match);
    var st = this.st, cfg = this.cfg;
    var youSeat = this.findYouSeat();
    var maxAi = 0;
    st.seats.forEach(function (s) { if (s.kind === 'ai') maxAi = Math.max(maxAi, s.ai); });
    var durationS = Math.max(1, Math.round((Date.now() - st.startedAt) / 1000));
    /* in-game win achievements come from a real engine win */
    var wn = st.winner;
    if (wn != null) {
      this.gameEvent(wn, 'champion', {});
      var wStats = st.stats[wn];
      if (wStats && wStats.timesCaptured >= 3) this.gameEvent(wn, 'comeback', { timesCaptured: wStats.timesCaptured });
      if (wStats && wStats.timesCaptured === 0) this.gameEvent(wn, 'perfect', {});
      if (st.teamWin != null) this.gameEvent(wn, 'teamVictory', { team: st.teamWin });
    }
    this.emit('end', {
      winner: st.winner,
      rankings: st.rankings,
      seats: st.seats,
      stats: st.stats,
      tokens: st.tokens,
      mode: cfg.mode,
      teamWin: st.teamWin != null ? st.teamWin : null,
      team: st.team ? st.team : null,
      teamName: st.teamName ? st.teamName : null,
      dailyKey: cfg.dailyKey || null,
      youSeat: youSeat,
      maxAiLevel: maxAi,
      durationS: durationS,
      moveNo: st.moveNo
    });
  };

  Match.prototype.findYouSeat = function () {
    if (this.cfg.mode === 'pass') return null;
    if (this.cfg.mode === 'online' && this.netGuest) return this.cfg.netSeat;
    var self = this;
    var idx = null;
    this.st.seats.forEach(function (s, i) {
      if (s.kind === 'human' && (self.cfg.youColor == null || s.color === self.cfg.youColor)) idx = i;
    });
    return idx;
  };

  /* ---------- animation ---------- */
  Match.prototype.animateMove = function (seat, move, events) {
    var self = this;
    var path = events.path;
    var fromPt = this.tokenPoint(seat, move.token, move.from);
    var pts = [fromPt].concat(path.map(function (p) { return self.posPoint(seat, move.token, p); }));
    var per = this.speed > 1.2 ? 92 : 66;
    var anim = {
      kind: 'hop', seat: seat, token: move.token, pts: pts,
      t0: performance.now(), dur: Math.max(120, per * (pts.length - 1)), i: 0
    };
    this.view.anims.push(anim);
    var delay = anim.dur + 90;
    this.after(delay, function () {
      if (self.destroyed || self.st.phase === 'over') { if (!events.win) return; }
      var wait = 0;
      if (events.captures.length) {
        var at = self.arrivalPt || pts[pts.length - 1];
        events.captures.forEach(function (cap) {
          self.view.particles.push({
            kind: 'burst', x: at.x, y: at.y, t0: performance.now(), dur: 520,
            color: self.st.seats[cap.seat].color
          });
        });
        Audio2.play('capture'); Audio2.haptic('capture');
        self.announce(self.st.seats[seat].name + ' captured ' + self.st.seats[events.captures[0].seat].name);
        self.gameEvent(seat, 'capture', { n: events.captures.length });
        if (events.captures.length >= 2) self.gameEvent(seat, 'multiCapture', { n: events.captures.length });
        wait = 340;
      }
      if (events.home) {
        var ctr = Board.homeSlots(self.m, self.st.seats[seat].color)[0];
        self.view.particles.push({ kind: 'ripple', x: ctr.x, y: ctr.y, r0: self.m.cell * 0.5, t0: performance.now(), dur: 600 });
        Audio2.play('home'); Audio2.haptic('home');
        self.announce(self.st.seats[seat].name + ' brought a token home');
        self.gameEvent(seat, 'home', {});
        var allHome = self.st.tokens[seat].every(function (p) { return p === E.HOME; });
        if (allHome) self.gameEvent(seat, 'allHome', {});
        wait = Math.max(wait, 300);
      }
      self.after(wait, function () {
        if (events.win) { self.finishWin(); return; }
        var extra = (self.st.lastRoll === 6) || events.captures.length > 0 || events.home;
        self.emit('dice', { state: 'idle' });
        self.endTurnFlow(extra);
      });
    });
  };

  Match.prototype.finishWin = function () {
    var self = this;
    Audio2.play('win'); Audio2.haptic('win');
    var wn = this.st.winner;
    if (wn != null && this.m) {
      var ctr = Board.homeSlots(this.m, this.st.seats[wn].color)[0];
      this.view.particles.push({
        kind: 'ripple', x: ctr.x, y: ctr.y, r0: this.m.cell * 0.6, t0: performance.now(), dur: 900
      });
      this.view.particles.push({
        kind: 'burst', x: ctr.x, y: ctr.y, t0: performance.now(), dur: 700,
        color: this.st.seats[wn].color
      });
    }
    this.emit('dice', { state: 'idle' });
    this.after(760, function () { self.finish(); });
  };

  /* token position helpers */
  Match.prototype.homeOrder = function (seat, token) {
    var order = 0;
    for (var t = 0; t < token; t++) if (this.st.tokens[seat][t] === E.HOME) order++;
    return order;
  };
  Match.prototype.posPoint = function (seat, token, pos) {
    var color = this.st.seats[seat].color;
    var ho = pos === E.HOME ? this.homeOrder(seat, token) : null;
    var p = Board.pointForPos(this.m, color, pos, token, ho);
    return { x: p.x, y: p.y + this.m.cell * 0.16 };
  };
  Match.prototype.tokenPoint = function (seat, token, posOverride, isFrom) {
    var pos = posOverride != null ? posOverride : this.st.tokens[seat][token];
    return this.posPoint(seat, token, pos);
  };

  /* ---------- rendering ---------- */
  Match.prototype.loop = function (ts) {
    if (!this.running || this.destroyed) return;
    this.raf = requestAnimationFrame(this._loopBound);
    var now = typeof ts === 'number' ? ts : performance.now();
    if (!this.m) { this.resize(); if (!this.m) return; }

    /* Frame budgeting: when nothing animates (no hops, particles or a
       local player decision to pulse), draw one settled frame and stop
       painting — the loop ticks at ~zero cost until activity resumes. */
    var st = this.st;
    var deciding = st.phase !== 'over' && st.phase !== 'anim' &&
                   st.seats[st.turn].kind === 'human' && this.isLocalSeat(st.turn);
    var needsWork = this.view.anims.length > 0 || this.view.particles.length > 0 ||
                    (this.view.halos.length > 0 && st.phase === 'move') ||
                    (deciding && !this.reducedMotion);
    if (!needsWork && this._idleFrame) return;
    this._idleFrame = !needsWork;

    var ctx = this.ctx;
    var S = this.cssS;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);
    if (this.staticCv) ctx.drawImage(this.staticCv, 0, 0, S, S);

    var t = (needsWork ? now : 0) / 1000;

    if (deciding && st.phase !== 'anim') {
      Board.drawYardGlow(ctx, this.m, st.seats[st.turn].color, t);
    }

    /* victory shimmer: light up the winner's yard on the board once the
       match is over (celebration before the results screen takes over). */
    if (st.phase === 'over' && st.winner != null && st.seats[st.winner]) {
      Board.drawYardGlow(ctx, this.m, st.seats[st.winner].color, t * 1.7);
    }

    /* destination targets + halos for human choice */
    if (st.phase === 'move' && this.view.halos.length) {
      var self2 = this;
      this.view.targets.forEach(function (mv) {
        var cr = E.posToCell(st.seats[st.turn].color, mv.to);
        if (cr) Board.drawTarget(ctx, self2.m, cr, t);
        else if (mv.to === E.HOME) {           // exact home entry: mark the center
          var ctr = Board.homeSlots(self2.m, st.seats[st.turn].color)[0];
          Board.drawRipple(ctx, ctr.x, ctr.y, self2.m.cell * 0.5, 0.5 + 0.4 * Math.sin(t * 5));
        }
      });
    }

    /* tokens: static placement with stacking */
    var drawList = this._drawList;
    drawList.length = 0;
    var groups = {};
    var seatIdx, tk;
    for (seatIdx = 0; seatIdx < st.seats.length; seatIdx++) {
      for (tk = 0; tk < 4; tk++) {
        if (this.animFor(seatIdx, tk)) continue;
        var pos = st.tokens[seatIdx][tk];
        var pt = this.posPoint(seatIdx, tk, pos);
        var key;
        if (pos === E.HOME) key = 'home' + seatIdx + ':' + tk;
        else if (pos === E.YARD) key = 'yard' + seatIdx + ':' + tk;
        else key = 'c:' + pt.x.toFixed(1) + ',' + pt.y.toFixed(1);
        (groups[key] = groups[key] || []).push({ seat: seatIdx, token: tk, pt: pt, pos: pos });
      }
    }
    var cell = this.m.cell;
    var match = this;
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      var n = g.length;
      var sameSeat = g.every(function (e) { return e.seat === g[0].seat; });
      g.forEach(function (e, i) {
        var off = { x: 0, y: 0 }, scale = 1;
        if (n === 2) { off = { x: (i === 0 ? -0.14 : 0.14) * cell, y: -0.05 * cell }; scale = 0.95; }
        else if (n >= 3) {
          var r = Math.floor(i / 2), c = i % 2;
          off = { x: (c - 0.5) * 0.34 * cell, y: (r - (n > 3 ? 0.5 : 0)) * 0.28 * cell };
          scale = n >= 4 ? 0.78 : 0.85;
        }
        var isHome = e.pos === E.HOME;
        if (isHome) scale *= 0.52;
        drawList.push({
          x: e.pt.x + off.x, y: e.pt.y + off.y, seat: e.seat, token: e.token, scale: scale,
          halo: match.view.halos.indexOf(e.token) >= 0 && e.seat === st.turn && st.phase === 'move'
        });
        if (sameSeat && n >= 2 && i === 0) {
          drawList.push({ badge: true, x: e.pt.x + cell * 0.36, y: e.pt.y - cell * 0.58, n: n });
        }
      });
    });

    drawList.filter(function (d) { return !d.badge; }).sort(function (a, b) { return a.y - b.y; }).forEach(function (d) {
      var colorIdx = st.seats[d.seat].color;
      var lift = 0;
      if (d.halo) lift = 0.08 + 0.10 * Math.sin(t * 6 + d.token * 1.3);
      if (d.halo) Board.drawHalo(ctx, d.x, d.y, cell * 0.42, t, colorIdx);
      Board.drawToken(ctx, d.x, d.y, cell * 0.42, colorIdx, match.tokenShape(), { scale: d.scale, lift: lift });
    });
    drawList.filter(function (d) { return d.badge; }).forEach(function (d) {
      Board.drawCountBadge(ctx, d.x, d.y, d.n, cell);
    });

    /* movers */
    var self = this;
    this.view.anims = this.view.anims.filter(function (a) {
      var u = (now - a.t0) / a.dur;
      if (u >= 1) return false;
      var seg = (a.pts.length - 1) * Math.min(1, Math.max(0, u));
      var i = Math.min(a.pts.length - 2, Math.floor(seg));
      var f = seg - i;
      var p0 = a.pts[i], p1 = a.pts[i + 1];
      var hop = Math.sin(Math.PI * f);
      var x = p0.x + (p1.x - p0.x) * f;
      var y = p0.y + (p1.y - p0.y) * f - hop * cell * 0.5;
      var colorIdx = st.seats[a.seat].color;
      if (a.i !== i) { a.i = i; Audio2.play('step', i); }
      Board.drawToken(ctx, x, y, cell * 0.46, colorIdx, self.tokenShape(), { lift: 0.25 + hop * 0.5, scale: 1.02 });
      self.arrivalPt = { x: a.pts[a.pts.length - 1].x, y: a.pts[a.pts.length - 1].y };
      return true;
    });

    /* particles */
    this.view.particles = this.view.particles.filter(function (p) {
      var u = (now - p.t0) / p.dur;
      if (u >= 1) return false;
      if (p.kind === 'burst') Board.drawBurst(ctx, p.x, p.y, cell, p.color, u);
      if (p.kind === 'ripple') Board.drawRipple(ctx, p.x, p.y, p.r0, u);
      return true;
    });
  };
  Match.prototype.wake = function () { this._idleFrame = false; };
  Match.prototype.animFor = function (seat, token) {
    for (var i = 0; i < this.view.anims.length; i++) {
      var a = this.view.anims[i];
      if (a.seat === seat && a.token === token) return a;
    }
    return null;
  };
  Match.prototype.tokenShape = function () { return this.cfg.tokenShape || 'classic'; };

  /* ---------- network helpers ---------- */
  Match.prototype.isLocalSeat = function (seatIdx) {
    if (seatIdx == null || !this.st) return false;
    if (this.cfg.mode === 'online') {
      var mine = this.cfg.netSeat != null ? this.cfg.netSeat : 0;
      return seatIdx === mine;
    }
    return true;
  };
  Match.prototype.seatIsRemote = function (seatIdx) {
    if (this.cfg.mode !== 'online' || !this.st) return false;
    var color = this.st.seats[seatIdx].color;
    var meta = this.cfg.seats.filter(function (x) { return x.color === color; })[0];
    return !!(meta && meta.remote);
  };
  Match.prototype.announce = function (text) { this.emit('announce', { text: text }); };

  /* host: forward a validated guest roll request into the normal pipeline */
  Match.prototype.netGuestRoll = function (seatIdx) {
    if (this.destroyed || !this.netHost) return;
    if (this.st.phase !== 'roll' || this.diceBusy) return;
    this.doRoll();
  };
  /* host: apply a validated guest move through the same pipeline as local moves */
  Match.prototype.netGuestMove = function (seatIdx, move) {
    if (this.destroyed || !this.netHost) return;
    if (this.st.phase !== 'move') return;
    this.executeMove(move);
  };
  Match.prototype.netSyncHost = function (tag, fx) {
    if (this.netHost) this.netHost.sync(tag, fx);
  };
  /* host: a disconnected remote seat that owed a roll/move must not
     deadlock the match — skip their turn once detected */
  Match.prototype.netAdvanceDisconnected = function (seatIdx) {
    if (this.destroyed || !this.netHost || this.st.phase === 'over') return;
    if (this.st.turn !== seatIdx || !this.seatIsRemote(seatIdx)) return;
    if (this.netHost.isSeatLive(seatIdx)) return;
    if (this.st.phase !== 'roll' && this.st.phase !== 'move') return;   // let animations settle
    this.announce(this.st.seats[seatIdx].name + ' skipped — disconnected');
    this.endTurnFlow(false);
  };

  /* ---------- guest: apply an authoritative snapshot ----------
     Guests never run engine transitions. They swap in the validated state
     and replay the host's fx through the same visual pipeline the host
     used, so every device shows the same game. */
  Match.prototype.netApply = function (snap) {
    if (this.destroyed || !snap || !this.netGuest) return;
    this.wake();
    if (snap.seq <= this.netSeq) return;
    this.netSeq = snap.seq;
    var fx = snap.fx || {}, st = snap.st;
    var self = this;

    if (snap.tag === 'rolled') {
      this.st = st;
      this.legal = st.phase === 'move' ? E.legalMoves(st, st.lastRoll) : [];
      this.emit('dice', { state: 'rolling', value: fx.value });
      Audio2.play('roll'); Audio2.haptic('roll');
      this.after(430, function () {
        Audio2.play('land', fx.value); Audio2.haptic('land');
        self.announce(st.seats[st.turn].name + ' rolled ' + fx.value);
        if (fx.value === 6) { Audio2.play('six'); Audio2.haptic('six'); }
        if (fx.outcome === 'forfeit') {
          self.emit('toast', { text: 'Three sixes — turn passes', kind: 'info' });
          Audio2.play('noMove'); Audio2.haptic('noMove');
          return;
        }
        if (fx.outcome === 'nomoves') {
          Audio2.play('noMove'); Audio2.haptic('noMove');
          return;
        }
        if (fx.outcome === 'choose' && self.isLocalSeat(st.turn)) {
          self.view.halos = self.legal.map(function (mv) { return mv.token; });
          self.view.targets = self.legal;
          self.emit('dice', { state: 'done', value: fx.value });
          self.emit('hud');
          self.announce('Your move — pick a token');
        }
      });
      this.emit('hud');
      return;
    }

    if (snap.tag === 'moved') {
      this.st = st;
      var move = fx.move || { token: 0, from: 0, to: 0 };
      var events = {
        seat: fx.seat, move: move, path: E.pathPositions(move.from, move.to),
        captures: fx.captures || [], home: !!fx.home, win: !!fx.win
      };
      this.st.phase = 'anim';
      this.animateMoveVisual(fx.seat, move, events);
      return;
    }

    if (snap.tag === 'turn') {
      this.st = st;
      this.legal = [];
      this.view.halos = []; this.view.targets = [];
      this.emit('hud');
      this.emit('turn', { seat: st.turn, seatInfo: st.seats[st.turn] });
      this.armRoll();
      return;
    }

    if (snap.tag === 'end') {
      this.st = st;
      this.finish();
      return;
    }
  };

  /* visual-only move replay (no engine calls, no turn advancement) */
  Match.prototype.animateMoveVisual = function (seat, move, events) {
    var self = this;
    var fromPt = this.tokenPoint(seat, move.token, move.from);
    var pts = [fromPt].concat(events.path.map(function (p) { return self.posPoint(seat, move.token, p); }));
    var per = this.speed > 1.2 ? 92 : 66;
    var anim = { kind: 'hop', seat: seat, token: move.token, pts: pts,
                 t0: performance.now(), dur: Math.max(120, per * (pts.length - 1)), i: 0 };
    this.view.anims.push(anim);
    this.arrivalPt = null;
    this.after(anim.dur + 90, function () {
      var wait = 0;
      if (events.captures.length) {
        var at = self.arrivalPt || pts[pts.length - 1];
        events.captures.forEach(function (cap) {
          self.view.particles.push({
            kind: 'burst', x: at.x, y: at.y, t0: performance.now(), dur: 520,
            color: self.st.seats[cap.seat].color
          });
        });
        Audio2.play('capture'); Audio2.haptic('capture');
        self.announce(self.st.seats[seat].name + ' captured ' + self.st.seats[events.captures[0].seat].name);
        wait = 340;
      }
      if (events.home) {
        var ctr = Board.homeSlots(self.m, self.st.seats[seat].color)[0];
        self.view.particles.push({ kind: 'ripple', x: ctr.x, y: ctr.y, r0: self.m.cell * 0.5, t0: performance.now(), dur: 600 });
        Audio2.play('home'); Audio2.haptic('home');
        self.announce(self.st.seats[seat].name + ' brought a token home');
        wait = Math.max(wait, 300);
      }
      self.emit('hud');
    });
  };

  /* ---------- input ---------- */
  Match.prototype.hitTest = function (px, py) {
    if (this.st.phase !== 'move' || this.st.seats[this.st.turn].kind !== 'human' || !this.legal.length) return null;
    var cell = this.m.cell, best = null, bestD = cell * 0.75;
    var self = this;
    var cand = {};
    this.legal.forEach(function (mv) { cand[mv.token] = mv; });
    Object.keys(cand).forEach(function (tk) {
      var mv = cand[tk];
      var pt = self.posPoint(self.st.turn, +tk, self.st.tokens[self.st.turn][+tk]);
      var d = Math.hypot(px - pt.x, py - (pt.y - cell * 0.35));
      if (d < bestD) { bestD = d; best = mv; }
    });
    return best;
  };

  Match.prototype.pointerDown = function (ev) {
    if (this.destroyed) return;
    var rect = this.canvas.getBoundingClientRect();
    var x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    var mv = this.hitTest(x, y);
    if (mv) { Audio2.play('tap'); this.executeMove(mv); }
  };

  Match.prototype.rollRequest = function () {
    if (this.destroyed || this.st.phase !== 'roll') return;
    var s = this.st.seats[this.st.turn];
    if (s.kind !== 'human' || this.diceBusy || this.awaitingHandoff) return;
    if (this.netGuest) {
      if (this.isLocalSeat(this.st.turn)) this.netGuest.requestRoll();
      return;
    }
    this.doRoll();
  };

  Match.prototype.diceForSelection = function (n) { // keyboard 1..4
    if (this.st.phase !== 'move' || this.st.seats[this.st.turn].kind !== 'human') return;
    var mv = this.legal.filter(function (m) { return m.token === n - 1; })[0];
    if (mv) this.executeMove(mv);
  };

  /* ---------- lifecycle ---------- */
  Match.prototype.pause = function () {
    if (this.destroyed || this.paused) return;
    var st = this.st;
    var waitingDice = st.phase === 'roll' && st.seats[st.turn].kind === 'human';
    var choosing = st.phase === 'move' && st.seats[st.turn].kind === 'human';
    if (waitingDice || choosing || this.awaitingHandoff) {
      /* stable point: safe to freeze outright */
      this.clearTimers();
      this.view.anims = [];
      this.freezeNow();
    } else {
      /* AI turn or animation in flight: let it settle, then freeze */
      this.pauseRequested = true;
    }
  };
  Match.prototype.resumePaused = function () {
    if (this.destroyed || !this.paused) { this.pauseRequested = false; return; }
    this.paused = false;
    this.pauseRequested = false;
    this.running = true;
    this.diceBusy = false;
    this.loop(performance.now());
    var st = this.st;
    if (this.awaitingHandoff) return;           // overlay still up until acked
    if (st.phase === 'move' && st.seats[st.turn].kind === 'human') {
      this.representMovePhase();
      this.emit('dice', { state: 'done', value: st.lastRoll });
    } else if (st.phase === 'roll' && this.needsHandoff(st.turn)) {
      this.awaitingHandoff = true;
      this.emit('handoff', { seat: st.turn, seatInfo: st.seats[st.turn] });
    } else {
      this.armRoll();
    }
  };
  Match.prototype.representMovePhase = function () {
    var self = this;
    this.legal = E.legalMoves(this.st, this.st.lastRoll);
    if (!this.legal.length) { this.st.phase = 'roll'; this.st.lastRoll = null; this.armRoll(); return; }
    if (this.legal.length === 1) {
      this.after(220, function () { self.executeMove(self.legal[0]); });
    } else if (this.st.seats[this.st.turn].kind === 'ai') {
      this.after(AI.thinkDelay(this.st.seats[this.st.turn].ai), function () {
        self.executeMove(AI.chooseMove(self.st, self.st.turn, self.st.lastRoll, self.st.seats[self.st.turn].ai));
      });
    } else {
      this.view.halos = this.legal.map(function (mv) { return mv.token; });
      this.view.targets = this.legal;
      this.emit('hud');
      if (this.st.seats[this.st.turn].kind === 'human') {
        this.emit('dice', { state: 'done', value: this.st.lastRoll });
      }
    }
  };

  Match.prototype.emit = function (name, data) {
    var cb = this['on' + name.charAt(0).toUpperCase() + name.slice(1)];
    if (typeof cb === 'function') cb(data);
  };

  Match.prototype.destroy = function () {
    this.destroyed = true;
    this.running = false;
    this.clearTimers();
    cancelAnimationFrame(this.raf);
    if (this.ro) { try { this.ro.disconnect(); } catch (e) {} this.ro = null; }
  };

  /* ---------- module API ---------- */
  var Game = {
    active: function () { return G; },
    _Match: Match,   /* exposed for headless multiplayer tests */
    start: function (canvas, cfg, savedState) {
      if (G) G.destroy();
      G = new Match();
      G.start(canvas, cfg, savedState);
      return G;
    },
    destroy: function () { if (G) { G.destroy(); G = null; } },
    saved: function () {
      var pkt = Store.load(Store.keys.match, function (o) {
        if (!o || o.v !== 1 || !o.cfg || !o.st) return false;
        return !!E.validateState(o.st);
      });
      return pkt;
    }
  };
  global.LudoraGame = Game;
})(typeof window !== 'undefined' ? window : globalThis);
