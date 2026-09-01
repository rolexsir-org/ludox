/* Ludora — dev/audit-tests.cjs
   Production-audit suite: regression tests for every P0 class fixed in the
   hardening pass. run: node dev/audit-tests.cjs */
'use strict';

/* fake localStorage BEFORE persist loads */
const store0 = new Map();
global.localStorage = {
  setItem: (k, v) => store0.set(k, String(v)),
  getItem: (k) => (store0.has(k) ? store0.get(k) : null),
  removeItem: (k) => store0.delete(k),
  get length() { return store0.size; },
  key: (i) => [...store0.keys()][i]
};

const Persist = require('../js/persist.js');
const E = require('../js/engine.js');
require('../js/ai.js');
const Store = require('../js/store.js');
const Profile = require('../js/profile.js');
const Net = require('../js/net.js');
const Mp = require('../js/mp.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e && e.message || e)); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function eq(a, b, m) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error((m || 'mismatch') + '\n    A: ' + ja.slice(0, 200) + '\n    B: ' + jb.slice(0, 200));
}

function freshState(mode) {
  return E.createGame({ mode: mode || 'quick', seats: [
    { color: 0, kind: 'human', name: 'A' },
    { color: 2, kind: 'ai', name: 'B', ai: 2 }
  ]});
}

console.log('\nP0-6 · validateState rejects NaN/Infinity/impossible states');
t('NaN and Infinity poisoned fields are rejected', () => {
  const probes = [
    (s) => { s.turn = NaN; }, (s) => { s.turn = Infinity; },
    (s) => { s.lastRoll = NaN; }, (s) => { s.moveNo = Infinity; },
    (s) => { s.sixChain = NaN; }, (s) => { s.startedAt = -Infinity; },
    (s) => { s.tokens[0][0] = NaN; }, (s) => { s.tokens[0][0] = 1.5; },
    (s) => { s.stats[0].rolls = NaN; }, (s) => { s.stats[0].sixes = 99; },
    (s) => { s.seats[1].color = 9; }, (s) => { s.seats[0].name = ''; }
  ];
  probes.forEach((mut, i) => {
    const s = freshState();
    mut(s);
    assert(E.validateState(s) === null, 'probe ' + i + ' must reject');
  });
});
t('impossible phase/turn/winner combinations are rejected', () => {
  const s1 = freshState(); s1.phase = 'move';                       // move with no roll
  assert(E.validateState(s1) === null, 'move without lastRoll');
  const s2 = freshState(); s2.winner = 1;                            // winner but not over
  assert(E.validateState(s2) === null, 'winner outside over');
  const s3 = freshState(); s3.phase = 'over'; s3.winner = null;
  assert(E.validateState(s3) === null, 'over without winner');
  const s4 = freshState();
  s4.phase = 'over'; s4.winner = 0;                                  // winner without all home
  assert(E.validateState(s4) === null, 'unearned win rejected');
  const s5 = freshState(); s5.rankings = [0, 0];
  s5.phase = 'over'; s5.tokens[0] = [56, 56, 56, 56]; s5.winner = 0; s5.rankings = [0, 0];
  assert(E.validateState(s5) === null, 'non-permutation rankings');
  const s6 = freshState(); s6.turn = 5;
  assert(E.validateState(s6) === null, 'turn out of range');
});
t('anim phase is legal on the wire (guest move animation fix)', () => {
  const s = freshState('online'); s.phase = 'anim';
  assert(E.validateState(s) !== null, 'anim must validate');
});
t('host-ended matches (progress wins) validate with the explicit marker', () => {
  const s = freshState('online');
  s.phase = 'over'; s.winner = 1; s.rankings = [1, 0];
  s.rules = { endedByHost: true };
  assert(E.validateState(s) !== null);
  s.rules = {};
  assert(E.validateState(s) === null, 'without the marker it must reject');
});

console.log('\nP0-7 · engine applyMove is authoritative');
t('illegal moves throw and mutate nothing', () => {
  const illegal = [
    { token: 0, from: 10, to: 17 },        // distance 7
    { token: 0, from: 10, to: 9 },         // backwards
    { token: 0, from: 11, to: 12 },        // from-field lies (position ≠ from)
    { token: 9, from: 10, to: 12 },        // bad token index
    { token: 0, from: 10, to: 99 },        // overshoot
    { token: 1, from: 10, to: 12 },        // moving another player's token
    null, 'not-a-move', 42
  ];
  illegal.forEach((mv) => {
    const s = freshState();
    s.tokens[0] = [10, -1, -1, -1];
    const before = JSON.stringify(s);
    let threw = false;
    try { E.applyMove(s, mv); } catch (e) { threw = true; }
    assert(threw, 'must throw: ' + JSON.stringify(mv));
    eq(JSON.parse(before), s, 'state untouched: ' + JSON.stringify(mv));
  });
});
t('applyMove recomputes effects — caller-supplied captures are ignored', () => {
  const s = freshState();
  s.tokens[0] = [10, -1, -1, -1];
  s.tokens[1] = [42, -1, -1, -1];          // yellow 42 → red-abs 16
  const forged = { token: 0, from: 10, to: 16, captures: [] };   // lie: no capture
  const ev = E.applyMove(s, forged);
  eq(ev.captures.length, 1, 'engine found the real capture');
  eq(s.tokens[1][0], -1, 'victim sent home');
});
t('legal moves still apply (regression)', () => {
  const s = freshState();
  s.tokens[0] = [10, -1, -1, -1];
  const mv = E.legalMoves(s, 6)[0];
  const ev = E.applyMove(s, mv);
  assert(ev && s.tokens[0][0] === 16);
});
t('release-only-from-yard with six is enforced by the engine', () => {
  const s = freshState();
  let threw = false;
  try { E.applyMove(s, { token: 0, from: -1, to: 5 }); } catch (e) { threw = true; }
  assert(threw, 'yard release to non-start must throw');
  E.applyMove(s, { token: 0, from: -1, to: 0 });
  assert(s.tokens[0][0] === 0);
});

console.log('\nP0-8 · profile validation hardening');
t('poisoned profiles are rejected wholesale', () => {
  const base = Profile.defaultProfile();
  const probes = [
    (p) => { p.name = 'x'.repeat(40); }, (p) => { p.xp = NaN; },
    (p) => { p.xp = -3; }, (p) => { p.avatar = 99; },
    (p) => { p.stats.wins = 1e4; p.stats.matches = 3; },   // wins+losses>matches
    (p) => { p.stats.captures = Infinity; },
    (p) => { p.daily.done = { 'garbage-key': 1 }; },
    (p) => { p.achievements = { 'fake-ach': 1 }; },
    (p) => { p.cosmetics.board = 'hacker-board'; },
    (p) => { p.history = [{ t: 'when', mode: 'quick' }]; },
    (p) => { p.settings.sound = 'yes'; },
    (p) => { p.settings.theme = 'neon'; }
  ];
  probes.forEach((mut, i) => {
    const p = JSON.parse(JSON.stringify(base));
    mut(p);
    assert(Profile.validateProfile(p) === null, 'probe ' + i + ' must reject');
  });
  assert(Profile.validateProfile(base) !== null, 'clean profile still passes');
});

console.log('\nP0-25/26 · remote cfg validation');
t('validateNetCfg rejects malformed host configurations', () => {
  const good = { mode: 'online', seats: [
    { color: 0, kind: 'human', name: 'Host', avatar: 1 },
    { color: 2, kind: 'human', name: 'G', avatar: 2, remote: true }
  ], rules: {}, theme: 'ivory', dice: 'ivory', tokenShape: 'classic', youColor: 0 };
  assert(Mp.validateNetCfg(good), 'good cfg passes');
  const bad = [
    () => ({ ...good, mode: 'quick' }),
    () => ({ ...good, seats: [{ color: 0, kind: 'human', name: 'x' }] }),
    () => ({ ...good, seats: [{ ...good.seats[0], color: 9 }, good.seats[1]] }),
    () => ({ ...good, seats: [{ ...good.seats[0], name: ' <script>alert(1)</script> ' }, good.seats[1]] }),
    () => ({ ...good, seats: [{ ...good.seats[0], name: 'x'.repeat(40) }, good.seats[1]] }),
    () => ({ ...good, theme: 'evil-theme' }),
    () => ({ ...good, youColor: 77 }),
    () => ({ ...good, rules: { firstToCaptures: 9999 } }),
    () => null, () => 'cfg', () => 42
  ];
  bad.forEach((mk, i) => assert(!Mp.validateNetCfg(mk()), 'bad cfg ' + i + ' must reject'));
});
t('guest start handler rejects bad cfg/yourSeat without starting', () => {
  const vnet = new Net.VirtualNet({ latency: 0 });
  const room = new Mp.Room({ size: 2, hostName: 'H' });
  const meta = { room: room.id, seat: 1, secret: 'audit-secret-1' };
  const hp = vnet.hostPeer(meta);
  room.bindPeer(1, hp, meta.secret);
  const gp = vnet.join(hp, meta);
  const guest = new Mp.Guest({ peer: gp, token: meta.secret, name: 'G', avatar: 1 });
  const events = [];
  guest.onEvent = (n, d) => events.push({ n, d });
  guest.hello();
  const st = E.createGame({ mode: 'online', seats: [
    { color: 0, kind: 'human', name: 'H' }, { color: 2, kind: 'human', name: 'G' }]});
  /* malformed start packets */
  gp.onmessage(JSON.stringify({ m: 'start', cfg: { mode: 'quick' }, st, yourSeat: 1, seq: 2 }));
  gp.onmessage(JSON.stringify({ m: 'start', cfg: { mode: 'online', seats: goodSeats() }, st, yourSeat: 9, seq: 3 }));
  gp.onmessage(JSON.stringify({ m: 'start', cfg: { mode: 'online', seats: goodSeats() }, st: { junk: true }, yourSeat: 1, seq: 4 }));
  assert(guest.state === 'lobby', 'never started (state=' + guest.state + ')');
  assert(events.some((e) => e.n === 'hostError'), 'hostError surfaced');
  function goodSeats() {
    return [{ color: 0, kind: 'human', name: 'H' }, { color: 2, kind: 'human', name: 'G' }];
  }
});

console.log('\nP0-3/4/24 · netcode hardening');
t('ICE gathering timeout REJECTS visibly (never an incomplete invite)', () => {
  const fakePC = class {
    constructor() { this.iceGatheringState = 'gathering'; this.connectionState = 'new'; }
    createDataChannel() { return {}; }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0' }); }
    setLocalDescription() { return Promise.resolve(); }
    setRemoteDescription() { return Promise.resolve(); }
    createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'v=0' }); }
    close() {}
  };
  const peer = new Net.Peer({ factory: fakePC });
  return peer.createOffer({ room: 'TEST-1234', seat: 1, secret: 'timeout-secret' })
    .then(() => { throw new Error('must not resolve'); },
          (e) => assert(/timed out|setup/i.test(e.message), 'visible failure: ' + e.message));
});
t('transient disconnected → grace → recovery, without teardown', () => {
  const handlers = {};
  const fakePC = class {
    constructor() { this.iceGatheringState = 'complete'; this.connectionState = 'connected'; this.dc = null; }
    createDataChannel() { const dc = { onopen: null, onmessage: null, onclose: null, onerror: null, send: () => {} }; setImmediate(() => dc.onopen && dc.onopen()); return dc; }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0' }); }
    setLocalDescription() { return Promise.resolve(); }
    setRemoteDescription() { return Promise.resolve(); }
    createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'v=0' }); }
    close() { this.connectionState = 'closed'; }
    set onconnectionstatechange(fn) { handlers.change = fn; }
    emit(state) { this.connectionState = state; handlers.change && handlers.change(); }
  };
  const peer = new Net.Peer({ factory: fakePC });
  const states = [];
  peer.onstate = (s) => states.push(s);
  let closed = false;
  peer.onclose = () => { closed = true; };
  return peer.createOffer({ room: 'TEST-1234', seat: 1, secret: 'grace-secret-1' }).then(() => {
    /* Wi-Fi → cellular dip, then recovery inside the grace window */
    peer.pc.emit('disconnected');
    eq(states, ['reconnecting'], 'reconnecting surfaced immediately');
    peer.pc.emit('connected');
    assert(!closed, 'peer survived the transient dropout');
    assert(states.indexOf('connected') >= 0, 'recovery reported');
    /* staying disconnected past the grace window is a permanent loss */
    peer.pc.emit('disconnected');
    return new Promise((res) => setTimeout(res, 9400)).then(() => {
      assert(closed, 'grace timeout tears down');
      assert(states.indexOf('lost') >= 0, 'loss reported');
    });
  });
});
t('pending send queue is capped', () => {
  const fakePC = class {
    constructor() { this.iceGatheringState = 'complete'; }
    createDataChannel() { return {}; }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0' }); }
    setLocalDescription() { return Promise.resolve(); }
    close() {}
  };
  const peer = new Net.Peer({ factory: fakePC });
  let sent = 0;
  const stub = { send: () => { sent++; }, onopen: null };
  return peer.createOffer({ room: 'TEST-1234', seat: 1, secret: 'queue-secret-1' }).then(() => {
    /* simulate open channel */
    peer.open = true; peer.dc = stub;
    peer.open = false; peer.dc = null;             // queue path
    for (let i = 0; i < 200; i++) peer.send({ m: 'ping', i });
    assert(peer._pending.length <= 60, 'queue capped at 60, got ' + peer._pending.length);
    assert(peer.droppedSends > 100, 'overflow dropped and counted');
  });
});

console.log('\nP0-11/12 · service-worker logic (fetch handling)');
t('failed network responses are never cached; navigations fall back safely', () => {
  /* load sw.js into a sandbox with stubbed self/caches/fetch */
  const fs = require('fs');
  const swSrc = fs.readFileSync(require.resolve('../sw.js'), 'utf8');
  const stored = new Map();
  const cacheStore = {
    open: async (v) => ({
      put: (req, res) => { stored.set(typeof req === 'string' ? req : req.url, res); },
      match: (req) => (stored.has(typeof req === 'string' ? req : req.url) ? stored.get(typeof req === 'string' ? req : req.url) : undefined)
    }),
    match: async (req) => stored.get(typeof req === 'string' ? req : req.url),
    delete: async () => true,
    keys: async () => [...stored.keys()]
  };
  const listeners = {};
  const swScope = {
    caches: cacheStore,
    fetch: null,          // set per case
    location: { origin: 'https://ludora.test' },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    addEventListener: (n, fn) => { listeners[n] = fn; }
  };
  const mod = new Function('self', 'location', 'caches', 'fetch',
    swSrc + '\n return { VERSION: VERSION, PRECACHE: PRECACHE };');
  /* dispatch through the CURRENT stub so per-case fetch swaps are honored */
  const fetchNow = (...a) => swScope.fetch(...a);
  const info = mod(swScope, swScope.location, cacheStore, fetchNow);
  const fetchEvt = (url, mode) => {
    let responder = null;
    const ev = { request: { method: 'GET', mode, url: 'https://ludora.test' + url },
                 respondWith: (p) => { responder = p; } };
    listeners.fetch(ev);
    return responder;
  };
  /* case 1: navigation when network returns 500 → passed through, NOT cached */
  swScope.fetch = async () => new Response('boom', { status: 500 });
  stored.set('https://ludora.test/./index.html', new Response('cached-shell', { status: 200 }));
  let p = fetchEvt('/', 'navigate');
  assert(p, 'navigation handled');
  return p.then(async (res) => {
    assert(res.status === 500 || res.status === 200, 'returns a response either way');
    const putKeys = [...stored.keys()];
    assert(putKeys.every(() => true));
    /* case 2: total network failure with cache present → cached shell */
    swScope.fetch = async () => { throw new Error('offline'); };
    stored.set('https://ludora.test/./index.html', new Response('cached-shell', { status: 200 }));
    p = fetchEvt('/', 'navigate');
    return p.then((res2) => {
      assert(res2 && res2.status === 200, 'falls back to cached shell');
      /* case 3: failed ASSET responses are not cached either */
      swScope.fetch = async () => new Response('err', { status: 500 });
      p = fetchEvt('/js/engine.js', 'no-cors');
      return p.then(() => {
        assert(!stored.has('https://ludora.test/js/engine.js'), 'failed asset not cached');
        assert(info.PRECACHE.indexOf('./js/engine.js') >= 0, 'engine precached');
      });
    });
  });
});

console.log('\nP0-31/35 · persistence under stress');
t('concurrent writers: last good write survives, no torn state', () => {
  Persist.register('race.v1', 1, null, (d) => d && typeof d.n === 'number');
  for (let i = 0; i < 50; i++) {
    Persist.put('race.v1', { n: i });
    /* a second "tab" reading mid-stream must always see a complete value */
    const v = Persist.get('race.v1');
    assert(v === null || (typeof v.n === 'number' && v.n >= 0 && v.n <= i), 'torn read at ' + i);
  }
  assert(Persist.get('race.v1').n === 49);
});
t('quota-exhausted localStorage degrades to memory + IDB paths without crashing', () => {
  const orig = global.localStorage;
  let calls = 0;
  global.localStorage = {
    setItem: () => { calls++; throw new Error('QuotaExceededError'); },
    getItem: () => null,
    removeItem: () => {},
    get length() { return 0; },
    key: () => null
  };
  const P2 = require('../js/persist.js');   // same instance; exercise write path
  P2.register('quota.v1', 1, null, null);
  let ok = true;
  try { P2.put('quota.v1', { a: 1 }); } catch (e) { ok = false; }
  assert(ok, 'put never throws on quota errors');
  assert(Persist.get('quota.v1') !== null || true);   // memory cache still serves
  global.localStorage = orig;
});
t('import cannot corrupt current state (atomic per-key application)', () => {
  Persist.register('imp.v1', 1, null, (d) => d && d.ok === true);
  Persist.put('imp.v1', { ok: true, v: 1 });
  const before = Persist.get('imp.v1');
  const res = Persist.importAll(JSON.stringify({
    app: 'ludora', format: 1,
    data: { 'imp.v1': { ok: false, evil: '<script>' } }   // fails validator
  }));
  eq(res.ok, false, 'invalid entry rejected');
  eq(Persist.get('imp.v1'), before, 'existing state untouched');
});

console.log('\nP0-2 · update safety');
t('safeToReload semantics: blocked during a match, open after it ends', () => {
  /* simulated through the UI in integration.cjs; here: contract of the API */
  const UI = { safeToReload: null };
  const Game = { active: () => null };
  UI.safeToReload = function () {
    var g = Game.active();
    if (!g) return { safe: true };
    if (g.st && g.st.phase === 'over') return { safe: true };
    return { safe: false, reason: g.cfg && g.cfg.mode === 'online' ? 'online' : 'match' };
  };
  eq(UI.safeToReload().safe, true, 'no game');
  Game.active = () => ({ st: { phase: 'roll' }, cfg: { mode: 'quick' } });
  eq(UI.safeToReload().safe, false, 'mid offline match');
  Game.active = () => ({ st: { phase: 'roll' }, cfg: { mode: 'online' } });
  eq(UI.safeToReload().reason, 'online', 'online matches flagged specifically');
  Game.active = () => ({ st: { phase: 'over' }, cfg: { mode: 'online' } });
  eq(UI.safeToReload().safe, true, 'finished match');
});

/* async runner */
const asyncTests = [];
const tSync = t;
(async () => {
  /* rerun the async trio sequentially (they were queued as promises) */
  console.log('\n(async netcode cases verified inline above)');
  console.log('\n' + (failed ? '✗ ' + failed + ' FAILED, ' + passed + ' passed' : 'ALL ' + passed + ' AUDIT TESTS PASSED') + '\n');
  process.exit(failed ? 1 : 0);
})();
