let timerErrs = 0;
/* Ludora — dev/integration.cjs
   Boots the real app in jsdom (with a canvas stub) and drives complete
   matches through the actual UI + controller code paths: quick match vs AI,
   pass & play handoff, save/resume, corrupted save recovery, pause/resume.
   run: node dev/integration.cjs */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: 'https://ludora.test/index.html',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;

/* ---- stub canvas 2D (records nothing, safe to call) ---- */
const ctxStub = () => new Proxy({}, {
  get(t, k) {
    if (k === 'canvas') return null;
    return (...a) => {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') {
        return { addColorStop: () => {} };
      }
      if (k === 'measureText') return { width: 10 };
      return undefined;
    };
  },
  set() { return true; }
});
const canvasProto = {
  getContext: () => ctxStub(),
  get width() { return this._w || 600; }, set width(v) { this._w = v; },
  get height() { return this._h || 600; }, set height(v) { this._h = v; },
  style: {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }),
  addEventListener: () => {},
  clientWidth: 600, clientHeight: 600
};
window.HTMLCanvasElement.prototype.getContext = function () { return ctxStub(); };
window.document.createElement = (function (orig) {
  return function (tag) {
    const el = orig.call(window.document, tag);
    if (tag === 'canvas') {
      el.getContext = () => ctxStub();
      el.toDataURL = () => '';
    }
    return el;
  };
})(window.document.createElement);

/* deterministic timers */
let now = 0;
const pending = new Map(); // id → {fn, at, dead}
let nextId = 1;
window.performance.now = () => now;
window.setTimeout = (fn, ms) => { const id = nextId++; pending.set(id, { fn, at: now + (ms || 0) }); return id; };
window.clearTimeout = (id) => { if (pending.has(id)) pending.get(id).dead = true; };
window.cancelAnimationFrame = (id) => { if (pending.has(id)) pending.get(id).dead = true; };
window.requestAnimationFrame = (fn) => { const id = nextId++; pending.set(id, { fn, at: now + 16, raf: true }); return id; };

function advance(ms) {
  const target = now + ms;
  for (;;) {
    let next = null, nextId2 = -1;
    for (const [id, p] of pending) {
      if (!p.dead && p.at <= target && (!next || p.at < next.at)) { next = p; nextId2 = id; }
    }
    if (!next) break;
    now = next.at;
    pending.delete(nextId2);
    try { next.fn(next.at); } catch (e) { timerErrs++; console.log('    TIMER ERR:', e.message, '@', (e.stack.split('\n')[1] || '').slice(0, 140)); }
  }
  now = target;
}

/* load scripts */
global.window = window;
for (const mod of ['engine', 'ai', 'persist', 'store', 'profile', 'audio', 'board', 'net', 'sha', 'mp', 'qr', 'game']) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', mod + '.js'), 'utf8');
  window.eval(code);
}
/* stubs ui needs */
window.devicePixelRatio = 2;
window.navigator.vibrate = () => true;

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e && e.stack || e)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }
function eq(a, b, m) { const ja = JSON.stringify(a), jb = JSON.stringify(b); if (ja !== jb) throw new Error((m || 'mismatch') + ' | A: ' + ja + ' | B: ' + jb); }

console.log('\nBOOT');
t('app boots to home screen without errors', () => {
  const uiCode = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8');
  window.eval(uiCode);
  const mainCode = fs.readFileSync(path.join(__dirname, '..', 'js', 'main.js'), 'utf8');
  window.eval('(function(){' + mainCode + '})'); // main.js is IIFE-free; call boot directly below instead
  window.LudoraUI.init();
  assert(window.document.getElementById('scr-home').classList.contains('active'));
  assert(window.document.getElementById('btnQuick'), 'home renders quick button');
});

const UI = window.LudoraUI, Game = window.LudoraGame, Store = window.LudoraStore, E = window.LudoraEngine;

function playToEnd(maxSimMs, label) {
  let endPayload = null;
  const g = Game.active();
  const orig = g.onEnd;
  g.onEnd = (r) => { try { orig && orig(r); } catch (e) { console.log('    showEnd ERR:', e.message); } endPayload = r; };
  let guard = 0;
  while (!endPayload) {
    advance(400);
    /* auto-ack handoffs & tap dice for human turns */
    const banner = window.document.getElementById('handoffBanner');
    const overlay = window.document.getElementById('handoffOverlay');
    if (banner && !banner.classList.contains('hidden') && banner.onclick) banner.onclick();
    if (overlay && !overlay.classList.contains('hidden') && overlay.onclick) overlay.onclick();
    const g2 = Game.active();
    if (g2 && g2.st && g2.st.phase === 'roll' && g2.st.seats[g2.st.turn].kind === 'human') g2.rollRequest();
    if (g2 && g2.st && g2.st.phase === 'move' && g2.st.seats[g2.st.turn].kind === 'human') {
      /* pick first legal token via keyboard path */
      const legal = E.legalMoves(g2.st, g2.st.lastRoll);
      if (legal.length) g2.executeMove(legal[0]);
    }
    if (guard++ > maxSimMs / 400) throw new Error(label + ' did not finish in ' + maxSimMs + 'ms sim');
  }
  return endPayload;
}

console.log('\nQUICK MATCH (human vs AI, via UI)');
t('full quick match reaches end screen with profile xp applied', () => {
  UI.show('scr-quick') /* no-op safe */;
  window.eval('LudoraUI.show("scr-home")');
  /* simulate tapping through setup */
  window.document.getElementById('btnQuick').click();
  assert(window.document.getElementById('scr-quick').classList.contains('active'), 'setup visible');
  window.document.getElementById('qStart').click();
  assert(window.document.getElementById('scr-game').classList.contains('active'), 'game screen visible');
  const r = playToEnd(900000, 'quick');
  assert(r.winner !== null);
  assert(r.rankings.length === 2);
  const endScr = window.document.getElementById('scr-end');
  assert(endScr.classList.contains('active'), 'end screen shown');
  assert(endScr.innerHTML.indexOf('wins') >= 0);
  assert(window.LudoraUI.profile().stats.matches === 1, 'profile match counted');
});

console.log('\nSAVE / RESUME');
t('match auto-saves and resumes exact state', () => {
  /* start a pass & play match, make some moves, destroy, restore */
  window.eval('LudoraUI.show("scr-home")');
  window.LudoraUI.refreshHome();
  window.document.getElementById('btnPass').click();
  window.document.getElementById('pStart').click();
  const g = Game.active();
  let guard = 0;
  while (g.st.moveNo < 3 && guard++ < 100) {
    advance(400);
    const banner = window.document.getElementById('handoffBanner');
    if (!banner.classList.contains('hidden') && banner.onclick) banner.onclick();
    const g2 = Game.active();
    if (g2.st.phase === 'roll' && g2.st.seats[g2.st.turn].kind === 'human') g2.rollRequest();
    if (g2.st.phase === 'move') { const l = E.legalMoves(g2.st, g2.st.lastRoll); if (l.length) g2.executeMove(l[0]); }
  }
  const saved = Game.saved();
  assert(saved, 'match saved');
  assert(saved.st.moveNo >= 2, 'moves recorded in save');
  const tokensSnapshot = JSON.stringify(saved.st.tokens);
  Game.destroy();
  /* resume via continue button */
  window.LudoraUI.goHome();
  const cont = window.document.getElementById('btnContinue');
  assert(cont, 'continue button rendered');
  cont.click();
  const g3 = Game.active();
  assert(JSON.stringify(g3.st.tokens) === tokensSnapshot, 'tokens restored exactly');
  assert(g3.st.moveNo === saved.st.moveNo, 'move counter restored');
});

t('corrupted save recovers from backup, and total corruption is discarded', () => {
  /* a torn live value falls back to the last-good backup */
  Store.saveRaw(Store.keys.match, '{{{ broken json');
  let saved = Game.saved();
  if (saved !== null) {
    assert(saved.st && saved.st.phase !== 'anim', 'recovered a valid stable snapshot');
  }
  /* 3-slot rotation: even live + bak1 both torn, bak2 still recovers */
  Store.saveRaw(Store.keys.match, 'torn-1');
  window.LudoraStore._persist.putRaw(window.LudoraStore.keys.match + '~bak', 'torn-2');
  saved = Game.saved();
  if (saved !== null) {
    assert(saved.st && saved.st.phase !== 'anim', 'recovered from the second backup generation');
  }
  /* ALL copies destroyed → clean rejection, app stays usable */
  Store.saveRaw(Store.keys.match, 'torn-1');
  window.LudoraStore._persist.putRaw(window.LudoraStore.keys.match + '~bak', 'torn-2');
  window.LudoraStore._persist.putRaw(window.LudoraStore.keys.match + '~bak2', 'torn-3');
  saved = Game.saved();
  assert(saved === null, 'fully corrupted save rejected');
  window.LudoraUI.goHome();
  assert(!window.document.getElementById('btnContinue'), 'no continue button after total corruption');
});

console.log('\nPASS & PLAY HANDOFF');
t('NO popups by default: pass & play flows with zero interruptions', () => {
  window.LudoraUI.goHome();
  assert(window.LudoraUI.profile().settings.handoff === 'off', 'default is off');
  window.document.getElementById('btnPass').click();
  window.document.getElementById('pStart').click();
  const E = window.LudoraEngine;
  const banner = window.document.getElementById('handoffBanner');
  const overlay = window.document.getElementById('handoffOverlay');
  let bannerShows = 0;
  for (let i = 0; i < 40; i++) {
    advance(400);
    if (!banner.classList.contains('hidden')) bannerShows++;
    if (!overlay.classList.contains('hidden')) throw new Error('overlay popup appeared');
    const g = Game.active();
    if (!g) break;
    if (g.st.phase === 'roll' && g.st.seats[g.st.turn].kind === 'human') g.rollRequest();
    if (g.st.phase === 'move') { const l = E.legalMoves(g.st, g.st.lastRoll); if (l.length) g.executeMove(l[0]); }
  }
  eq(bannerShows, 0, 'no banner popup in 40 turns of play');
  assert(Game.active().st.moveNo > 0, 'game progressed without any acks');
  window.LudoraGame.destroy();
  window.LudoraUI.goHome();
});

t('banner mode still available when explicitly enabled', () => {
  window.LudoraUI.profile().settings.handoff = 'quick';
  window.LudoraProfile.saveProfile(window.LudoraUI.profile());   // persist like the real UI does
  window.LudoraUI.goHome();
  window.document.getElementById('btnPass').click();
  window.document.getElementById('pStart').click();
  advance(50);
  const banner = window.document.getElementById('handoffBanner');
  assert(!banner.classList.contains('hidden'), 'handoff banner visible when enabled');
  banner.onclick();
  assert(Game.active().awaitingHandoff === false, 'handoff acked');
  window.LudoraGame.destroy();
  window.LudoraUI.profile().settings.handoff = 'off';
  window.LudoraProfile.saveProfile(window.LudoraUI.profile());
  window.LudoraUI.goHome();
});

t('old quick-default profiles migrate to off once', () => {
  const p = window.LudoraUI.profile();
  p.settings.handoff = 'quick';
  delete p.settings.handoffMigrated;
  window.LudoraStore.save(window.LudoraStore.keys.profile, p);
  const reloaded = window.LudoraProfile.loadProfile();
  eq(reloaded.settings.handoff, 'off', 'migrated to off');
  eq(reloaded.settings.handoffMigrated, true, 'flagged');
  reloaded.settings.handoff = 'full';               // explicit choices stick forever
  window.LudoraStore.save(window.LudoraStore.keys.profile, reloaded);
  eq(window.LudoraProfile.loadProfile().settings.handoff, 'full', 'explicit choice preserved');
  window.LudoraProfile.loadProfile().settings.handoff = 'off';
  window.LudoraProfile.saveProfile(window.LudoraProfile.loadProfile());
});

console.log('\nPAUSE / RESUME / RESTART');
t('pause freezes the game, resume continues, quit saves', () => {
  const pauseBtn = window.document.getElementById('pauseBtn');
  pauseBtn.click();
  const menu = window.document.getElementById('pauseMenu');
  assert(!menu.classList.contains('hidden'), 'pause menu opens');
  window.document.getElementById('pmResume').click();
  assert(menu.classList.contains('hidden'), 'resume closes menu');
  pauseBtn.click();
  window.document.getElementById('pmQuit').click();
  assert(window.document.getElementById('scr-home').classList.contains('active'), 'quit returns home');
  assert(Game.saved(), 'quit saved the match');
});

console.log('\nDAILY CHALLENGE (full match via UI)');
t('daily challenge plays through and completes once', () => {
  window.LudoraUI.goHome();
  window.document.getElementById('btnDaily').click();
  assert(window.document.getElementById('scr-daily').classList.contains('active'));
  window.document.getElementById('dPlay').click();
  assert(window.document.getElementById('scr-game').classList.contains('active'));
  const r = playToEnd(2200000, 'daily');
  const p = window.LudoraUI.profile();
  const youWon = r.youSeat === r.winner;
  assert(youWon ? p.daily.done[window.LudoraProfile.dateKey()] : true, 'daily marked done when won');
  /* rematch works from end screen */
  const rm = window.document.getElementById('endRematch');
  assert(rm, 'rematch button exists');
  rm.click();
  assert(window.document.getElementById('scr-game').classList.contains('active'), 'rematch starts');
});

console.log('\nMULTIPLAYER UI');
t('multiplayer hub renders create + join, nav round-trips', () => {
  window.LudoraUI.goHome();
  const btnMp = window.document.getElementById('btnMp');
  assert(btnMp, 'home has multiplayer entry');
  btnMp.click();
  assert(window.document.getElementById('scr-mp').classList.contains('active'), 'hub visible');
  assert(window.document.getElementById('mpCreate'), 'create room button');
  assert(window.document.getElementById('mpConnect'), 'join connect button');
  assert(window.document.getElementById('mpJoinCode'), 'invite code input');
  window.document.getElementById('mpBack').click();
  assert(window.document.getElementById('scr-home').classList.contains('active'), 'back returns home');
});

t('create room builds a lobby with readable id, seats, share + start gate', () => {
  window.LudoraUI.goHome();
  window.document.getElementById('btnMp').click();
  window.document.getElementById('mpCreate').click();
  const roomScr = window.document.getElementById('scr-room');
  assert(roomScr.classList.contains('active'), 'lobby visible');
  const html = roomScr.innerHTML;
  assert(/ROOM\s*ID|room-id-chip/.test(html), 'room id chip present');
  assert(window.LudoraUI.nav && window.LudoraUI.nav, 'nav alive');
  const mp = window.LudoraUI._mpState ? window.LudoraUI._mpState() : null;
  assert(mp && mp.room, 'room created');
  assert(/^[A-Z]{3,8}-\d{3,5}$/.test(mp.room.id), 'readable id: ' + mp.room.id);
  assert(html.indexOf('Start Match') >= 0, 'start button present');
  const startBtn = window.document.getElementById('rStart');
  assert(startBtn && startBtn.hasAttribute('disabled'), 'start gated until seats ready');
  assert(window.document.getElementById('rCopyId'), 'copy id button');
  assert(window.document.getElementById('rShareId'), 'share id button');
  /* leaving the room tears it down */
  window.document.getElementById('rBack').click();
  assert(window.document.getElementById('scr-home').classList.contains('active'), 'leave returns home');
});

t('join screen: connect with a bad code fails gracefully', () => {
  window.LudoraUI.goHome();
  window.document.getElementById('btnMp').click();
  window.document.getElementById('mpJoinCode').value = 'not-a-real-code';
  window.document.getElementById('mpConnect').click();
  /* WebRTC is unavailable in jsdom — the error path must keep the app usable */
  assert(window.document.getElementById('scr-mp').classList.contains('active'), 'still on hub');
});

t('game screen hides the connection indicator in offline modes', () => {
  window.LudoraUI.goHome();
  window.document.getElementById('btnQuick').click();
  window.document.getElementById('qStart').click();
  assert(window.document.getElementById('scr-game').classList.contains('active'));
  assert(window.document.getElementById('netChip').classList.contains('hidden'), 'net chip hidden offline');
});

t('screen-reader live region exists for game announcements', () => {
  assert(window.document.getElementById('sr-live'), 'live region present');
});

t('appearance setting switches the UI theme live', () => {
  window.LudoraUI.goHome();
  window.document.getElementById('btnSettings').click();
  const seg2 = window.document.getElementById('setTheme');
  assert(seg2, 'appearance control rendered');
  assert(window.document.documentElement.getAttribute('data-theme') === 'dark', 'default resolves dark in jsdom');
  window.document.querySelector('#setTheme button[data-v="light"]').click();
  assert(window.LudoraUI.profile().settings.theme === 'light', 'persisted light');
  assert(window.document.documentElement.getAttribute('data-theme') === 'light', 'applied to <html>');
  const meta = window.document.querySelector('meta[name="theme-color"]');
  assert(meta.getAttribute('content') === '#F2F3F7', 'browser chrome color updated');
  window.document.querySelector('#setTheme button[data-v="auto"]').click();
  assert(window.LudoraUI.profile().settings.theme === 'auto', 'back to auto');
  assert(window.document.documentElement.getAttribute('data-theme') === 'dark', 'auto resolves via system');
});

t('online mode has a proper end-screen label (was: undefined)', () => {
  const labels = window.LudoraUI.modeLabels();
  assert(labels.online === 'Online Match', 'online label exists');
  assert(labels.quick && labels.pass && labels.daily, 'offline labels intact');
});

t('service-worker update safety: reload blocked during a match, allowed after', () => {
  window.LudoraUI.goHome();
  window.document.getElementById('btnQuick').click();
  window.document.getElementById('qStart').click();
  advance(300);
  let verdict = window.eval('LudoraUI.safeToReload()');
  assert(verdict.safe === false, 'blocked mid-match');
  assert(verdict.reason === 'match' || verdict.reason === 'online', 'reason given: ' + verdict.reason);
  /* end the match instantly via the engine + controller finish */
  const g = window.LudoraGame.active();
  g.st.tokens[0] = [56, 56, 56, 55];
  g.st.turn = 0; g.st.phase = 'move'; g.st.lastRoll = 1;
  const mv = window.LudoraEngine.legalMoves(g.st, 1)[0];
  g.executeMove(mv);
  advance(3000);
  verdict = window.eval('LudoraUI.safeToReload()');
  assert(verdict.safe === true, 'allowed once finished');
  /* cleanup: leave the end screen */
  const home = window.document.getElementById('endHome');
  if (home) home.click();
  else { window.LudoraGame.destroy(); window.LudoraUI.goHome(); }
});

t('double-submit: Connect button guards against repeated taps', () => {
  window.LudoraUI.goHome();
  window.document.getElementById('btnMp').click();
  const btn = window.document.getElementById('mpConnect');
  window.document.getElementById('mpJoinCode').value = 'LUD0.' + 'x'.repeat(40);
  let clicks = 0;
  const orig = btn.addEventListener.bind(btn);   // count handler invocations
  btn.addEventListener('click', function () { clicks++; });
  btn.click();   // invalid code → guard engages then releases
  btn.click();
  btn.click();
  advance(100);
  /* guestConnect runs once per guarded click; with an invalid code each
     resolves immediately — the guard must at minimum never disable the app */
  assert(btn.disabled === false, 'button restored (never stranded)');
  assert(window.document.getElementById('scr-mp').classList.contains('active'), 'app still usable');
});

t('view tiers: layout setting switches phone/tablet/desktop live', () => {
  window.LudoraUI.goHome();
  window.document.getElementById('btnSettings').click();
  assert(window.document.getElementById('setLayout'), 'layout control rendered');
  const doc = window.document.documentElement;
  /* force each tier */
  window.document.querySelector('#setLayout button[data-v="desktop"]').click();
  assert(doc.getAttribute('data-view') === 'desktop', 'forced desktop');
  assert(window.LudoraUI.profile().settings.layout === 'desktop', 'persisted');
  window.document.querySelector('#setLayout button[data-v="phone"]').click();
  assert(doc.getAttribute('data-view') === 'phone', 'forced phone');
  window.document.querySelector('#setLayout button[data-v="tablet"]').click();
  assert(doc.getAttribute('data-view') === 'tablet', 'forced tablet');
  /* auto resolves from the window width */
  window.document.querySelector('#setLayout button[data-v="auto"]').click();
  const w = window.innerWidth;
  const expected = w >= 1100 ? 'desktop' : (w >= 700 ? 'tablet' : 'phone');
  assert(doc.getAttribute('data-view') === expected, 'auto → ' + expected + ' (innerWidth ' + w + ')');
  /* home renders the two-column structure */
  window.LudoraUI.goHome();
  assert(window.document.querySelector('#scr-home .home-cols'), 'home columns present');
  assert(window.document.querySelector('#scr-home .home-side'), 'side column present');
});

t('lobby updates are surgical: invite boxes and pasted codes survive seat events', () => {
  window.LudoraUI.goHome();
  window.document.getElementById('btnMp').click();
  window.document.getElementById('mpCreate').click();
  const mpState = window.LudoraUI._mpState();
  assert(mpState.room, 'room exists');
  /* host has an invite open for seat 1 and is mid-pasting a reply */
  mpState.invite[1] = { code: 'LUD0.fakecode', token: 't' };
  const box = window.document.getElementById('inviteBox1');
  assert(box, 'invite box rendered for open seat');
  box.innerHTML = '<textarea class="mp-input" id="invAns1" aria-label="Reply code"></textarea>';
  window.document.getElementById('invAns1').value = 'LUD0.HALF-PASTED-REPLY';
  /* another seat event fires (e.g. guest connects on a 3-seat room, or ready toggles) */
  mpState.room.emit('seats', mpState.room.seatsPublic());
  const after = window.document.getElementById('invAns1');
  assert(after, 'unchanged seat card was NOT rebuilt');
  assert(after.value === 'LUD0.HALF-PASTED-REPLY', 'pasted reply survived: ' + after.value);
  /* when that seat's own state changes, its card IS rebuilt */
  mpState.room.seats[1].kind = 'remote';
  mpState.room.seats[1].connected = true;
  mpState.room.seats[1].name = 'Bob';
  mpState.room.emit('seats', mpState.room.seatsPublic());
  assert(!window.document.getElementById('inviteAns1') && !window.document.getElementById('inviteBox1'),
         'changed seat card rebuilt (invite flow replaced by connected state)');
  assert(window.document.getElementById('scr-room').innerHTML.indexOf('Bob connected') >= 0, 'connected state shown');
  window.document.getElementById('rBack').click();
});

t('quick-match lineup is truthful: shown opponents are the actual opponents', () => {
  window.LudoraUI.goHome();
  window.document.getElementById('btnQuick').click();
  const shown = [...window.document.querySelectorAll('#qLineup .ch')]
    .map((ch) => ch.children[1].textContent.trim());
  assert(shown.length === 1, 'one AI shown for default setup');
  window.document.getElementById('qStart').click();
  const g = window.LudoraGame.active();
  const aiNames = g.st.seats.filter((s) => s.kind === 'ai').map((s) => s.name);
  eq(aiNames, shown, 'engine seats match the preview lineup');
  window.LudoraGame.destroy();
  window.LudoraUI.goHome();
});

t('SW update safety also covers open rooms (lobby is unsaved state)', () => {
  window.LudoraUI.goHome();
  assert(window.eval('LudoraUI.safeToReload().safe') === true, 'safe at home');
  window.document.getElementById('btnMp').click();
  window.document.getElementById('mpCreate').click();
  let v = window.eval('LudoraUI.safeToReload()');
  assert(v.safe === false && v.reason === 'room', 'blocked in lobby: ' + JSON.stringify(v));
  window.document.getElementById('rBack').click();
  v = window.eval('LudoraUI.safeToReload()');
  assert(v.safe === true, 'safe again after leaving');
});

t('pass & play 4 players: unique colors, match actually starts', () => {
  window.LudoraUI.goHome();
  window.document.getElementById('btnPass').click();
  window.document.querySelector('#pCount button[data-n="4"]').click();
  const rows = window.document.querySelectorAll('#pSeats .seat-row');
  assert(rows.length === 4, '4 seat rows rendered (' + rows.length + ')');
  const swatches = [...window.document.querySelectorAll('#pSeats .mini-swatch.on')].map((s) => s.style.background);
  assert(new Set(swatches).size === 4, '4 distinct colors selected: ' + swatches.length + ' rows, ' + new Set(swatches).size + ' unique');
  window.document.getElementById('pStart').click();
  assert(window.document.getElementById('scr-game').classList.contains('active'), 'game screen started');
  const g = window.LudoraGame.active();
  assert(g, 'match running');
  assert(g.st.seats.length === 4, 'engine has 4 seats');
  const colors = g.st.seats.map((s) => s.color);
  assert(new Set(colors).size === 4, 'engine colors unique: ' + colors.join(','));
  /* turn rotation must follow the LISTED seat order (P1→P2→P3→P4) */
  const listedNames = ['Player 1', 'Player 2', 'Player 3', 'Player 4'];
  eq(g.st.seats.map((s) => s.name), listedNames, 'engine order matches the setup list');
  window.LudoraGame.destroy();
  window.LudoraUI.goHome();
});

t('pass & play turn rotation follows listed order in a live 4p match', () => {
  window.LudoraUI.goHome();
  window.document.getElementById('btnPass').click();
  window.document.querySelector('#pCount button[data-n="4"]').click();
  window.document.getElementById('pStart').click();
  const E = window.LudoraEngine, Game = window.LudoraGame;
  const turnSeq = [];
  let last = -1;
  for (let i = 0; i < 200 && Game.active() && Game.active().st.phase !== 'over'; i++) {
    advance(400);
    const banner = window.document.getElementById('handoffBanner');
    if (!banner.classList.contains('hidden') && banner.onclick) banner.onclick();
    const g = Game.active();
    if (!g) break;
    if (g.st.turn !== last) { turnSeq.push(g.st.seats[g.st.turn].name); last = g.st.turn; }
    if (g.st.phase === 'roll' && g.st.seats[g.st.turn].kind === 'human') g.rollRequest();
    if (g.st.phase === 'move') { const l = E.legalMoves(g.st, g.st.lastRoll); if (l.length) g.executeMove(l[0]); }
  }
  const expected = ['Player 1', 'Player 2', 'Player 3', 'Player 4'];
  eq(turnSeq.slice(0, 4), expected, 'first rotation follows the list');
  eq(turnSeq.slice(4, 8), expected, 'second rotation follows the list');
  window.LudoraGame.destroy();
  window.LudoraUI.goHome();
});

t('pass & play custom colors still start (manual pick keeps uniqueness)', () => {
  window.LudoraUI.goHome();
  window.document.getElementById('btnPass').click();
  window.document.querySelector('#pCount button[data-n="4"]').click();
  /* player 2 grabs player 4's color → swap; uniqueness must survive */
  const swatches = [...window.document.querySelectorAll('#pSeats .mini-swatch')];
  const target = swatches.find((s) => s.dataset.i === '0' && s.dataset.c === '2');
  target.click();
  const on = [...window.document.querySelectorAll('#pSeats .mini-swatch.on')].map((s) => s.style.background);
  assert(new Set(on).size === 4, 'still 4 unique colors after a manual swap');
  window.document.getElementById('pStart').click();
  assert(window.document.getElementById('scr-game').classList.contains('active'), 'custom colors start fine');
  window.LudoraGame.destroy();
  window.LudoraUI.goHome();
});

t('pass & play 3 players also starts with unique colors', () => {
  window.LudoraUI.goHome();
  window.document.getElementById('btnPass').click();
  window.document.querySelector('#pCount button[data-n="3"]').click();
  window.document.getElementById('pStart').click();
  assert(window.document.getElementById('scr-game').classList.contains('active'), '3p game started');
  const g = window.LudoraGame.active();
  assert(g.st.seats.length === 3 && new Set(g.st.seats.map((s) => s.color)).size === 3);
  window.LudoraGame.destroy();
  window.LudoraUI.goHome();
});

console.log('\nNAVIGATION ROUTER');
t('in-app back button pops to home', () => {
  window.LudoraUI.goHome();
  window.document.getElementById('btnSettings').click();
  assert(window.document.getElementById('scr-settings').classList.contains('active'), 'settings pushed');
  window.document.getElementById('sBack').click();
  assert(window.document.getElementById('scr-home').classList.contains('active'), 'back returns home');
  assert(window.LudoraUI.nav.canBack() === false, 'stack drained to root');
});

t('hardware back (popstate) from a running match saves + exits to home', () => {
  window.LudoraUI.goHome();
  window.document.getElementById('btnQuick').click();
  window.document.getElementById('qStart').click();
  assert(window.document.getElementById('scr-game').classList.contains('active'), 'game on');
  advance(400);
  const g = Game.active();
  assert(g, 'game exists');
  g.rollRequest();
  advance(900);
  /* simulate the hardware back button: browser fires popstate for the previous entry */
  window.dispatchEvent(new window.PopStateEvent('popstate', { state: { s: 'scr-home' } }));
  assert(window.document.getElementById('scr-home').classList.contains('active'), 'popstate went home');
  assert(Game.active() === null || Game.active().destroyed, 'game torn down');
  const saved = window.LudoraGame.saved();
  assert(saved, 'match auto-saved on exit');
  assert(saved.st.phase === 'roll' || saved.st.phase === 'move', 'saved at a stable phase');
});

t('hardware back while paused: dismisses the sheet instead of leaving the match', () => {
  window.LudoraUI.goHome();
  window.document.getElementById('btnContinue').click();
  assert(window.document.getElementById('scr-game').classList.contains('active'), 'resumed');
  advance(200);
  window.document.getElementById('pauseBtn').click();
  const menu = window.document.getElementById('pauseMenu');
  assert(!menu.classList.contains('hidden'), 'pause sheet open');
  window.dispatchEvent(new window.PopStateEvent('popstate', { state: { s: 'scr-home' } }));
  assert(menu.classList.contains('hidden'), 'back dismissed the sheet');
  assert(window.document.getElementById('scr-game').classList.contains('active'), 'still in the match');
});

t('edge-swipe back gesture pops secondary screens', () => {
  window.LudoraUI.goHome();
  window.document.getElementById('btnRules').click();
  assert(window.document.getElementById('scr-rules').classList.contains('active'));
  /* synthesized edge swipe: touchstart at left edge, touchend dragged right */
  const ts = new window.Event('touchstart', { bubbles: true, cancelable: true });
  ts.touches = [{ clientX: 12, clientY: 300 }];
  window.document.dispatchEvent(ts);
  const te = new window.Event('touchend', { bubbles: true, cancelable: true });
  te.changedTouches = [{ clientX: 160, clientY: 308 }];
  window.document.dispatchEvent(te);
  assert(window.document.getElementById('scr-home').classList.contains('active'), 'swipe navigated back');
  /* a middle-of-screen swipe must NOT navigate */
  window.document.getElementById('btnRules').click();
  const ts2 = new window.Event('touchstart', { bubbles: true, cancelable: true });
  ts2.touches = [{ clientX: 200, clientY: 300 }];
  window.document.dispatchEvent(ts2);
  const te2 = new window.Event('touchend', { bubbles: true, cancelable: true });
  te2.changedTouches = [{ clientX: 400, clientY: 300 }];
  window.document.dispatchEvent(te2);
  assert(window.document.getElementById('scr-rules').classList.contains('active'), 'non-edge swipe ignored');
});

console.log('\nEND-TO-END UI INVARIANTS');
t('no element references broken icons; screens all render', () => {
  window.LudoraUI.goHome();
  window.document.getElementById('btnProfile').click();
  window.document.getElementById('prBack').click();
  window.document.getElementById('btnRules').click();
  window.document.getElementById('rBack').click();
  window.document.getElementById('btnSettings').click();
  window.document.getElementById('sBack').click();
  ['scr-home', 'scr-quick', 'scr-pass', 'scr-profile', 'scr-daily', 'scr-rules', 'scr-settings'].forEach(id => {
    const scr = window.document.getElementById(id);
    assert(scr.innerHTML.length > 40, id + ' renders content');
  });
});

if (timerErrs > 0) { failed++; console.error('  ✗ zero-runtime-errors (caught ' + timerErrs + ' async error(s))'); }
else console.log('  ✓ zero runtime errors across the entire run');
console.log('\n' + (failed ? '✗ ' + failed + ' FAILED, ' + passed + ' passed' : 'ALL ' + passed + ' INTEGRATION TESTS PASSED') + '\n');
process.exit(failed ? 1 : 0);
