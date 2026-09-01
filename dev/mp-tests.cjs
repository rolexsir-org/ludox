/* Ludora — dev/mp-tests.cjs
   Full-fidelity multiplayer test suite. Runs the REAL game controllers
   (engine + AI + Match + Room + Guest) headlessly over a virtual
   peer-to-peer network with a deterministic clock.

   run: node dev/mp-tests.cjs */
'use strict';
const { makeHarness } = require('./harness.js');
const H = makeHarness();
H.load(['engine.js', 'ai.js', 'persist.js', 'store.js', 'profile.js', 'audio.js',
        'board.js', 'net.js', 'sha.js', 'mp.js', 'qr.js', 'game.js']);
const E = global.LudoraEngine, AI = global.LudoraAI, Net = global.LudoraNet,
      Mp = global.LudoraMp, Game = global.LudoraGame, Board = global.LudoraBoard;
Mp._setNow(() => H.now);   // deterministic keepalive/flood windows

let passed = 0, failed = 0;
const asyncTests = [];
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n') : e)); }
}
function tAsync(name, fn) { asyncTests.push({ name, fn }); }
function eq(a, b, m) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error((m || 'not equal') + '\n    A: ' + ja.slice(0, 220) + '\n    B: ' + jb.slice(0, 220));
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }

/* deterministic per-run policy RNG */
let seed = 1234567;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
function pickLegal(legal, mode) {
  if (mode === 'first') return legal[0];
  return legal[Math.floor(rnd() * legal.length) % legal.length];
}

/* =====================================================================
   Test world: one Room (host) + N guests over a VirtualNet, each guest
   backed by its own real Match replica.
   ===================================================================== */
function makeWorld(size, opts) {
  opts = opts || {};
  const vnet = new Net.VirtualNet({ latency: opts.latency || 15 });
  const events = { host: [], guests: [], roomEvents: [] };
  const room = new Mp.Room({
    size, hostName: 'Host', hostAvatar: 0,
    onEvent: (n, d) => events.roomEvents.push({ n, d })
  });
  const diceLog = { host: [], guests: {} };
  const guests = [];
  /* 1 · connect every guest first (mirrors the real lobby flow) */
  const cfg = room.buildCfg({});
  for (let seat = 1; seat < size; seat++) {
    if (cfg.seats[seat].remote === false) continue;         // AI seat
    const meta = { room: room.id, seat, secret: 'sec' + seat + 'padding' };
    const hp = vnet.hostPeer(meta);
    room.bindPeer(seat, hp, meta.secret);
    const gp = vnet.join(hp, meta);
    const guest = new Mp.Guest({ peer: gp, token: meta.secret, name: 'Guest' + seat, avatar: seat });
    diceLog.guests[seat] = [];
    const u = { seat, guest, vnet, hp, gp, match: null };
    guest.onEvent = (n, d) => {
      if (n === 'start') {
        const c2 = JSON.parse(JSON.stringify(d.cfg));
        c2.netSeat = d.yourSeat;
        const gm = new Game._Match();
        gm.start(H.makeCanvas(600, 600), c2, d.st);
        gm.netGuest = guest;
        gm.netSeq = d.seq;
        gm.onDice = (ev2) => { if (ev2.state === 'rolling') diceLog.guests[seat].push(ev2.value); };
        gm.legal = [];
        u.match = gm;
      } else if (n === 'sync' && u.match) {
        u.match.netApply(d);
      }
    };
    guest.hello();
    guests.push(u);
  }
  H.advance(120);
  /* 2 · now the host starts the authoritative match */
  cfg.seats[0].name = 'Host';
  const hostMatch = new Game._Match();
  hostMatch.start(H.makeCanvas(600, 600), cfg, null);
  hostMatch.onDice = (ev) => { if (ev.state === 'rolling') diceLog.host.push(ev.value); };
  hostMatch.netHost = room;
  room.match = hostMatch;
  room.started();
  hostMatch.begin();
  H.advance(120);
  return { room, hostMatch, guests, events, diceLog, vnet, size };
}

function stepLocal(m) {
  if (!m || m.destroyed || !m.st || m.st.phase === 'over') return;
  const turn = m.st.turn;
  if (!m.isLocalSeat(turn)) return;
  if (m.st.phase === 'roll' && !m.diceBusy) m.rollRequest();
  else if (m.st.phase === 'move') {
    const legal = E.legalMoves(m.st, m.st.lastRoll);
    if (legal.length) m.executeMove(pickLegal(legal, 'rand'));
  }
}
function stepGuest(u) {
  const m = u.match;
  if (!m || m.destroyed || !m.st || m.st.phase === 'over') return;
  if (!m.isLocalSeat(m.st.turn)) return;
  if (m.st.phase === 'roll' && !m.diceBusy) m.rollRequest();
  else if (m.st.phase === 'move' && m.legal && m.legal.length) {
    m.executeMove(pickLegal(m.legal, 'rand'));
  }
}
function driveToEnd(w, maxIters) {
  function pulse(st) {   /* rolls + moves both count as progress */
    var rolls = 0;
    st.stats.forEach(function (s) { rolls += s.rolls; });
    return rolls * 1000 + st.moveNo;
  }
  let i = 0;
  while (w.hostMatch.st.phase !== 'over' && i++ < (maxIters || 8000)) {
    H.advance(1400);
    stepLocal(w.hostMatch);
    w.guests.forEach(stepGuest);
    if (i > 400 && i % 800 === 0) {
      /* safety: dice must keep rolling; moveNo alone can legally pause
         for many turns in an exact-roll endgame */
      const stuck = pulse(w.hostMatch.st);
      H.advance(8000);
      assert(pulse(w.hostMatch.st) > stuck || w.hostMatch.st.phase === 'over', 'game stalled (pulse ' + stuck + ')');
    }
  }
  H.advance(3000);   // let final animations settle
}

function cleanup(w) {
  w.guests.forEach((u) => { if (u.match) u.match.destroy(); u.guest.destroy(); });
  w.hostMatch.destroy();
  w.room.close('test-end');
}

console.log('\nROOM LIFECYCLE');
t('room creation: id format, host seat, slots', () => {
  const room = new Mp.Room({ size: 3, hostName: 'Ana' });
  assert(/^[A-Z]{3,8}-\d{3,5}$/.test(room.id), 'readable id: ' + room.id);
  eq(room.seats.map((s) => s.kind), ['host', 'open', 'open']);
  assert(room.seats[0].ready && room.seats[0].connected, 'host ready+connected');
  assert(!room.allReady(), 'open seats block start');
});
t('room joining: hello → welcome, ready → startable', () => {
  const vnet = new Net.VirtualNet({ latency: 10 });
  const room = new Mp.Room({ size: 2, hostName: 'Ana' });
  const meta = { room: room.id, seat: 1, secret: 'lobbysec12345' };
  const hp = vnet.hostPeer(meta);
  room.bindPeer(1, hp, meta.secret);
  const gp = vnet.join(hp, meta);
  const guest = new Mp.Guest({ peer: gp, token: meta.secret, name: 'Bilal', avatar: 2 });
  let welcomed = null;
  guest.onEvent = (n, d) => { if (n === 'welcome') welcomed = d; };
  guest.hello();
  H.advance(80);
  eq(room.seats[1].kind, 'remote');
  assert(room.seats[1].connected, 'guest connected after hello');
  eq(room.seats[1].name, 'Bilal');
  assert(welcomed && welcomed.room === room.id && welcomed.seat === 1, 'welcome received');
  assert(!room.allReady(), 'not ready yet');
  guest.setReady(true);
  H.advance(60);
  assert(room.allReady(), 'ready guests allow start');
  guest.leave();
  room.close('done');
});
t('malformed connection data: bad token rejected, wrong protocol flagged', () => {
  const vnet = new Net.VirtualNet({ latency: 5 });
  const room = new Mp.Room({ size: 2, hostName: 'Ana' });
  const meta = { room: room.id, seat: 1, secret: 'lobbysec67890' };
  const hp = vnet.hostPeer(meta);
  room.bindPeer(1, hp, meta.secret);
  const gp = vnet.join(hp, meta);          // guest-side transport → host intake
  hp.onmessage(JSON.stringify({ m: 'hello', v: Mp.PROTO, token: 'WRONG-SECRET', name: 'X', avatar: 1 }));
  H.advance(40);
  assert(!room.seats[1].connected, 'bad token does not connect');
  const before = room.seats[1].strikes || 0;
  hp.onmessage('this is not json at all {{{');
  H.advance(40);
  assert((room.seats[1].strikes || 0) === before + 1, 'garbage counts a strike');
  gp.close();
  room.close('done');
});

console.log('\nFULL ONLINE GAMES (real controllers, virtual network)');
for (const size of [2, 3, 4]) {
  t(size + '-player online game: host and every guest reach the identical authoritative state', () => {
    const w = makeWorld(size);
    driveToEnd(w);
    assert(w.hostMatch.st.phase === 'over', 'game finished');
    const winnerColor = w.hostMatch.st.seats[w.hostMatch.st.winner].color;
    w.guests.forEach((u) => {
      assert(u.match, 'guest match created');
      eq(u.match.st, w.hostMatch.st, 'guest state equals host state');
      eq(u.match.st.winner, w.hostMatch.st.winner, 'same winner');
      eq(w.diceLog.guests[u.seat], w.diceLog.host, 'identical dice sequence');
    });
    /* synchronized captures + extra turns show up as identical stats */
    eq(w.hostMatch.st.stats, w.guests[0].match.st.stats, 'identical per-seat stats');
    assert(winnerColor !== null);
    cleanup(w);
  });
}
t('online game with AI seats: mixed humans + AI synchronized', () => {
  const w = makeWorld(3);
  /* convert seat 2 (open, no guest) to AI before start — restart a fresh world with AI preset instead */
  cleanup(w);
  const vnet = new Net.VirtualNet({ latency: 10 });
  const room = new Mp.Room({ size: 3, hostName: 'Host', aiSeats: { 2: 2 } });
  const cfg = room.buildCfg({});
  eq(cfg.seats.map((s) => s.kind), ['human', 'human', 'ai']);
  eq(cfg.seats[2].ai, 2);
  const meta = { room: room.id, seat: 1, secret: 'mixsec12345' };
  const hp = vnet.hostPeer(meta);
  room.bindPeer(1, hp, meta.secret);
  const gp = vnet.join(hp, meta);
  const guest = new Mp.Guest({ peer: gp, token: meta.secret, name: 'G', avatar: 1 });
  let gm = null;
  guest.onEvent = (n, d) => {
    if (n === 'start') {
      const c2 = JSON.parse(JSON.stringify(d.cfg));
      c2.netSeat = 1;
      gm = new Game._Match();
      gm.start(H.makeCanvas(600, 600), c2, d.st);
      gm.netGuest = guest; gm.netSeq = d.seq; gm.legal = [];
    } else if (n === 'sync' && gm) gm.netApply(d);
  };
  guest.hello();
  H.advance(100);
  const hostMatch = new Game._Match();
  hostMatch.start(H.makeCanvas(600, 600), cfg, null);
  hostMatch.netHost = room;
  room.match = hostMatch;
  room.started();
  hostMatch.begin();
  H.advance(100);
  let i = 0;
  while (hostMatch.st.phase !== 'over' && i++ < 3000) {
    H.advance(1400);
    stepLocal(hostMatch);
    stepGuest({ match: gm });
  }
  H.advance(2000);
  assert(hostMatch.st.phase === 'over');
  eq(gm.st, hostMatch.st, 'guest matches host with AI in play');
  gm.destroy(); hostMatch.destroy(); room.close('end');
});

console.log('\nPROTOCOL INTEGRITY');
t('invalid move: out-of-turn action ignored, illegal token rejected', () => {
  const w = makeWorld(2);
  const g = w.guests[0], seat = 1;
  /* it is the HOST's turn first (seat 0): guest tries to roll — must be ignored */
  const movesBefore = w.hostMatch.st.moveNo;
  g.guest.requestRoll();
  H.advance(800);
  eq(w.hostMatch.st.moveNo, movesBefore, 'out-of-turn roll ignored');
  /* advance to guest's turn */
  let i = 0;
  while (w.hostMatch.st.turn === 0 && i++ < 200) { H.advance(1400); stepLocal(w.hostMatch); stepGuest(g); }
  assert(w.hostMatch.st.turn === seat, 'guest turn reached');
  /* guest sends a move while phase is roll → ignored */
  if (w.hostMatch.st.phase === 'roll') {
    g.guest.requestMove(0);
    H.advance(100);
    eq(w.hostMatch.st.phase, 'roll', 'move during roll phase ignored');
    g.guest.rollRequest && g.guest.requestRoll();
    H.advance(800);
  }
  /* illegal token for the current roll (yard token on a non-six, or any invalid index) */
  const before = JSON.stringify(w.hostMatch.st.tokens);
  const invalids = w.hostMatch.st.lastRoll === 6 ? [9, -1, 1.5] : [9, -1, 1.5, 0];
  invalids.forEach((tok) => g.hp.onmessage(JSON.stringify({ m: 'move', token: tok })));
  H.advance(200);
  eq(JSON.stringify(w.hostMatch.st.tokens), before, 'invalid tokens change nothing');
  const vEvents = w.events.roomEvents.filter((e) => e.n === 'invalidMove' || e.n === 'violation').length;
  assert(vEvents >= 1, 'host flagged the violations (' + vEvents + ')');
  cleanup(w);
});
t('duplicate action: double roll requests cannot double-roll', () => {
  const w = makeWorld(2);
  /* get to guest's turn */
  let i = 0;
  while (w.hostMatch.st.turn === 0 && i++ < 200) { H.advance(1400); stepLocal(w.hostMatch); stepGuest(w.guests[0]); }
  H.advance(2000); H.advance(2000);   // settle: phase roll on guest turn
  const rolls = w.hostMatch.st.stats[1].rolls;
  w.guests[0].guest.requestRoll();
  w.guests[0].guest.requestRoll();
  w.guests[0].guest.requestRoll();
  H.advance(1200);
  assert(w.hostMatch.st.stats[1].rolls <= rolls + 1, 'no duplicate rolls applied (' + rolls + '→' + w.hostMatch.st.stats[1].rolls + ')');
  cleanup(w);
});
t('out-of-order / stale snapshots are ignored by guests', () => {
  const w = makeWorld(2);
  driveToEnd(w);
  const g = w.guests[0].guest;
  const staleBefore = g._staleSeq;
  const snapshot = JSON.parse(JSON.stringify(w.hostMatch.st));
  const goodSeq = g.lastSeq;
  /* replay an OLD sync message */
  g._onHostRaw(JSON.stringify({ m: 'sync', seq: goodSeq - 1, tag: 'turn', fx: {}, st: snapshot }));
  eq(g._staleSeq, staleBefore + 1, 'stale seq rejected');
  /* and a nonsense future seq with broken state must also be dropped */
  g._onHostRaw(JSON.stringify({ m: 'sync', seq: goodSeq + 50, tag: 'turn', fx: {}, st: { garbage: true } }));
  eq(g.lastSeq, goodSeq, 'invalid state snapshot not applied');
  cleanup(w);
});
t('bounds checking: oversized and malformed wire messages are dropped', () => {
  const w = makeWorld(2);
  const seat = w.room.seats[1];
  const hp = w.guests[0].hp;                                            // host transport intake
  const strikes = seat.strikes || 0;
  hp.onmessage('x'.repeat(Net.MAX_MSG + 100));                         // oversize → strike
  hp.onmessage(JSON.stringify({ m: 'roll', extra: '; DROP TABLE' }));  // unknown fields: shape ok, wrong phase → ignored
  hp.onmessage('[1,2,3]');                                              // array → strike
  hp.onmessage('42');                                                   // number literal → strike
  H.advance(80);
  const got = (seat.strikes || 0) - strikes;
  eq(got, 3, 'three strikes counted, got: ' + JSON.stringify(seat.strikeLog));
  assert(seat.connected, 'strikes alone do not kick');
  cleanup(w);
});
t('flood guard kicks abusive peers', () => {
  const w = makeWorld(2);
  const seat = w.room.seats[1];
  const gp = w.guests[0].gp;
  for (let k = 0; k < 40; k++) gp.send(JSON.stringify({ m: 'ready', on: true }));
  H.advance(120);
  assert(!seat.connected, 'flooder disconnected');
  cleanup(w);
});
t('no executable payloads: fx fields are whitelisted and clamped', () => {
  const w = makeWorld(2);
  const g = w.guests[0].guest;
  let got = null;
  g.onEvent = (n, d) => { if (n === 'sync') got = d.fx; };
  w.room.sync('moved', {
    seat: 1, move: { token: 1, from: 0, to: 5 },
    captures: [{ seat: 0, token: 2 }, { seat: 9, token: 2 }, { hack: '<script>' }],
    home: true, win: false,
    evil: 'alert(1)', deeper: { f: { g: { token: 99, from: 999, to: 9999 } } }
  });
  H.advance(60);
  eq(got.captures, [{ seat: 0, token: 2 }], 'captures filtered');
  eq(got.move, { token: 1, from: 0, to: 5 });
  assert(got.evil === undefined && got.deeper === undefined, 'unknown fields stripped');
  /* rebind events for cleanup */
  cleanup(w);
});

console.log('\nDISCONNECTION & RECONNECTION');
t('player disconnect: detected, broadcast, turns skipped, game completes', () => {
  const w = makeWorld(3);
  let disconnects = 0;
  w.room.onEvent = (n) => { if (n === 'disconnect') disconnects++; };
  const g = w.guests[0];
  /* play until the disconnected seat's absence matters, then cut them off mid-game */
  let i = 0;
  while (w.hostMatch.st.moveNo < 12 && i++ < 400) { H.advance(1400); stepLocal(w.hostMatch); w.guests.forEach(stepGuest); }
  g.gp.close();                      // transport loss
  H.advance(200);
  assert(!w.room.seats[1].connected, 'seat marked disconnected');
  assert(disconnects >= 1, 'disconnect event emitted');
  /* keep playing: the other guest and the host finish the game */
  i = 0;
  while (w.hostMatch.st.phase !== 'over' && i++ < 3000) {
    H.advance(1400);
    stepLocal(w.hostMatch);
    stepGuest(w.guests[1]);
    stepGuest(g);                    // disconnected guest match just stops acting (not connected)
  }
  H.advance(2500);
  assert(w.hostMatch.st.phase === 'over', 'game did not freeze after disconnect');
  w.guests[1].match && eq(w.guests[1].match.st, w.hostMatch.st, 'remaining guest in sync');
  cleanup(w);
});
t('reconnection: same seat token reattaches and receives the live state', () => {
  const w = makeWorld(2);
  const g = w.guests[0];
  let i = 0;
  while (w.hostMatch.st.moveNo < 8 && i++ < 400) { H.advance(1400); stepLocal(w.hostMatch); stepGuest(g); }
  const name = w.room.seats[1].name;
  const movesAtCut = w.hostMatch.st.moveNo;
  g.gp.close();
  H.advance(300);
  assert(!w.room.seats[1].connected);
  /* host re-invites the seat on a fresh transport */
  const meta2 = { room: w.room.id, seat: 1, secret: 'sec1padding' };
  const hp2 = w.vnet.hostPeer(meta2);
  w.room.bindPeer(1, hp2, meta2.secret);
  const gp2 = w.vnet.join(hp2, meta2);
  const guest2 = new Mp.Guest({ peer: gp2, token: meta2.secret, name: 'Impostor', avatar: 3 });
  let resumed = null;
  guest2.onEvent = (n, d) => { if (n === 'welcome') resumed = d; };
  guest2.hello();
  H.advance(200);
  assert(w.room.seats[1].connected, 'reconnected');
  assert(resumed && resumed.resume === true, 'flagged as resume');
  eq(w.room.seats[1].name, name, 'original identity kept');
  assert(w.hostMatch.st.moveNo >= movesAtCut, 'match continued through reconnect');
  guest2.destroy();
  cleanup(w);
});
t('host leaving: every guest is notified and the room terminates', () => {
  const w = makeWorld(3);
  let closed = [];
  w.guests.forEach((u) => {
    u.guest.onEvent = (n, d) => { if (n === 'closed') closed.push({ seat: u.seat, reason: d.reason }); };
  });
  w.room.close('host-left');
  H.advance(100);
  assert(closed.length === w.guests.length, 'all guests got the close message (' + closed.length + '/' + w.guests.length + ')');
  assert(closed.every((c) => c.reason === 'host-left'));
  eq(w.room.state, 'closed');
  cleanup(w);
});
t('interrupted connection (flaky transport) still converges or ends cleanly', () => {
  const w = makeWorld(2, { latency: 40 });
  w.vnet.dropRate = 0;                     // DataChannel is reliable; simulate hard cut instead
  let i = 0;
  while (w.hostMatch.st.moveNo < 10 && i++ < 400) { H.advance(1400); stepLocal(w.hostMatch); stepGuest(w.guests[0]); }
  /* cut and let the host handle the missing player without freezing */
  w.guests[0].gp.close();
  H.advance(14000);                        // ping timeout window
  assert(!w.room.seats[1].connected, 'ping timeout detected the cut');
  i = 0;
  while (w.hostMatch.st.phase !== 'over' && i++ < 3000) { H.advance(1400); stepLocal(w.hostMatch); }
  H.advance(2000);
  assert(w.hostMatch.st.phase === 'over', 'host game ends even with a gone player');
  cleanup(w);
});
t('convert disconnected seat to AI mid-match; remaining guest stays in sync', () => {
  const w = makeWorld(3);
  const g0 = w.guests[0];
  let i = 0;
  while (w.hostMatch.st.moveNo < 6 && i++ < 300) { H.advance(1400); stepLocal(w.hostMatch); w.guests.forEach(stepGuest); }
  g0.gp.close();
  H.advance(200);
  assert(w.room.convertToAi(1, 2), 'seat converted');
  eq(w.room.match.st.seats[1].kind, 'ai');
  i = 0;
  while (w.hostMatch.st.phase !== 'over' && i++ < 3000) {
    H.advance(1400);
    stepLocal(w.hostMatch);           // AI now driven by the host loop
    stepGuest(w.guests[1]);
  }
  H.advance(2500);
  eq(w.guests[1].match.st, w.hostMatch.st, 'surviving guest synchronized after AI takeover');
  cleanup(w);
});
t('endMatch returns a finished room to lobby and broadcasts seats', () => {
  const w = makeWorld(2);
  assert(w.room.state === 'playing', 'playing');
  let seatsEvents = 0;
  const orig = w.room.onEvent;
  w.room.onEvent = (n, d) => { if (n === 'seats') seatsEvents++; orig(n, d); };
  w.room.endMatch();
  eq(w.room.state, 'lobby', 'back to lobby');
  assert(seatsEvents >= 1, 'seats broadcast on return');
  cleanup(w);
});

t('host can end the match early — winner by progress, guests finish too', () => {
  const w = makeWorld(2);
  let i = 0;
  while (w.hostMatch.st.moveNo < 10 && i++ < 300) { H.advance(1400); stepLocal(w.hostMatch); stepGuest(w.guests[0]); }
  w.room.endMatchByHost();
  H.advance(1500);
  eq(w.hostMatch.st.phase, 'over');
  eq(w.guests[0].match.st.phase, 'over', 'guest match finished from the end sync');
  eq(w.guests[0].match.st.winner, w.hostMatch.st.winner);
  cleanup(w);
});

console.log('\nHOST MIGRATION (mesh + election)');
async function migrationWorld(size, crash) {
  const vnet = new Net.VirtualNet({ latency: 12 });
  const room = new Mp.Room({ size, hostName: 'Host' });
  const cfg = room.buildCfg({});
  const guests = [];
  for (let seat = 1; seat < size; seat++) {
    const meta = { room: room.id, seat, secret: 'mig' + seat + 'pad' };
    const hp = vnet.hostPeer(meta);
    room.bindPeer(seat, hp, meta.secret);
    const gp = vnet.join(hp, meta);
    const guest = new Mp.Guest({
      peer: gp, token: meta.secret, name: 'G' + seat, avatar: seat,
      peerFactory: (m) => vnet.meshPeer(m),          // mesh channels over the vnet
      onEvent: function () {}
    });
    const u = { seat, guest, hp, gp, match: null };
    guest.onEvent = (n, d) => {
      if (n === 'start') {
        const c2 = JSON.parse(JSON.stringify(d.cfg));
        c2.netSeat = d.yourSeat;
        const gm = new Game._Match();
        gm.start(H.makeCanvas(600, 600), c2, d.st);
        gm.netGuest = guest; gm.netSeq = d.seq; gm.legal = []; u.match = gm;
      } else if (n === 'sync' && u.match) u.match.netApply(d);
    };
    guest.hello();
    guests.push(u);
  }
  await H.advanceAsync(200);
  const hostMatch = new Game._Match();
  hostMatch.start(H.makeCanvas(600, 600), cfg, null);
  hostMatch.netHost = room;
  room.match = hostMatch;
  room.started();
  hostMatch.begin();
  await H.advanceAsync(500);     // let the promise-driven mesh form
  return { vnet, room, hostMatch, guests };
}
function driveMigrated(w, newHostMatch, followers, maxIters) {
  function stepLocalHost(m) {
    if (!m || m.destroyed || !m.st || m.st.phase === 'over') return;
    if (!m.isLocalSeat(m.st.turn)) return;
    if (m.st.phase === 'roll' && !m.diceBusy) m.rollRequest();
    else if (m.st.phase === 'move') { const l = E.legalMoves(m.st, m.st.lastRoll); if (l.length) m.executeMove(l[Math.floor(rnd() * l.length) % l.length]); }
  }
  function stepFollower(u) {
    const m = u.match;
    if (!m || m.destroyed || !m.st || m.st.phase === 'over') return;
    if (!m.isLocalSeat(m.st.turn)) return;
    if (m.st.phase === 'roll' && !m.diceBusy) m.rollRequest();
    else if (m.st.phase === 'move' && m.legal && m.legal.length) m.executeMove(m.legal[0]);
  }
  let i = 0;
  while (newHostMatch.st.phase !== 'over' && i++ < (maxIters || 6000)) {
    H.advance(1400);
    stepLocalHost(newHostMatch);
    followers.forEach(stepFollower);
  }
  H.advance(2500);
}

tAsync('GRACEFUL host exit: successor adopts and the match completes for everyone', async () => {
  const w = await migrationWorld(3, false);
  let i = 0;
  while (w.hostMatch.st.moveNo < 10 && i++ < 300) { H.advance(1400); stepLocal(w.hostMatch); w.guests.forEach(stepGuest); }
  assert(w.hostMatch.st.moveNo >= 10, 'game underway');
  /* mesh must have formed between the two guests */
  const g1 = w.guests[0].guest, g2 = w.guests[1].guest;
  assert(g1.mesh[2] && g1.mesh[2].open, 'guest1↔guest2 mesh channel open');
  assert(g2.mesh[1] && g2.mesh[1].open, 'guest2↔guest1 mesh channel open');
  /* dice were verified all along */
  assert(g1.dice.verified > 5 && g1.dice.violations === 0, 'commit-reveal verified ' + g1.dice.verified + ' rolls');
  /* HOST LEAVES DELIBERATELY */
  const moveNoAtCut = w.hostMatch.st.moveNo;
  w.room.close('host-left');
  await H.advanceAsync(400);
  /* successor (seat1) received 'migrating' → claims → becomeHost */
  g1._electForced = true; g1.peer.onclose('host-left');
  await H.advanceAsync(2800);
  /* test-side performs the UI take-over for the successor */
  const room2 = Mp.Room.adoptFromGuest(g1);
  assert(room2, 'adoption built a room');
  const cfg2 = JSON.parse(JSON.stringify(g1.mirror.cfg));   // adoptFromGuest normalized remote flags
  cfg2.netSeat = g1.seat;
  cfg2.youColor = cfg2.seats[g1.seat].color;
  const newHost = new Game._Match();
  newHost.start(H.makeCanvas(600, 600), cfg2, JSON.parse(JSON.stringify(g1.mirror.st)));
  newHost.netHost = room2;
  room2.match = newHost;
  room2.newDiceEpoch();
  room2.seats.forEach((s) => {
    if (s.kind === 'remote' && s.connected && s.peer) {
      s.peer.send({ m: 'hostmoved', seat: g1.seat });
      s.peer.send({ m: 'start', cfg: cfg2, st: newHost.st, yourSeat: 2, seq: room2.seq });
      s.peer.send(room2.commitPayload());
    }
  });
  room2.introduceMesh();
  newHost.begin();
  H.advance(600);
  assert(g2.state === 'playing', 'follower rewired to the new host (state ' + g2.state + ')');
  /* continue to completion on the new host */
  driveMigrated(w, newHost, [w.guests[1]], 15000);
  assert(newHost.st.phase === 'over', 'migrated match finished');
  assert(newHost.st.moveNo > moveNoAtCut, 'game continued past the cut');
  const follower = w.guests[1].match;
  assert(follower, 'follower match alive');
  eq(follower.st.winner, newHost.st.winner, 'same winner after migration');
  assert(g2.dice.violations === 0, 'epoch-2 dice also verified');
  newHost.destroy(); room2.close('test-end'); w.guests.forEach((u) => { u.match && u.match.destroy(); u.guest.destroy(); });
});

tAsync('ABRUPT host crash: election timeout promotes the lowest surviving seat', async () => {
  const w = await migrationWorld(2, true);
  let i = 0;
  while (w.hostMatch.st.moveNo < 8 && i++ < 300) { H.advance(1400); stepLocal(w.hostMatch); stepGuest(w.guests[0]); }
  const g1 = w.guests[0].guest;
  assert(g1.mesh && Object.keys(g1.mesh).length === 0, 'no other guest in a 2p room');
  /* crash: no migrating notice at all */
  w.room.state = 'crashed';
  try { w.room.seats[1].peer.close(); } catch (e) {}
  await H.advanceAsync(3400);
  /* alone with a mirror: election claims, adoption proceeds even solo */
  assert(g1.state === 'adopting' || g1.state === 'electing', 'election started (state ' + g1.state + ')');
  const room2 = Mp.Room.adoptFromGuest(g1);
  assert(room2, 'solo adoption works from the mirror');
  const cfg2 = JSON.parse(JSON.stringify(g1.mirror.cfg));   // normalized by adoptFromGuest
  cfg2.netSeat = g1.seat; cfg2.youColor = cfg2.seats[g1.seat].color;
  const newHost = new Game._Match();
  newHost.start(H.makeCanvas(600, 600), cfg2, JSON.parse(JSON.stringify(g1.mirror.st)));
  newHost.netHost = room2; room2.match = newHost;
  newHost.begin();
  H.advance(3000);
  /* disconnected old-host seat is skipped; the successor finishes alone */
  driveMigrated(w, newHost, [], 15000);
  assert(newHost.st.phase === 'over', 'successor completed the abandoned match');
  newHost.destroy(); room2.close('test-end'); w.guests.forEach((u) => { u.match && u.match.destroy(); u.guest.destroy(); });
});

console.log('\nVERIFIABLE DICE (commit–reveal)');
t('every online roll is hash-verified by guests', () => {
  const w = makeWorld(2);
  driveToEnd(w);
  const g = w.guests[0].guest;
  assert(g.dice.comms && g.dice.comms.length > 0, 'commitments received');
  assert(g.dice.verified >= 20, 'verified ' + g.dice.verified + ' rolls');
  eq(g.dice.violations, 0, 'zero violations in an honest game');
  cleanup(w);
});
t('a rigged host (post-hoc die change) is DETECTED', () => {
  const w = makeWorld(2);
  const g = w.guests[0].guest;
  let violations = 0;
  g.onEvent = (n) => { if (n === 'diceViolation') violations++; };
  /* re-sync a forged reveal: right index, wrong salt */
  const st = JSON.parse(JSON.stringify(w.hostMatch.st));
  st.stats[0].rolls++;                       // make it look fresh
  g._onHostRaw(JSON.stringify({ m: 'sync', seq: g.lastSeq + 1, tag: 'rolled',
    fx: { value: 6, salt: 'deadbeefdead', di: g.dice.idx, outcome: 'forfeit', seat: 0 },
    st }));
  H.advance(60);
  eq(violations, 1, 'forged roll flagged');
  eq(g.dice.idx, 0, 'forged roll did not advance the index');
  g.onEvent = null;
  cleanup(w);
});
t('malformed mesh payloads are struck, not relayed', () => {
  const w = makeWorld(3);
  const seat = w.room.seats[1];
  const strikes = seat.strikes || 0;
  w.guests[0].hp.onmessage(JSON.stringify({ m: 'intro-offer', to: 2, payload: { t: 'o', sdp: 'x'.repeat(20000), room: w.room.id, seat: 1 } }));
  w.guests[0].hp.onmessage(JSON.stringify({ m: 'intro-offer', to: 1, payload: { t: 'o', sdp: 'ok', room: w.room.id, seat: 1 } }));
  w.guests[0].hp.onmessage(JSON.stringify({ m: 'intro-answer', to: 99, payload: { t: 'a', sdp: 'ok', room: w.room.id, seat: 1 } }));
  H.advance(80);
  eq(seat.strikes - strikes, 3, 'all three malformed relays struck');
  cleanup(w);
});

console.log('\nCONNECTION CODES');
t('offer/answer codes round-trip and reject malformed input', async () => {
  const payload = { t: 'o', room: 'MAPLE-1234', seat: 2, secret: 'abcdefgh12345678', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' };
  const code = await Net.codePack(payload);
  assert(/^LUD[01]\./.test(code), 'code prefix');
  const back = await Net.codeUnpack(code);
  eq(back, payload);
  eq(await Net.codeUnpack('LUD0.not-base64!!!'), null);
  eq(await Net.codeUnpack('XXXX' + code.slice(4)), null);
  eq(await Net.codeUnpack(''), null);
  /* tampered payload: valid base64, invalid shape */
  const bad = await Net.codeUnpack('LUD0.' + Buffer.from(JSON.stringify({ t: 'x', room: 'A-1', seat: 99, secret: '', sdp: '' })).toString('base64url'));
  eq(bad, null);
});
t('room ids are short, readable, unique-ish', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const id = Net.roomId();
    assert(/^[A-Z]{3,8}-\d{3,5}$/.test(id), id);
    seen.add(id);
  }
  assert(seen.size > 40, 'mostly unique: ' + seen.size);
});

/* async runner: sync tests first, then promise-dependent ones */
(async () => {
  for (const tt of asyncTests) {
    try { await tt.fn(); passed++; console.log('  ✓ ' + tt.name); }
    catch (e) { failed++; console.error('  ✗ ' + tt.name + '\n    ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n') : e)); }
  }
  console.log('\n' + (failed ? '✗ ' + failed + ' FAILED, ' + passed + ' passed' : 'ALL ' + passed + ' MULTIPLAYER TESTS PASSED') + '\n');
  process.exit(failed ? 1 : 0);
})();
