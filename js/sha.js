/* =========================================================================
   Ludora — sha.js
   Pure-JS SHA-256 (FIPS 180-4) + HMAC-SHA256 + crypto random hex.
   Zero dependencies, no WebCrypto reliance so it runs identically in
   browsers, workers, service workers and Node tests.
   ========================================================================= */
(function (global) {
  'use strict';

  /* ---------- SHA-256 core ---------- */
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  /* operates on a Uint8Array of bytes; returns 32-byte Uint8Array */
  function sha256Bytes(bytes) {
    var hl = 0x6a09e667, hh = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
        h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    var len = bytes.length;
    var bitLenHi = Math.floor(len / 0x20000000);
    var bitLenLo = (len << 3) >>> 0;
    var withOne = len + 1;
    // pad: 0x80 then 0x00 until length ≡ 56 (mod 64), then 8-byte length
    var paddedLen = (withOne + 8 + 63) & ~63;
    var m = new Uint8Array(paddedLen);
    m.set(bytes);
    m[len] = 0x80;
    var dv = new DataView(m.buffer);
    // length is 64-bit big-endian; we already split into hi/lo
    dv.setUint32(paddedLen - 8, bitLenHi === 0 ? (len < 0x20000000 ? 0 : bitLenHi) : bitLenHi, false);
    dv.setUint32(paddedLen - 4, bitLenLo, false);

    var w = new Array(64);
    for (var off = 0; off < paddedLen; off += 64) {
      for (var i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = hl, b = hh, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      hl = (hl + a) >>> 0; hh = (hh + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    var out = new Uint8Array(32);
    var ov = new DataView(out.buffer);
    ov.setUint32(0, hl, false); ov.setUint32(4, hh, false); ov.setUint32(8, h2, false);
    ov.setUint32(12, h3, false); ov.setUint32(16, h4, false); ov.setUint32(20, h5, false);
    ov.setUint32(24, h6, false); ov.setUint32(28, h7, false);
    return out;
  }

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    str = String(str == null ? '' : str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
          i++;
        } else {
          out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
      } else if (c >= 0xd800 && c <= 0xdfff) {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return new Uint8Array(out);
  }

  function toHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return s;
  }

  function sha256(str) {
    return toHex(sha256Bytes(utf8Bytes(str)));
  }

  function sha256HexOfBytes(bytes) {
    return toHex(sha256Bytes(bytes));
  }

  /* ---------- HMAC-SHA256 ---------- */
  function hmac(key, msg) {
    var block = 64;
    var kb = utf8Bytes(key);
    var mb = utf8Bytes(msg);
    if (kb.length > block) kb = sha256Bytes(kb);
    var ipad = new Uint8Array(block);
    var opad = new Uint8Array(block);
    for (var i = 0; i < block; i++) {
      ipad[i] = (i < kb.length ? kb[i] : 0) ^ 0x36;
      opad[i] = (i < kb.length ? kb[i] : 0) ^ 0x5c;
    }
    var inner = new Uint8Array(block + mb.length);
    inner.set(ipad);
    inner.set(mb, block);
    var innerHash = sha256Bytes(inner);
    var outer = new Uint8Array(block + 32);
    outer.set(opad);
    outer.set(innerHash, block);
    return toHex(sha256Bytes(outer));
  }

  /* ---------- crypto random hex ---------- */
  function randBytes(n) {
    var a = new Uint8Array(n);
    try { crypto.getRandomValues(a); }
    catch (e) { for (var i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256); }
    return a;
  }
  /* n = number of hex characters */
  function randHex(n) {
    var b = randBytes(Math.ceil(n / 2));
    var s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s.slice(0, n);
  }

  var sha = {
    sha256: sha256,
    sha256HexOfBytes: sha256HexOfBytes,
    hmac: hmac,
    randHex: randHex,
    utf8Bytes: utf8Bytes
  };
  global.LudoraSha = sha;
  if (typeof module !== 'undefined' && module.exports) module.exports = global.LudoraSha;
})(typeof window !== 'undefined' ? window : globalThis);
