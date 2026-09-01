/* =========================================================================
   Ludora — store.js
   Thin, typed accessors over persist.js for the app's known keys. All real
   persistence rules (checkums, backups, migrations) live in persist.js.
   ========================================================================= */
(function (global) {
  'use strict';
  var Persist = global.LudoraPersist;

  var keys = {
    match: 'match.v1',
    profile: 'profile.v1'
  };

  function save(key, obj) { Persist.put(key, obj); }
  function saveRaw(key, raw) { Persist.putRaw(key, raw); }
  function load(key, validate) {
    var data = Persist.get(key);
    if (data === null || data === undefined) return null;
    if (typeof validate === 'function') {
      var ok;
      try { ok = !!validate(data); } catch (e) { ok = false; }
      if (!ok) { Persist.remove(key); return null; }
    }
    return data;
  }
  function remove(key) { Persist.remove(key); }

  var Store = {
    keys: keys,
    save: save,
    load: load,
    remove: remove,
    saveRaw: saveRaw,
    _persist: Persist
  };
  global.LudoraStore = Store;
  if (typeof module !== 'undefined' && module.exports) module.exports = global.LudoraStore;
})(typeof window !== 'undefined' ? window : globalThis);
