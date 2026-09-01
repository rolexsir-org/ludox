/* =========================================================================
   Ludora — profile.js
   Player persistence: XP/level curve, match statistics, streaks, daily
   challenge roster, cosmetics with level unlocks, achievements, match
   history, and settings. Everything is validated before it is trusted.
   ========================================================================= */
(function (global) {
  'use strict';
  var Store = global.LudoraStore;
  var Persist = global.LudoraPersist;
  var E = global.LudoraEngine;
  var BOARD_THEMES = global.LudoraBoard ? global.LudoraBoard.THEMES : null;

  /* ---------- level curve ---------- */
  function xpForNext(level) { return 100 + (level - 1) * 60; }
  function levelFromXp(xp) {
    xp = Math.max(0, Math.floor(xp || 0));
    var lvl = 1, cum = 0;
    for (;;) {
      var need = xpForNext(lvl);
      if (cum + need > xp) break;
      cum += need;
      lvl++;
    }
    return { level: lvl };
  }

  /* ---------- cosmetics ---------- */
  function boardList() {
    var ids = BOARD_THEMES ? Object.keys(BOARD_THEMES) : ['ivory', 'walnut', 'midnight', 'sakura', 'arctic', 'canyon', 'emerald', 'aurora', 'royal'];
    var order = ['ivory', 'walnut', 'midnight', 'sakura', 'arctic', 'canyon', 'emerald', 'aurora', 'royal'];
    return order.filter(function (id) { return ids.indexOf(id) >= 0; }).map(function (id, i) {
      return { id: id + '-b', theme: id, name: (BOARD_THEMES && BOARD_THEMES[id] && BOARD_THEMES[id].name) || id, level: i === 0 ? 1 : (i <= 2 ? 4 : i <= 4 ? 5 : i <= 6 ? 6 : 8) };
    });
  }
  function diceList() {
    var ids = ['ivory', 'rose', 'slate', 'gold', 'emerald', 'obsidian'];
    return ids.map(function (id, i) { return { id: id + '-d', theme: id, name: id[0].toUpperCase() + id.slice(1), level: i === 0 ? 1 : (i <= 2 ? 4 : i <= 4 ? 6 : 8) }; });
  }
  function tokenList() {
    var ids = ['classic', 'orb', 'gem', 'regal'];
    return ids.map(function (id, i) { return { id: id + '-t', theme: id, name: id[0].toUpperCase() + id.slice(1), level: i === 0 ? 1 : (i === 1 ? 3 : i === 2 ? 6 : 9) }; });
  }

  var COSMETICS = {
    boards: boardList(),
    dice: diceList(),
    tokens: tokenList()
  };

  var ACHIEVEMENTS = {
    'first-win':    { name: 'First Victory',   desc: 'Win your first match.' },
    'mastermind':   { name: 'Mastermind',      desc: 'Defeat a Hard AI opponent.' },
    'capturer':     { name: 'The Tactician',   desc: 'Capture 10 tokens in total.' },
    'streak-3':     { name: 'On a Roll',       desc: 'Win 3 matches in a row.' },
    'streak-7':     { name: 'Unstoppable',     desc: 'Win 7 matches in a row.' },
    'daily-3':      { name: 'Habit Builder',   desc: 'Complete 3 daily challenges.' },
    'social':       { name: 'Connected',       desc: 'Play an online match.' }
  };

  function isUnlocked(cosmetic, prof) {
    if (!cosmetic) return false;
    return levelFromXp(prof.xp).level >= (cosmetic.level || 1);
  }

  /* ---------- defaults ---------- */
  function defaultProfile() {
    return {
      v: 2,
      name: 'Player',
      avatar: 0,
      createdAt: Date.now(),
      xp: 0,
      stats: {
        matches: 0, wins: 0, losses: 0,
        captures: 0, timesCaptured: 0, sixes: 0, homes: 0,
        streak: 0, bestStreak: 0,
        onlineMatches: 0, onlineWins: 0
      },
      daily: { streak: 0, best: 0, done: {}, last: null },
      achievements: {},
      cosmetics: { owned: ['ivory-b'], board: 'ivory', dice: 'ivory', token: 'classic' },
      history: [],
      settings: { sound: true, haptics: true, animSpeed: 'fast', handoff: 'off', handoffMigrated: true, theme: 'auto', layout: 'auto' }
    };
  }

  /* ---------- validation ---------- */
  function isInt(v, lo, hi) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= lo && (hi === undefined || v <= hi);
  }
  function isCount(v) { return typeof v === 'number' && isFinite(v) && v >= 0; }
  var BOARD_IDS = COSMETICS.boards.map(function (b) { return b.theme; });
  var DICE_IDS = COSMETICS.dice.map(function (d) { return d.theme; });
  var TOKEN_IDS = COSMETICS.tokens.map(function (t) { return t.theme; });

  function isValidDateKey(k) { return typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k); }

  function validateProfile(prof) {
    try {
      if (!prof || typeof prof !== 'object') return null;
      if (prof.v !== 1 && prof.v !== 2) return null;
      if (typeof prof.name !== 'string' || prof.name.length < 1 || prof.name.length > 24) return null;
      if (!isCount(prof.xp)) return null;
      if (!isInt(prof.avatar, 0, 7)) return null;
      var st = prof.stats;
      if (!st || typeof st !== 'object') return null;
      ['matches', 'wins', 'losses', 'captures', 'timesCaptured', 'sixes', 'homes', 'streak', 'bestStreak', 'onlineMatches', 'onlineWins'].forEach(function (f) {
        if (!isInt(st[f] || 0, 0)) throw new Error('stats.' + f);
      });
      if (st.wins + st.losses > st.matches) return null;
      var d = prof.daily;
      if (!d || typeof d !== 'object') return null;
      if (!isInt(d.streak || 0, 0) || !isInt(d.best || 0, 0)) return null;
      if (d.done && typeof d.done === 'object') {
        var ks = Object.keys(d.done);
        for (var i = 0; i < ks.length; i++) if (!isValidDateKey(ks[i])) return null;
      }
      if (d.last != null && !isValidDateKey(d.last)) return null;
      var ach = prof.achievements;
      if (!ach || typeof ach !== 'object') return null;
      var aks = Object.keys(ach);
      for (var a = 0; a < aks.length; a++) {
        if (!ACHIEVEMENTS[aks[a]]) return null;
        if (!isInt(ach[aks[a]], 0)) return null;
      }
      var cm = prof.cosmetics;
      if (!cm || typeof cm !== 'object' || !Array.isArray(cm.owned)) return null;
      if (BOARD_IDS.indexOf(cm.board) < 0) return null;
      if (DICE_IDS.indexOf(cm.dice) < 0) return null;
      if (TOKEN_IDS.indexOf(cm.token) < 0) return null;
      if (!Array.isArray(prof.history)) return null;
      for (var h = 0; h < prof.history.length; h++) if (!validHistory(prof.history[h])) return null;
      var se = prof.settings || {};
      if (typeof se.sound !== 'boolean' || typeof se.haptics !== 'boolean') return null;
      if (['fast', 'normal'].indexOf(se.animSpeed) < 0) return null;
      if (['off', 'quick', 'full'].indexOf(se.handoff) < 0) return null;
      if (['auto', 'light', 'dark'].indexOf(se.theme) < 0) return null;
      if (se.layout != null && ['auto', 'phone', 'tablet', 'desktop'].indexOf(se.layout) < 0) return null;
      if (se.handoffMigrated != null && typeof se.handoffMigrated !== 'boolean') return null;
      return prof;
    } catch (e) { return null; }
  }

  function validHistory(h) {
    if (!h || typeof h !== 'object') return false;
    if (!isInt(h.t, 0)) return false;
    if (typeof h.mode !== 'string' || ['quick', 'pass', 'daily', 'online'].indexOf(h.mode) < 0) return false;
    if (typeof h.result !== 'string') return false;
    if (!Array.isArray(h.seatNames) || h.seatNames.length < 2) return false;
    return true;
  }

  /* ---------- date helpers ---------- */
  function dateKey(date) {
    var d = date || new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }
  function yesterdayKey() { return dateKey(new Date(Date.now() - 86400000)); }

  /* ---------- daily roster (seeded, deterministic) ---------- */
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var AI_NAMES = ['Aria', 'Rohan', 'Mila', 'Kabir', 'Zara', 'Dev', 'Nina', 'Arjun', 'Tara', 'Vikram'];
  function dailyFor(dateStr) {
    var seed = hashStr(dateStr || dateKey());
    var rnd = mulberry32(seed);
    var types = [
      { type: 'climb', name: 'Summit Run', desc: 'Race to get all four home.' },
      { type: 'duel', name: 'Twin Duel', desc: 'Two players. One winner.' },
      { type: 'rush', name: 'First Blood', desc: 'First to two captures wins.' },
      { type: 'defense', name: 'Stay Safe', desc: 'Protect your tokens on the path.' }
    ];
    var t = types[Math.floor(rnd() * types.length)];
    var seatCount = 2 + Math.floor(rnd() * 2); // 2 or 3
    var order = [0, 2, 1];
    var seats = [];
    for (var i = 0; i < seatCount; i++) {
      seats.push({
        color: order[i],
        kind: 'ai',
        name: AI_NAMES[Math.floor(rnd() * AI_NAMES.length)],
        ai: Math.floor(rnd() * 3)
      });
    }
    seats[0] = { color: order[0], kind: 'human', name: 'You' };
    var rules = {};
    if (t.type === 'rush') rules.firstToCaptures = 2;
    if (rnd() < 0.25) {
      var hc = seatCount === 2 ? 2 : Math.floor(rnd() * 3) + 2;
      var hs = {};
      hs[2] = [0, 1, 2, 3].map(function () { return Math.floor(rnd() * 20); });
      rules.headStart = hs;
      void hc;
    }
    return { type: t.type, name: t.name, desc: t.desc, seats: seats, rules: rules };
  }

  /* ---------- achievements / cosmetics ---------- */
  function grantAchievements(prof, res, newAch) {
    var now = Date.now();
    function grant(id) {
      if (prof.achievements[id]) return;
      prof.achievements[id] = now;
      newAch.push({ id: id });
    }
    var youWon = res.youSeat != null && res.youSeat === res.winnerSeat;
    if (youWon) grant('first-win');
    if (youWon && res.hardWin) grant('mastermind');
    if (prof.stats.captures >= 10) grant('capturer');
    if (prof.stats.streak >= 3) grant('streak-3');
    if (prof.stats.streak >= 7) grant('streak-7');
    if (prof.daily.streak >= 3) grant('daily-3');
    if (prof.stats.onlineMatches >= 1) grant('social');
  }
  function syncCosmetics(prof) {
    var lvl = levelFromXp(prof.xp).level;
    var owned = prof.cosmetics.owned;
    COSMETICS.boards.concat(COSMETICS.dice, COSMETICS.tokens).forEach(function (c) {
      if (c.level <= lvl && owned.indexOf(c.id) < 0) owned.push(c.id);
    });
  }

  /* ---------- match result application ---------- */
  function applyMatchResult(prof, res) {
    var newAch = [];
    var youWon = res.youSeat != null && res.youSeat === res.winnerSeat;
    var isDaily = res.mode === 'daily';
    var isOnline = res.mode === 'online';
    var isPass = res.mode === 'pass';
    var dailyCounted = false;

    prof.stats.matches++;
    if (isOnline) prof.stats.onlineMatches++;

    var xp = 0;
    if (isPass) {
      /* pass & play is neutral: no win/loss, flat xp */
      xp = 20;
    } else if (youWon) {
      prof.stats.wins++;
      if (isOnline) prof.stats.onlineWins++;
      prof.stats.streak++;
      prof.stats.bestStreak = Math.max(prof.stats.bestStreak, prof.stats.streak);
      xp += res.hardWin ? 130 : 80;
    } else {
      prof.stats.losses++;
      prof.stats.streak = 0;
      xp += res.mode === 'online' ? 50 : 40;
    }

    if (res.you) {
      prof.stats.captures += res.you.captures | 0;
      prof.stats.sixes += res.you.sixes | 0;
      prof.stats.timesCaptured += res.you.timesCaptured | 0;
      prof.stats.homes += res.you.homes | 0;
      if (!isPass) xp += (res.you.captures | 0) * 4 + (res.you.sixes | 0) * 1;
    }

    if (isDaily) {
      var dk = dateKey();
      if (!prof.daily.done[dk]) {
        dailyCounted = true;
        prof.daily.done[dk] = true;
        if (prof.daily.last == null) prof.daily.streak = 1;
        else if (prof.daily.last === dk) { /* already today */ }
        else if (prof.daily.last === yesterdayKey()) prof.daily.streak += 1;
        else prof.daily.streak = 1;
        prof.daily.last = dk;
        prof.daily.best = Math.max(prof.daily.best, prof.daily.streak);
        xp += 150;
      }
      if (youWon) xp += 170;
    }

    prof.xp += xp;
    grantAchievements(prof, res, newAch);
    syncCosmetics(prof);

    /* history */
    var result = youWon ? 'w' : 'l';
    if (isPass) result = 'p';
    if (isOnline) result = youWon ? 'w' : 'l';
    prof.history.unshift({
      t: Date.now(),
      mode: res.mode,
      result: result,
      winnerName: res.winnerName || '',
      seatNames: res.seatNames || [],
      youSeat: res.youSeat,
      winnerSeat: res.winnerSeat,
      durationS: res.durationS || 0,
      maxAiLevel: res.maxAiLevel || 0
    });
    prof.history = prof.history.slice(0, 50);

    return { xpGained: xp, newAchievements: newAch, daily: dailyCounted };
  }

  /* ---------- schema migration (v1 → v2) ---------- */
  function migrateV1(d) {
    if (d && typeof d === 'object') {
      if (d.v === 1) d.v = 2;
      if (d.settings && typeof d.settings === 'object') {
        if (d.settings.handoffMigrated === undefined) {
          if (d.settings.handoff === 'quick') d.settings.handoff = 'off';
          d.settings.handoffMigrated = true;
        }
        if (d.settings.theme === undefined) d.settings.theme = 'auto';
        if (d.settings.layout === undefined) d.settings.layout = 'auto';
        if (d.settings.animSpeed === undefined) d.settings.animSpeed = 'fast';
        if (d.settings.sound === undefined) d.settings.sound = true;
        if (d.settings.haptics === undefined) d.settings.haptics = true;
      }
      if (d.stats && typeof d.stats === 'object') {
        if (d.stats.onlineMatches === undefined) d.stats.onlineMatches = 0;
        if (d.stats.onlineWins === undefined) d.stats.onlineWins = 0;
      }
      if (d.cosmetics && !Array.isArray(d.cosmetics.owned)) d.cosmetics.owned = ['ivory-b'];
    }
    return d;
  }

  if (Persist) {
    Persist.register('profile.v1', 2, { 1: migrateV1 }, validateProfile);
  }

  function normalizeHandoff(prof) {
    if (prof && prof.settings && !prof.settings.handoffMigrated) {
      if (prof.settings.handoff === 'quick') prof.settings.handoff = 'off';
      prof.settings.handoffMigrated = true;
    }
    return prof;
  }

  function loadProfile() {
    var p = Store.load(Store.keys.profile, validateProfile);
    if (p === null || p === undefined) {
      p = defaultProfile();
      try { Store.save(Store.keys.profile, p); } catch (e) {}
    }
    return normalizeHandoff(p);
  }
  function saveProfile(prof) {
    if (validateProfile(prof)) Store.save(Store.keys.profile, prof);
  }

  var Profile = {
    defaultProfile: defaultProfile,
    validateProfile: validateProfile,
    loadProfile: loadProfile,
    saveProfile: saveProfile,
    applyMatchResult: applyMatchResult,
    levelFromXp: levelFromXp,
    xpForNext: xpForNext,
    isUnlocked: isUnlocked,
    COSMETICS: COSMETICS,
    ACHIEVEMENTS: ACHIEVEMENTS,
    dateKey: dateKey,
    dailyFor: dailyFor
  };
  global.LudoraProfile = Profile;
  if (typeof module !== 'undefined' && module.exports) module.exports = global.LudoraProfile;
})(typeof window !== 'undefined' ? window : globalThis);
