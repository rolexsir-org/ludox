/* =========================================================================
   Ludora — persist.js
   Hardened persistence: versioned envelopes with checksums, three-generation
   backup rotation, schema migration chains, IndexedDB mirroring (browser),
   graceful degradation when storage is unavailable, and signed export/import.

   Every value is wrapped so a torn write, a silently-edited payload, a
   future-schema blob, or a failed validator is rejected — never served.
   ========================================================================= */
(function (global) {
  'use strict';

  var registry = {};        // key -> { v, mig, val }
  var memCache = {};        // key -> data (post-validation)
  var mem = new Map();      // memory-only fallback store
  var deviceKey = null;     // lazily created signing secret

  var PREFIX = 'ludora:';

  /* ---------- storage abstraction ---------- */
  function hasLS() {
    try { return typeof global.localStorage !== 'undefined' && !!global.localStorage; }
    catch (e) { return false; }
  }
  function ls() {
    if (hasLS()) return global.localStorage;
    return null;
  }
  function hasIDB() {
    try { return typeof global.indexedDB !== 'undefined' && !!global.indexedDB; }
    catch (e) { return false; }
  }
  function getRaw(k) {
    try {
      var l = ls();
      if (l) return l.getItem(k);
      return mem.has(k) ? mem.get(k) : null;
    } catch (e) { return null; }
  }
  function setRaw(k, v) {
    try {
      var l = ls();
      if (l) { l.setItem(k, v); return; }
    } catch (e) { /* quota / unavailable → memory fallback */ }
    mem.set(k, v);
  }
  function delRaw(k) {
    try {
      var l = ls();
      if (l) { l.removeItem(k); }
    } catch (e) {}
    mem.delete(k);
  }

  /* ---------- checksum (32-bit FNV-1a, 8 lowercase hex) ---------- */
  function checksum(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function register(key, version, migrations, validator) {
    registry[key] = {
      v: version || 1,
      mig: migrations || {},
      val: validator || null
    };
  }

  function current(key) {
    var r = registry[key];
    return r ? r.v : 1;
  }

  function _envelope(key, data, version) {
    return {
      __ludora: 1,
      k: key,
      v: version == null ? current(key) : version,
      t: Date.now(),
      c: checksum(JSON.stringify(data)),
      d: data
    };
  }

  function liveKey(key) { return PREFIX + key; }
  function bakKey(key) { return PREFIX + key + '~bak'; }
  function bak2Key(key) { return PREFIX + key + '~bak2'; }

  /* ---------- migration + validation chain ---------- */
  function processData(key, obj) {
    var r = registry[key];
    if (!r) return obj;
    try {
      var storedV = 1;
      if (obj && obj.__ludora === 1) {
        storedV = obj.v;
        obj = obj.d;
      }
      if (storedV > r.v) return null;                    // future schema
      if (obj == null || typeof obj !== 'object') {
        if (storedV >= r.v) return obj;                  // primitives at current schema pass through
        return null;                                     // cannot migrate a null/non-object
      }
      if (storedV < r.v) {
        for (var v = storedV; v < r.v; v++) {
          var fn = r.mig[v];
          if (fn) { var out = fn(obj); if (out != null) obj = out; }
        }
        if (typeof obj.v === 'number' && storedV < r.v) obj.v = r.v;   // stamp schema version
      }
      if (r.val) {
        var ok = true;
        try { ok = !!r.val(obj); } catch (e) { ok = false; }
        if (!ok) return null;
      }
      return obj;
    } catch (e) { return null; }
  }

  /* ---------- read ---------- */
  function cacheGet(key) {
    return Object.prototype.hasOwnProperty.call(memCache, key) ? memCache[key] : undefined;
  }
  function cacheSet(key, val) { memCache[key] = val; }
  function cacheClear(key) { delete memCache[key]; }

  function readSlot(key, slotKey) {
    var raw;
    try {
      raw = slotKey === liveKey(key) ? getRaw(liveKey(key)) :
            slotKey === bakKey(key) ? getRaw(bakKey(key)) :
            getRaw(bak2Key(key));
    } catch (e) { return undefined; }
    if (raw == null) return undefined;
    var obj;
    try { obj = JSON.parse(raw); } catch (e) { return undefined; }
    if (obj && typeof obj === 'object' && obj.__ludora === 1) {
      if (typeof obj.c !== 'string' || obj.c.length !== 8) return undefined;
      var dstr;
      try { dstr = JSON.stringify(obj.d); } catch (e) { return undefined; }
      if (checksum(dstr) !== obj.c) return undefined;   // tampered / torn
    }
    return obj;
  }

  function get(key) {
    var cached = cacheGet(key);
    if (cached !== undefined) return cached;

    var slots = [liveKey(key), bakKey(key), bak2Key(key)];
    var seenFuture = false;
    for (var i = 0; i < slots.length; i++) {
      var obj = readSlot(key, slots[i]);
      if (obj === undefined) continue;
      if (obj && obj.__ludora === 1 && obj.v > current(key)) { seenFuture = true; continue; }
      var data = processData(key, obj);
      if (data !== null && data !== undefined) { cacheSet(key, data); return data; }
    }
    if (seenFuture) return null;
    return null;
  }

  /* ---------- write ---------- */
  function put(key, data) {
    var env = _envelope(key, data, current(key));
    var oldBak = getRaw(bakKey(key));
    var oldLive = getRaw(liveKey(key));
    setRaw(bak2Key(key), oldBak);
    setRaw(bakKey(key), oldLive);
    setRaw(liveKey(key), JSON.stringify(env));
    cacheClear(key);
    cacheSet(key, data);
  }

  function putRaw(key, raw) {
    setRaw(liveKey(key), raw);
    cacheClear(key);
  }

  function remove(key) {
    cacheClear(key);
    delRaw(liveKey(key));
    delRaw(bakKey(key));
    delRaw(bak2Key(key));
  }

  /* ---------- device signing secret ---------- */
  function device() {
    if (deviceKey !== null) return deviceKey;
    var k = getRaw(PREFIX + 'device.v1') || (function () {
      var s = '';
      try {
        var a = new Uint8Array(24);
        (global.crypto && global.crypto.getRandomValues) ? global.crypto.getRandomValues(a) : null;
        for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
      } catch (e) { s = 'd' + Date.now().toString(16) + Math.random().toString(16).slice(2); }
      setRaw(PREFIX + 'device.v1', s);
      return s;
    })();
    deviceKey = k;
    return k;
  }

  function getSha() {
    if (global.LudoraSha) return global.LudoraSha;
    try { return require('./sha.js'); } catch (e) { return null; }
  }

  /* canonical, key-sorted JSON so signatures are stable regardless of order */
  function canon(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(canon).join(',') + ']';
    var keys = Object.keys(obj).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      parts.push(JSON.stringify(k) + ':' + canon(obj[k]));
    }
    return '{' + parts.join(',') + '}';
  }

  /* ---------- export / import ---------- */
  function exportAll() {
    var data = {};
    var keys = Object.keys(registry);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = get(k);
      if (v !== null && v !== undefined) data[k] = v;
    }
    var blob = { app: 'ludora', format: 1, data: data };
    var Sha = getSha();
    if (Sha) {
      blob.sig = Sha.hmac(device(), canon({ app: blob.app, format: blob.format, data: blob.data }));
    }
    return JSON.stringify(blob);
  }

  function importAll(raw) {
    var blob;
    try { blob = JSON.parse(raw); } catch (e) { return { ok: false, error: 'Invalid backup' }; }
    if (!blob || typeof blob !== 'object' || blob.app !== 'ludora') {
      return { ok: false, error: 'Not a Ludora backup' };
    }
    if (!blob.data || typeof blob.data !== 'object') {
      return { ok: false, error: 'No data' };
    }
    if (blob.sig != null) {
      var Sha = getSha();
      if (!Sha) return { ok: false, error: 'Signature unavailable' };
      var sig = Sha.hmac(device(), canon({ app: blob.app, format: blob.format, data: blob.data }));
      if (sig !== blob.sig) return { ok: false, error: 'Signature mismatch' };
    }
    /* validate every entry before applying any (atomic per import) */
    var keys = Object.keys(blob.data);
    var staged = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var val = blob.data[k];
      var r = registry[k];
      if (!r) continue;                                 // unknown key: skip
      var checked = r.val;
      if (checked) {
        var ok = true;
        try { ok = !!checked(val); } catch (e) { ok = false; }
        if (!ok) return { ok: false, error: 'Invalid data for ' + k };
      }
      staged.push([k, val]);
    }
    for (var j = 0; j < staged.length; j++) {
      put(staged[j][0], staged[j][1]);
    }
    return { ok: true, imported: staged.map(function (s) { return s[0]; }) };
  }

  /* ---------- IDB mirror (browser) ----------
     Keeps an asynchronous copy of each envelope in IndexedDB so a cleared
     localStorage (or evicted site data) can be rehydrated. Headless Node
     has no IndexedDB — hydrate() simply resolves with fromIdb:false. */
  function idbOpen() {
    return new Promise(function (resolve) {
      if (!hasIDB()) { resolve(null); return; }
      try {
        var req = global.indexedDB.open('ludora', 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains('kv')) {
            db.createObjectStore('kv', { keyPath: 'k' });
          }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }
  function idbPutAll() {
    return idbOpen().then(function (db) {
      if (!db) return;
      return new Promise(function (resolve) {
        var tx = db.transaction('kv', 'readwrite');
        var store = tx.objectStore('kv');
        Object.keys(memCache).forEach(function (k) {
          try { store.put({ k: k, v: getRaw(liveKey(k)) || '' }); } catch (e) {}
        });
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { db.close(); resolve(); };
      });
    }).catch(function () {});
  }

  function hydrate() {
    return idbOpen().then(function (db) {
      if (!db) return { fromIdb: false, replaced: [] };
      return new Promise(function (resolve) {
        var replaced = [];
        var tx = db.transaction('kv', 'readonly');
        var store = tx.objectStore('kv');
        var req = store.getAll();
        req.onsuccess = function () {
          try {
            var rows = req.result || [];
            for (var i = 0; i < rows.length; i++) {
              var row = rows[i];
              if (row && row.k && !getRaw(row.k)) {
                setRaw(row.k, row.v || '');
                replaced.push(row.k);
              }
            }
          } catch (e) {}
          db.close();
          resolve({ fromIdb: replaced.length > 0, replaced: replaced });
        };
        req.onerror = function () { db.close(); resolve({ fromIdb: false, replaced: [] }); };
      });
    }).catch(function () { return { fromIdb: false, replaced: [] }; });
  }

  function stats() {
    return { idb: hasIDB(), ls: hasLS() };
  }

  var Persist = {
    register: register,
    put: put,
    get: get,
    remove: remove,
    putRaw: putRaw,
    exportAll: exportAll,
    importAll: importAll,
    stats: stats,
    hydrate: hydrate,
    _envelope: _envelope,
    _idbPutAll: idbPutAll
  };
  global.LudoraPersist = Persist;
  if (typeof module !== 'undefined' && module.exports) module.exports = global.LudoraPersist;
})(typeof window !== 'undefined' ? window : globalThis);
