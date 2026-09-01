/* =========================================================================
   Ludora — mp.js
   Host-authoritative online multiplayer protocol over WebRTC DataChannels.

   Trust model (honest, client-side only — there is no server):
   · The HOST owns the only authoritative game state. It is created and
     mutated exclusively through the existing rules engine (engine.js).
   · Guests render snapshots; their inputs are REQUESTS that the host
     validates (right seat? right phase? legal move?) before applying.
   · Every state message carries a monotonically increasing sequence
     number; stale or duplicate snapshots are ignored by guests.
   · Dice are generated on the host with the existing crypto RNG and ride
     the same synchronized stream — no client ever picks its own roll.
   · Messages are strict JSON with whitelisted shapes, bounds checks and
     flood limits. No executable data, no HTML, no eval — rendering goes
     through the existing escaping.
   · Each seat has its own secret embedded in that seat's invite code;
     possession of a code is room access (share codes carefully). This is
     session authentication, NOT a claim of server-side anti-cheat.
   ========================================================================= */
(function (global) {
  'use strict';
  var Net = global.LudoraNet, E = global.LudoraEngine, Sha = global.LudoraSha;

  var PROTO = 1;
  var PING_EVERY = 2500, PING_TIMEOUT = 9000;
  var DICE_BATCH = 600;              // committed rolls per epoch (~41 KB, fits MAX_MSG with headroom)
  var ELECT_BASE = 1000, ELECT_STEP = 450;   // host-election backoff per seat
  var MAX_NAME = 16;
  /* protocol clock — injectable so tests get deterministic keepalive/flood behavior */
  var nowMs = function () { return Date.now(); };

  function sanitizeName(s) {
    s = String(s == null ? '' : s)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_NAME);
    return s || 'Player';
  }
  function isInt(v, lo, hi) { return typeof v === 'number' && Math.floor(v) === v && v >= lo && v <= hi; }

  /* Every field a guest needs to safely start a match. Untrusted input. */
  function validateNetCfg(cfg) {
    try {
      if (!cfg || typeof cfg !== 'object') return false;
      if (cfg.mode !== 'online') return false;
      if (!Array.isArray(cfg.seats) || cfg.seats.length < 2 || cfg.seats.length > 4) return false;
      var colors = [];
      for (var i = 0; i < cfg.seats.length; i++) {
        var s2 = cfg.seats[i];
        if (!s2 || typeof s2 !== 'object') return false;
        if (!isInt(s2.color, 0, 3) || colors.indexOf(s2.color) >= 0) return false;
        colors.push(s2.color);
        if (s2.kind !== 'human' && s2.kind !== 'ai') return false;
        if (typeof s2.name !== 'string' || s2.name.length < 1 || s2.name.length > 16) return false;
        if (s2.avatar != null && !isInt(s2.avatar, 0, 7)) return false;
        if (s2.kind === 'ai' && !isInt(s2.ai, 0, 2)) return false;
      }
      if (cfg.rules != null) {
        if (typeof cfg.rules !== 'object') return false;
        if (cfg.rules.firstToCaptures != null && !isInt(cfg.rules.firstToCaptures, 0, 12)) return false;
      }
      ['theme', 'dice', 'tokenShape'].forEach(function (k) {
        if (cfg[k] != null && !/^[a-z]{2,12}$/.test(String(cfg[k]))) throw new Error('cfg.' + k);
      });
      if (cfg.youColor != null && !isInt(cfg.youColor, 0, 3)) return false;
      return true;
    } catch (e) { return false; }
  }

  /* ======================================================================
     Room — host side
     ====================================================================== */
  function Room(opts) {
    opts = opts || {};
    this.id = opts.id || Net.roomId();
    this.size = isInt(opts.size, 2, 4) ? opts.size : 2;
    this.peerFactory = opts.peerFactory || null;      // injectable (tests)
    this.onEvent = opts.onEvent || function () {};    // UI hook
    this.seats = [];
    this.state = 'lobby';                             // lobby | playing | closed
    this.seq = 0;
    this.match = null;                                // host Match once playing
    this._pingTimer = null;
    this._flood = {};
    for (var i = 0; i < this.size; i++) {
      this.seats.push({
        seat: i, color: i,
        kind: i === 0 ? 'host' : (opts.aiSeats && opts.aiSeats[i] ? 'ai' : 'open'),
        ai: (opts.aiSeats && isInt(opts.aiSeats[i], 0, 2)) ? opts.aiSeats[i] : 1,
        name: i === 0 ? (opts.hostName || 'Host') : null,
        avatar: i === 0 ? (opts.hostAvatar || 0) : null,
        ready: i === 0 ? true : false,
        connected: i === 0,
        token: i === 0 ? Net.secret() : null,
        peer: null, disconnectedAt: 0
      });
    }
    this._startPing();
  }

  Room.prototype.emit = function (name, data) { try { this.onEvent(name, data); } catch (e) {} };
  Room.prototype.seatsPublic = function () {
    return this.seats.map(function (s) {
      return { seat: s.seat, color: s.color, kind: s.kind, ai: s.ai, name: s.name,
               avatar: s.avatar, ready: s.ready, connected: s.connected };
    });
  };
  Room.prototype.broadcast = function (msg) {
    this.seats.forEach(function (s) {
      if (s.kind === 'remote' && s.connected && s.peer) s.peer.send(msg);
    });
  };
  Room.prototype.isSeatLive = function (seatIdx) {
    var s = this.seats[seatIdx];
    return !s || s.kind !== 'remote' ? true : s.connected;
  };

  /* ---- invite lifecycle ---- */
  Room.prototype.inviteSeat = function (seatIdx) {
    var self = this;
    var s = this.seats[seatIdx];
    if (!s || s.kind !== 'open') return Promise.reject(new Error('Seat is not open'));
    if (s.peer) { try { s.peer.close(); } catch (e) {} s.peer = null; }
    var token = Net.secret();
    var peer = this.peerFactory ? this.peerFactory() : new Net.Peer({ label: 'seat' + seatIdx });
    s.pendingToken = token;
    return peer.createOffer({ room: this.id, seat: seatIdx, secret: token }).then(function (code) {
      s.peer = peer;
      s.pendingKind = 'remote';
      self._wirePeer(s, peer, token);
      return { code: code, token: token };
    });
  };
  /* tests / reinvite: attach an already-paired transport to a seat */
  Room.prototype.bindPeer = function (seatIdx, peer, token) {
    var s = this.seats[seatIdx];
    if (!s || s.kind === 'closedSeat') return;
    s.kind = 'remote';
    s.token = token;
    s.peer = peer;
    this._wirePeer(s, peer, token);
  };
  Room.prototype._wirePeer = function (s, peer, token) {
    var self = this;
    s.token = token;
    peer.onmessage = function (raw) { self._onGuestRaw(s, raw); };
    peer.onstate = function (st2) {
      s.netState = st2;   // 'connected' | 'reconnecting' | 'lost'
      self.emit('seatNet', { seat: s.seat, state: st2 });
    };
    peer.onclose = function () { self._seatDisconnected(s); };
    if (peer.open && !s.connected) {
      /* transport already open (virtual net) — wait for hello like normal */
    }
  };
  Room.prototype._seatDisconnected = function (s) {
    if (this.state === 'closed' || !s.connected) return;
    s.connected = false;
    s.ready = false;
    s.disconnectedAt = nowMs();
    this.emit('seats', this.seatsPublic());
    this.broadcast({ m: 'seats', seats: this.seatsPublic() });
    if (this.state === 'playing') {
      this.broadcast({ m: 'status', text: s.name + ' disconnected', seat: s.seat });
      this.emit('disconnect', { seat: s.seat, name: s.name });
      /* if they owed the current action, free the turn shortly after */
      var self2 = this;
      var seatIdx = s.seat;
      setTimeout(function () {
        if (self2.state === 'playing' && self2.match && self2.match.netAdvanceDisconnected) {
          self2.match.netAdvanceDisconnected(seatIdx);
        }
      }, 1400);
    }
  };

  /* ---- guest message intake: validate everything, trust nothing ---- */
  Room.prototype._onGuestRaw = function (s, raw) {
    if (typeof raw !== 'string' || raw.length > Net.MAX_MSG) return this._strike(s, 'oversize');
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return this._strike(s, 'malformed'); }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return this._strike(s, 'malformed');
    var t = msg.m;
    var ok =
      t === 'hello' || t === 'ready' || t === 'roll' || t === 'move' ||
      t === 'pong' || t === 'leave' ||
      t === 'intro-offer' || t === 'intro-answer';
    if (!ok) return this._strike(s, 'unknown-type');

    /* flood guard */
    var now = nowMs();
    var f = this._flood[s.seat] = this._flood[s.seat] || { n: 0, t: now };
    if (now - f.t > 1000) { f.n = 0; f.t = now; }
    if (++f.n > 25) return this.kick(s.seat, 'flood');

    if (t === 'hello') {
      if (typeof msg.token !== 'string' || msg.token !== s.token) return this._strike(s, 'bad-token');
      if (msg.v !== PROTO) { s.peer.send({ m: 'error', code: 'version' }); return; }
      var name = sanitizeName(msg.name);
      var avatar = isInt(msg.avatar, 0, 7) ? msg.avatar : 0;
      var isReconnect = s.kind === 'remote' && s.name && !s.connected;
      s.kind = 'remote';
      s.name = isReconnect ? s.name : name;
      s.avatar = isReconnect ? s.avatar : avatar;
      s.connected = true;
      s.disconnectedAt = 0;
      s.peer.send({ m: 'welcome', room: this.id, seat: s.seat, seats: this.seatsPublic(),
                    resume: isReconnect, proto: PROTO });
      this.emit('seats', this.seatsPublic());
      this.broadcast({ m: 'seats', seats: this.seatsPublic() });
      this.introduceMesh();
      if (isReconnect) {
        this.emit('reconnect', { seat: s.seat });
        if (this.state === 'playing' && this.match) {
          s.peer.send({ m: 'start', cfg: this.match.cfg, st: this.match.st,
                        yourSeat: s.seat, seq: this.seq, resume: true });
        }
        this.broadcast({ m: 'status', text: s.name + ' reconnected', seat: s.seat });
      }
      return;
    }
    if (t === 'leave') { this.kick(s.seat, 'bye'); return; }
    /* mesh relay: the host only forwards strictly-shaped payloads between
       already-connected guests — it never interprets them */
    if (t === 'intro-offer') {
      if (!isInt(msg.to, 0, 3) || msg.to === s.seat) return this._strike(s, 'bad-intro');
      var dest = this.seats[msg.to];
      if (!dest || !dest.connected || dest.kind !== 'remote') return;   // target gone: ignore
      if (!validMeshPayload(msg.payload, this.id)) return this._strike(s, 'bad-intro');
      dest.peer.send({ m: 'intro-in', from: s.seat, payload: msg.payload });
      return;
    }
    if (t === 'intro-answer') {
      if (!isInt(msg.to, 0, 3) || msg.to === s.seat) return this._strike(s, 'bad-intro');
      var dest2 = this.seats[msg.to];
      if (!dest2 || !dest2.connected || dest2.kind !== 'remote') return;
      if (!validMeshPayload(msg.payload, this.id)) return this._strike(s, 'bad-intro');
      dest2.peer.send({ m: 'intro-done', from: s.seat, payload: msg.payload });
      return;
    }
    if (!s.connected) return;   // must hello first

    if (t === 'pong') { s.lastPong = nowMs(); s.rtt = isInt(msg.t, 0, 1e12) ? Math.max(0, nowMs() - msg.t) : -1; return; }
    if (t === 'ready') {
      if (this.state !== 'lobby' || typeof msg.on !== 'boolean') return;
      s.ready = msg.on;
      this.emit('seats', this.seatsPublic());
      this.broadcast({ m: 'seats', seats: this.seatsPublic() });
      return;
    }
    if (this.state !== 'playing' || !this.match) return this._strike(s, 'wrong-state');
    var st = this.match.st;
    if (st.seats[st.turn].color !== s.color) return;            // not your turn → ignore
    if (t === 'roll') {
      if (st.phase !== 'roll') return;
      this.match.netGuestRoll(s.seat);
    } else if (t === 'move') {
      if (st.phase !== 'move') return;
      if (!isInt(msg.token, 0, 3)) return this._strike(s, 'bad-move');
      var legal = E.legalMoves(st, st.lastRoll).filter(function (mv) { return mv.token === msg.token; });
      if (!legal.length) { this.emit('invalidMove', { seat: s.seat }); return; }  // rejected
      this.match.netGuestMove(s.seat, legal[0]);
    }
  };
  Room.prototype._strike = function (s, why) {
    s.strikes = (s.strikes || 0) + 1;
    s.strikeLog = s.strikeLog || [];
    s.strikeLog.push(why);
    this.emit('violation', { seat: s.seat, why: why });
    if (s.strikes >= 5) this.kick(s.seat, 'protocol');
  };
  Room.prototype.kick = function (seatIdx, reason) {
    var s = this.seats[seatIdx];
    if (!s) return;
    if (s.peer) { try { s.peer.send({ m: 'closed', reason: reason }); } catch (e) {} try { s.peer.close(); } catch (e) {} }
    if (s.kind === 'remote') {
      s.connected = false; s.ready = false;
      if (reason === 'bye') { s.name = null; s.kind = 'open'; s.token = null; }
      this.emit('seats', this.seatsPublic());
      this.broadcast({ m: 'seats', seats: this.seatsPublic() });
    }
  };

  /* ---- keepalive ---- */
  Room.prototype._startPing = function () {
    var self = this;
    this._pingTimer = setInterval(function () {
      if (self.state === 'closed') return;
      var now = nowMs();
      self.seats.forEach(function (s) {
        if (s.kind !== 'remote') return;
        if (s.connected) {
          s.peer.send({ m: 'ping', t: now, r: typeof s.rtt === 'number' && s.rtt >= 0 ? s.rtt : -1 });
          if (s.lastPong && now - s.lastPong > PING_TIMEOUT) self._seatDisconnected(s);
        } else if (self.state === 'playing' && self.match && self.match.netAdvanceDisconnected &&
                   self.match.st.turn === s.seat) {
          self.match.netAdvanceDisconnected(s.seat);   // dead seat owing a roll → skip
        }
      });
    }, PING_EVERY);
  };

  /* ---- lobby actions ---- */
  Room.prototype.setAiSeat = function (seatIdx, level) {   // level: null → open for humans
    var s = this.seats[seatIdx];
    if (!s || this.state !== 'lobby' || seatIdx === 0) return;
    if (s.connected) return;
    if (level === null) { s.kind = 'open'; s.ai = 1; }
    else { s.kind = 'ai'; s.ai = isInt(level, 0, 2) ? level : 1; s.ready = true; s.name = null; }
    this.emit('seats', this.seatsPublic());
    this.broadcast({ m: 'seats', seats: this.seatsPublic() });
  };
  Room.prototype.allReady = function () {
    return this.seats.every(function (s) {
      if (s.kind === 'ai' || s.kind === 'host') return true;
      if (s.kind === 'remote') return s.connected && s.ready;
      return false;                                       // open seat → not ready
    });
  };
  /* Build the match cfg. The host UI starts its own Match, then calls started(). */
  Room.prototype.buildCfg = function (cosmetics) {
    var seats = this.seats.map(function (s) {
      if (s.kind === 'host') return { color: s.color, kind: 'human', name: s.name || 'Host', avatar: s.avatar, remote: false };
      if (s.kind === 'ai') return { color: s.color, kind: 'ai', name: s.name || ('AI ' + (s.seat + 1)), ai: s.ai, avatar: (s.color * 3 + 2) % 8, remote: false };
      return { color: s.color, kind: 'human', name: s.name || ('Seat ' + s.seat), avatar: s.avatar || 0, remote: true };
    });
    var c = cosmetics || {};
    return {
      mode: 'online', seats: seats, rules: {},
      theme: c.board || 'ivory', dice: c.dice || 'ivory', tokenShape: c.token || 'classic',
      youColor: 0, netSeat: 0
    };
  };
  /* ---- verifiable dice (commit–reveal) ----
     The host pre-generates a cryptographically random batch and publishes
     salted SHA-256 commitments BEFORE any roll. Each revealed roll carries
     its salt + index, so every peer can prove the host never changed a
     die after the fact. A rigged host is DETECTABLE, not preventable. */
  Room.prototype.newDiceEpoch = function () {
    this.dice = { epoch: (this.dice ? this.dice.epoch : 0) + 1, values: [], salts: [], comms: [], idx: 0 };
    for (var i = 0; i < DICE_BATCH; i++) {
      var v = 1 + Math.floor(parseInt(Sha.randHex(4), 16) % 6);
      var salt = Sha.randHex(12);
      this.dice.values.push(v);
      this.dice.salts.push(salt);
      this.dice.comms.push(Sha.sha256(salt + ':' + v));
    }
    return this.dice.epoch;
  };
  Room.prototype.nextDice = function () {
    if (!this.dice || this.dice.idx >= this.dice.values.length) {
      this.newDiceEpoch();
      this.broadcast({ m: 'dicecommit', epoch: this.dice.epoch, list: this.dice.comms });
    }
    var i = this.dice.idx++;
    return { value: this.dice.values[i], salt: this.dice.salts[i], di: i, epoch: this.dice.epoch };
  };
  Room.prototype.commitPayload = function () {
    if (!this.dice) this.newDiceEpoch();
    return { m: 'dicecommit', epoch: this.dice.epoch, list: this.dice.comms };
  };

  /* ---- guest↔guest mesh (enables host migration) ----
     The host relays offer/answer payloads between guests over existing
     channels — it is a message relay, never a server. */
  Room.prototype.introduceMesh = function () {
    var remotes = this.seats.filter(function (s) { return s.kind === 'remote' && s.connected; });
    for (var a = 0; a < remotes.length; a++) {
      for (var b = a + 1; b < remotes.length; b++) {
        var lo = remotes[a], hi = remotes[b];          // lower seat offers
        if (lo.meshDone && lo.meshDone[hi.seat]) continue;
        lo.meshDone = lo.meshDone || {};
        lo.meshDone[hi.seat] = true;                    // idempotent per pair
        lo.peer.send({ m: 'intro', to: hi.seat, room: this.id });
      }
    }
  };
  function validMeshPayload(p, roomId) {
    return !!p && typeof p === 'object' && (p.t === 'o' || p.t === 'a') &&
           typeof p.sdp === 'string' && p.sdp.length > 0 && p.sdp.length <= 16 * 1024 &&
           p.room === roomId && isInt(p.seat, 0, 3) &&
           (p.secret === undefined || typeof p.secret === 'string');
  }

  Room.prototype.started = function () {                   // host match is live
    this.state = 'playing';
    this.seq = 1;
    this.newDiceEpoch();
    this.seats.forEach(function (s) {
      if (s.kind === 'remote' && s.connected) {
        s.peer.send({ m: 'start', cfg: this.match.cfg, st: this.match.st,
                      yourSeat: s.seat, seq: this.seq });
        s.peer.send(this.commitPayload());
      }
    }, this);
    this.introduceMesh();
    /* seed every guest with the first turn so their dice arms immediately */
    this.sync('turn', { seat: this.match.st.turn, extra: false });
    this.emit('start', {});
  };
  /* host Match calls this after every authoritative transition */
  Room.prototype.sync = function (tag, fx) {
    if (this.state !== 'playing' || !this.match) return;
    this.seq++;
    this.broadcast({ m: 'sync', seq: this.seq, tag: tag, fx: fx || {}, st: this.match.st });
  };
  /* replace a disconnected human seat with an AI mid-match */
  Room.prototype.convertToAi = function (seatIdx, level) {
    var s = this.seats[seatIdx];
    if (!s || this.state !== 'playing' || !this.match) return false;
    if (s.kind !== 'remote') return false;
    if (s.peer) { try { s.peer.close(); } catch (e) {} s.peer = null; }
    s.kind = 'ai';
    s.ai = isInt(level, 0, 2) ? level : 1;
    s.connected = false;
    var mst = this.match.st;
    mst.seats[seatIdx].kind = 'ai';
    mst.seats[seatIdx].ai = s.ai;
    this.sync('turn', { seat: mst.turn });
    this.emit('seats', this.seatsPublic());
    this.broadcast({ m: 'seats', seats: this.seatsPublic() });
    this.emit('converted', { seat: seatIdx, level: s.ai });
    return true;
  };
  /* host ends the match early: leader by progress wins */
  Room.prototype.endMatchByHost = function () {
    if (this.state !== 'playing' || !this.match) return;
    var st = this.match.st;
    var leader = 0, best = -1;
    st.seats.forEach(function (s, i) {
      var p = E.progress(st, i);
      if (p > best) { best = p; leader = i; }
    });
    st.winner = leader;
    st.rankings = E.rankPlayers(st, leader);
    st.phase = 'over';
    st.rules = st.rules || {};
    st.rules.endedByHost = true;   // explicit: validator exempts non-all-home winners
    this.sync('end', { winner: leader, rankings: st.rankings });
    this.match.finish();
  };
  Room.prototype.endMatch = function () {
    if (this.state === 'playing') { this.state = 'lobby'; this.emit('seats', this.seatsPublic()); }
  };
  Room.prototype.close = function (reason) {
    if (this.state === 'closed') return;
    /* deliberate host exit with players present: name a successor so the
       mesh can elect instantly instead of racing */
    var successor = null;
    if (reason === 'host-left') {
      var live = this.seats.filter(function (s) { return s.kind === 'remote' && s.connected; });
      if (live.length) {
        live.sort(function (a, b) { return a.seat - b.seat; });
        successor = live[0].seat;
        this.broadcast({ m: 'migrating', successor: successor, seq: this.seq, st: this.match ? this.match.st : null });
      }
    }
    this.state = 'closed';
    clearInterval(this._pingTimer);
    this.seats.forEach(function (s) {
      if (s.peer) { try { s.peer.send({ m: 'closed', reason: reason || 'host-left' }); } catch (e) {} try { s.peer.close(); } catch (e) {} }
    });
    this.emit('closed', { reason: reason || 'host-left', successor: successor });
  };

  /* ======================================================================
     Guest side
     ====================================================================== */
  function Guest(opts) {
    opts = opts || {};
    this.peer = opts.peer || new Net.Peer({ label: 'guest' });
    this.room = null; this.seat = null; this.token = opts.token || null;
    this.name = sanitizeName(opts.name || 'Player');
    this.avatar = isInt(opts.avatar, 0, 7) ? opts.avatar : 0;
    this.state = 'idle';                     // idle | lobby | playing | closed
    this.lastSeq = 0; this.rtt = null;
    this.onEvent = opts.onEvent || function () {};
    this._pingTimer = null;
    this._staleSeq = 0;
    /* host-migration + verifiable-dice state */
    this.mesh = {};                          // seat → peer (guest↔guest channels)
    this._meshPending = {};                  // seat → peer awaiting completion
    this.mirror = { cfg: null, st: null };   // latest authoritative snapshot
    this.dice = { comms: null, epoch: 0, idx: 0, violations: 0, verified: 0 };
    this._electTimer = null;
    this._peerFactory = opts.peerFactory || null;
    var self = this;
    this.peer.onmessage = function (raw) { self._onHostRaw(raw); };
    this.peer.onstate = function (s) { self.emit2('netState', { s: s }); };
    this.peer.onclose = function (why) {
      if (self.state === 'closed') return;
      /* anyone holding a verified mirror can keep the game alive: elect.
         With a live mesh the lowest seat wins and others follow; without
         one (e.g. 2-player) the survivor hosts on. */
      if ((self.state === 'playing' || self.state === 'lobby' || self._electForced) && self.mirror.st) {
        self.state = 'electing';
        self.emit2('electing', { seat: self.seat });
        self._startElection();
        return;
      }
      self.state = self.state === 'playing' ? 'lost' : 'idle';
      self.emit2('connection', { up: false, why: why });
    };
  }
  Guest.prototype.emit2 = function (name, data) { try { this.onEvent(name, data); } catch (e) {} };

  Guest.prototype._onHostRaw = function (raw) {
    if (typeof raw !== 'string' || raw.length > Net.MAX_MSG) return;
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.m) {
      case 'welcome':
        this.room = msg.room; this.seat = isInt(msg.seat, 0, 3) ? msg.seat : null;
        this.state = 'lobby';
        this._startPong();
        this.emit2('welcome', { room: msg.room, seat: msg.seat, seats: msg.seats, resume: !!msg.resume });
        break;
      case 'seats':
        this.emit2('seats', msg.seats || []);
        break;
      case 'start':
        if (!isInt(msg.seq, 0, 1e9)) return;
        if (!isInt(msg.yourSeat, 0, 3)) return;
        if (!validateNetCfg(msg.cfg)) { this.emit2('hostError', { code: 'bad-cfg' }); return; }
        if (!E.validateState(msg.st)) { this.emit2('hostError', { code: 'bad-state' }); return; }
        if (msg.yourSeat >= msg.cfg.seats.length) return;
        this.lastSeq = msg.seq;
        this.state = 'playing';
        this.mirror = { cfg: msg.cfg, st: msg.st };
        this.emit2('start', { cfg: msg.cfg, st: msg.st, yourSeat: msg.yourSeat, seq: this.lastSeq });
        break;
      case 'sync':
        if (!isInt(msg.seq, 0, 1e9)) return;
        if (msg.seq <= this.lastSeq) { this._staleSeq++; this.emit2('staleSeq', { got: msg.seq, have: this.lastSeq }); return; }
        if (!E.validateState(msg.st)) return;
        /* verifiable dice: every revealed roll must match the pre-committed hash */
        if (msg.tag === 'rolled' && this.dice.comms && msg.fx && isInt(msg.fx.di, 0, this.dice.comms.length - 1)) {
          var saltsOk = typeof msg.fx.salt === 'string' && /^[0-9a-f]{4,64}$/.test(msg.fx.salt);
          var matches = saltsOk && isInt(msg.fx.value, 1, 6) &&
                        Sha.sha256(msg.fx.salt + ':' + msg.fx.value) === this.dice.comms[msg.fx.di] &&
                        msg.fx.di === this.dice.idx;
          if (!matches) {
            this.dice.violations++;
            this.emit2('diceViolation', { di: msg.fx.di, expected: this.dice.idx });
          } else {
            this.dice.idx++;
            this.dice.verified++;
          }
        }
        this.lastSeq = msg.seq;
        this.mirror.st = msg.st;
        if (msg.st) this.emit2('sync', { seq: msg.seq, tag: msg.tag, fx: this._checkFx(msg.fx), st: msg.st });
        break;
      case 'ping':
        this.peer.send({ m: 'pong', t: msg.t });
        if (isInt(msg.r, -1, 60000)) {
          this.rtt = msg.r >= 0 ? msg.r : null;
          this.emit2('rtt', { rtt: this.rtt });
        }
        this.emit2('ping', { t: msg.t });
        break;
      case 'dicecommit':
        if (!Array.isArray(msg.list) || msg.list.length < 1 || msg.list.length > 2000) return;
        for (var ci = 0; ci < msg.list.length; ci++) {
          if (!/^[0-9a-f]{64}$/.test(String(msg.list[ci]))) return;    // commitments are sha-256 hex
        }
        this.dice.comms = msg.list;
        this.dice.epoch = isInt(msg.epoch, 0, 1e6) ? msg.epoch : 0;
        this.dice.idx = 0;
        break;
      case 'status':
        this.emit2('status', { text: String(msg.text || '').slice(0, 80), seat: msg.seat });
        break;
      case 'migrating':
        /* graceful handoff: the named successor claims, everyone else follows */
        if (isInt(msg.successor, 0, 3) && msg.successor !== this.seat) {
          this.state = 'electing';
          this.emit2('electing', { successor: msg.successor });
          if (msg.st && E.validateState(msg.st)) { this.mirror.st = msg.st; this.lastSeq = isInt(msg.seq, 0, 1e9) ? msg.seq : this.lastSeq; }
        } else if (msg.successor === this.seat) {
          this._electForced = true;         // I am the successor: claim immediately
        }
        break;
      case 'intro':
        /* host asks me to open a channel to a lower... to seat `to` */
        if (isInt(msg.to, 0, 3) && msg.to !== this.seat && this.room) this._meshOffer(msg.to);
        break;
      case 'intro-in':
        if (isInt(msg.from, 0, 3) && msg.from !== this.seat && validMeshPayload(msg.payload, this.room)) this._meshAnswer(msg.from, msg.payload);
        break;
      case 'intro-done':
        if (isInt(msg.from, 0, 3) && this._meshPending[msg.from] && validMeshPayload(msg.payload, this.room)) {
          var mp2 = this._meshPending[msg.from];
          var self2 = this;
          mp2.acceptAnswerPayload(msg.payload).then(function () {
            self2._wireMeshPeer(msg.from, mp2);      // offer side completes here
          }).catch(function () { self2._meshFail(msg.from); });
        }
        break;
      case 'claim-host':
        if (isInt(msg.seat, 0, 3) && msg.seat !== this.seat && this.state === 'electing') this._followHost(msg.seat);
        break;
      case 'hostmoved':
        /* a peer already adopted the host role: rewire onto that mesh peer */
        if (isInt(msg.seat, 0, 3) && this.mesh[msg.seat] && this.mesh[msg.seat].open) this._adoptHostPeer(msg.seat);
        break;
      case 'closed':
        this.state = 'closed';
        clearInterval(this._pingTimer);
        this.emit2('closed', { reason: String(msg.reason || 'closed') });
        try { this.peer.close(); } catch (e) {}
        break;
      case 'error':
        this.emit2('hostError', { code: String(msg.code || 'error') });
        break;
    }
  };
  Guest.prototype._checkFx = function (fx) {
    if (!fx || typeof fx !== 'object') return {};
    var out = {};
    if (isInt(fx.value, 1, 6)) out.value = fx.value;
    if (typeof fx.outcome === 'string' && fx.outcome.length < 12) out.outcome = fx.outcome;
    if (isInt(fx.seat, 0, 3)) out.seat = fx.seat;
    if (fx.move && isInt(fx.move.token, 0, 3) && isInt(fx.move.from, -1, 56) && isInt(fx.move.to, 0, 56)) {
      out.move = { token: fx.move.token, from: fx.move.from, to: fx.move.to };
    }
    if (Array.isArray(fx.captures) && fx.captures.length <= 12) {
      out.captures = fx.captures.filter(function (c) { return c && isInt(c.seat, 0, 3) && isInt(c.token, 0, 3); })
        .slice(0, 12).map(function (c) { return { seat: c.seat, token: c.token }; });
    }
    if (typeof fx.home === 'boolean') out.home = fx.home;
    if (typeof fx.win === 'boolean') out.win = fx.win;
    if (typeof fx.extra === 'boolean') out.extra = fx.extra;
    if (isInt(fx.winner, 0, 3)) out.winner = fx.winner;
    if (Array.isArray(fx.rankings) && fx.rankings.length <= 4) {
      out.rankings = fx.rankings.filter(function (r) { return isInt(r, 0, 3); });
    }
    return out;
  };
  /* ---------- guest↔guest mesh ---------- */
  Guest.prototype._makePeer = function (meta) {
    if (this._peerFactory) return this._peerFactory(meta);
    return new Net.Peer({ label: 'mesh' });
  };
  Guest.prototype._meshOffer = function (toSeat) {
    var self = this;
    var pairKey = [Math.min(this.seat, toSeat), Math.max(this.seat, toSeat)].join('-');
    var peer = this._makePeer({ room: this.room, seat: this.seat, mesh: true, pairKey: pairKey });
    this._meshPending[toSeat] = peer;
    peer.createOfferPayload({ room: this.room, seat: this.seat, secret: 'mesh' }).then(function (payload) {
      self.peer.send({ m: 'intro-offer', to: toSeat, payload: payload });
    }).catch(function () { self._meshFail(toSeat); });
  };
  Guest.prototype._meshAnswer = function (fromSeat, offer) {
    var self = this;
    var pairKey = [Math.min(this.seat, fromSeat), Math.max(this.seat, fromSeat)].join('-');
    var peer = this._makePeer({ room: this.room, seat: this.seat, mesh: true, pairKey: pairKey });
    this._meshPending[fromSeat] = peer;
    peer.acceptOfferPayload(offer).then(function (answer) {
      self.peer.send({ m: 'intro-answer', to: fromSeat, payload: answer });
      self._wireMeshPeer(fromSeat, peer);
    }).catch(function () { self._meshFail(fromSeat); });
  };
  Guest.prototype._wireMeshPeer = function (seat, peer) {
    var self = this;
    peer.onmessage = function (raw) { self._onMeshRaw(seat, raw); };
    peer.onclose = function () {
      delete self.mesh[seat];
      /* losing the last mesh member while electing/leaderless → true loss */
      if ((self.state === 'electing' || self.state === 'adopting') && !Object.keys(self.mesh).length) {
        if (self._electTimer) { clearTimeout(self._electTimer); self._electTimer = null; }
        self.state = 'lost';
        self.emit2('connection', { up: false, why: 'mesh-gone' });
      }
    };
    var attach = function () {
      if (self._meshPending[seat] === peer) delete self._meshPending[seat];
      if (self.state !== 'closed') { self.mesh[seat] = peer; self.emit2('mesh', { seat: seat }); }
    };
    if (peer.open) attach();
    else peer.onopen = attach;
  };
  Guest.prototype._meshFail = function (seat) {
    var p = this._meshPending[seat];
    if (p) { try { p.close(); } catch (e) {} delete this._meshPending[seat]; }
  };
  Guest.prototype._onMeshRaw = function (seat, raw) {
    if (typeof raw !== 'string' || raw.length > Net.MAX_MSG) return;
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.m === 'claim-host' && isInt(msg.seat, 0, 3) && this.state === 'electing') {
      this._followHost(msg.seat);
      return;
    }
    if (msg.m === 'hostmoved' && isInt(msg.seat, 0, 3) && this.mesh[msg.seat]) {
      this._adoptHostPeer(msg.seat);
      return;
    }
    if (msg.m === 'ack-host') this.emit2('ackHost', { seat: seat });
  };

  /* ---------- host election ---------- */
  Guest.prototype._startElection = function () {
    var self = this;
    if (this._electTimer) return;
    /* deterministic backoff: the lowest seat claims first — no split brain */
    this._electTimer = setTimeout(function () {
      self._electTimer = null;
      self._claimHost();
    }, ELECT_BASE + (this.seat || 0) * ELECT_STEP);
  };
  Guest.prototype._claimHost = function () {
    if (this.state !== 'electing' || !this.mirror.st) {
      /* nothing to adopt → genuine loss */
      this.state = this.state === 'electing' ? 'lost' : this.state;
      this.emit2('connection', { up: false, why: 'no-mirror' });
      return;
    }
    this.state = 'adopting';
    Object.keys(this.mesh).forEach(function (k) {
      self2SendClaim(self, k);
    });
    this.emit2('becomeHost', {});      // UI builds the authoritative Room
    function self2SendClaim(g, k) {
      try { g.mesh[k].send({ m: 'claim-host', seat: g.seat }); } catch (e) {}
    }
  };
  Guest.prototype._followHost = function (seat) {
    if (this._electTimer) { clearTimeout(this._electTimer); this._electTimer = null; }
    var peer = this.mesh[seat];
    if (!peer || !peer.open) return;
    try { peer.send({ m: 'ack-host' }); } catch (e) {}
    /* the new host will announce 'hostmoved' with a fresh start payload;
       until then stay in electing so we never talk to a dead old host */
  };
  Guest.prototype._adoptHostPeer = function (seat) {
    /* rewire: the mesh peer becomes THE host channel */
    var peer = this.mesh[seat];
    if (!peer) return;
    this.peer = peer;
    this.state = 'playing';
    this.dice = { comms: null, epoch: 0, idx: 0, violations: this.dice.violations, verified: this.dice.verified };
    /* 'start'/'dicecommit'/'sync' resume over the swapped peer via onmessage
       (already wired to _onMeshRaw → redirect to host intake) */
    var self = this;
    peer.onmessage = function (raw) {
      if (typeof raw !== 'string' || raw.length > Net.MAX_MSG) return;
      var msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (msg && msg.m === 'claim-host' && self.state === 'electing') { self._followHost(msg.seat); return; }
      self._onHostRaw(raw);            // normal host protocol on the new channel
    };
    this.emit2('hostAdopted', { seat: seat });
  };

  Guest.prototype._startPong = function () {
    var self = this;
    clearInterval(this._pingTimer);
    this._pingTimer = setInterval(function () {
      if (self.state === 'closed' || self.state === 'idle') { clearInterval(self._pingTimer); return; }
      self.emit2('tick', { rtt: self.rtt, state: self.state });
    }, 2000);
  };
  /* actions (all validated again host-side) */
  Guest.prototype.hello = function () { this.peer.send({ m: 'hello', v: PROTO, token: this.token, name: this.name, avatar: this.avatar }); };
  Guest.prototype.setReady = function (on) { this.peer.send({ m: 'ready', on: !!on }); };
  Guest.prototype.requestRoll = function () { if (this.state === 'playing') this.peer.send({ m: 'roll' }); };
  Guest.prototype.requestMove = function (tokenIdx) {
    if (this.state === 'playing' && isInt(tokenIdx, 0, 3)) this.peer.send({ m: 'move', token: tokenIdx });
  };
  Guest.prototype.leave = function () {
    try { this.peer.send({ m: 'leave' }); } catch (e) {}
    this.state = 'closed';
    clearInterval(this._pingTimer);
    if (this._electTimer) { clearTimeout(this._electTimer); this._electTimer = null; }
    Object.keys(this.mesh).forEach(function (k) { try { this.mesh[k].close(); } catch (e) {} }, this);
    try { this.peer.close(); } catch (e) {}
    this.emit2('closed', { reason: 'left' });
  };
  Guest.prototype.destroy = function () {
    clearInterval(this._pingTimer);
    if (this._electTimer) { clearTimeout(this._electTimer); this._electTimer = null; }
    Object.keys(this.mesh).concat(Object.keys(this._meshPending)).forEach(function (k) {
      var p = this.mesh[k] || this._meshPending[k];
      if (p) { try { p.close(); } catch (e) {} }
    }, this);
    this.mesh = {}; this._meshPending = {};
    try { this.peer.close(); } catch (e) {}
    this.state = 'closed';
  };

  /* Build an authoritative Room from a guest's mirrored state after the
     original host vanished. Called by the UI on 'becomeHost'. Existing mesh
     channels are re-bound as host↔guest seats (identity carried from the
     original authenticated room), and a FRESH dice epoch is committed. */
  Room.adoptFromGuest = function (guest) {
    var mirror = guest.mirror || {};
    if (!mirror.cfg || !mirror.st || !E.validateState(mirror.st)) return null;
    var cfg = mirror.cfg;
    var room = new Room({
      id: guest.room || Net.roomId(),
      size: cfg.seats.length,
      hostName: guest.name,
      hostAvatar: guest.avatar,
      peerFactory: guest._peerFactory ? function () { return guest._peerFactory({ room: guest.room }); } : null
    });
    room.adopted = true;
    /* map seats: my color → host; mesh-connected colors → remote (bound);
       everything else (incl. the old host) → disconnected remote */
    var myColor = cfg.seats[guest.seat] ? cfg.seats[guest.seat].color : guest.seat;
    /* canonicalize locality: after migration ONLY my seat is local — the
     old host included, everyone else is remote (disconnected until bound) */
    cfg.seats.forEach(function (cs3, i3) { cs3.remote = (i3 !== guest.seat); });
    room.seats.forEach(function (rs) {
      if (rs.color === myColor) {
        rs.kind = 'host'; rs.name = guest.name; rs.avatar = guest.avatar;
        rs.ready = true; rs.connected = true; rs.peer = null;
        return;
      }
      /* find the guest's mesh peer for this seat via seat-number heuristics:
         mesh keys are seat indexes of the ORIGINAL room (color-sorted) */
      var origSeat = -1;
      cfg.seats.forEach(function (cs2, i2) { if (cs2.color === rs.color) origSeat = i2; });
      var peer = guest.mesh[origSeat];
      rs.kind = 'remote';
      rs.name = (cfg.seats[origSeat] && cfg.seats[origSeat].name) || ('Seat ' + rs.seat);
      rs.avatar = (cfg.seats[origSeat] && cfg.seats[origSeat].avatar) || 0;
      if (peer && peer.open) {
        rs.peer = peer;
        rs.connected = true;
        rs.ready = true;
        rs.adopted = true;             // identity from the original room; no token re-check
      } else {
        rs.connected = false;
        rs.ready = false;
      }
    });
    /* rebind intake: adopted peers speak the guest protocol directly */
    room.seats.forEach(function (s) {
      if (s.kind === 'remote' && s.peer) room._wirePeer(s, s.peer, 'adopted');
    });
    room.state = 'playing';
    room.seq = guest.lastSeq || 1;
    return room;
  };

  global.LudoraMp = { Room: Room, Guest: Guest, PROTO: PROTO, sanitizeName: sanitizeName,
                       validateNetCfg: validateNetCfg,
                       _setNow: function (fn) { nowMs = fn; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.LudoraMp;
})(typeof window !== 'undefined' ? window : globalThis);
