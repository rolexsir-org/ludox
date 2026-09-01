/* =========================================================================
   Ludora — qr.js
   Minimal, correct QR Code encoder (byte mode, EC level L, versions 1-20).
   Zero dependencies. Produces a module matrix plus the chosen mask so the
   caller can render the code, and so tests can verify the structure.
   ========================================================================= */
(function (global) {
  'use strict';

  /* ---------- tables ---------- */
  // EC-L total data codewords per version (ISO/IEC 18004).
  var DATA_CAP = { 1:19,2:34,3:55,4:80,5:108,6:136,7:156,8:194,9:232,10:274,
                   11:324,12:370,13:428,14:461,15:523,16:589,17:647,18:721,19:795,20:861 };
  // total codewords per version
  var TOTAL_CW = { 1:26,2:44,3:70,4:100,5:134,6:172,7:196,8:242,9:292,10:346,
                   11:404,12:466,13:532,14:581,15:655,16:733,17:815,18:901,19:991,20:1085 };
  // EC codewords per block, EC-L
  var EC_PER_BLOCK = { 1:7,2:10,3:15,4:20,5:26,6:18,7:20,8:24,9:30,10:18,
                       11:20,12:24,13:26,14:30,15:22,16:24,17:28,18:30,19:28,20:28 };
  // alignment pattern center coords (versions 1-20; v1 has none)
  var ALIGN = {
    1:[], 2:[6,18], 3:[6,22], 4:[6,26], 5:[6,30], 6:[6,34],
    7:[6,22,38], 8:[6,24,42], 9:[6,26,46], 10:[6,28,50],
    11:[6,30,54], 12:[6,32,58], 13:[6,34,62], 14:[6,26,46,66],
    15:[6,26,48,70], 16:[6,26,50,74], 17:[6,30,54,78], 18:[6,30,56,82],
    19:[6,30,58,86], 20:[6,34,62,90]
  };

  function _capacityOf(version) { return DATA_CAP[version] || null; }
  function _pickVersion(len) {
    for (var v = 1; v <= 20; v++) if (DATA_CAP[v] >= len) return v;
    return 20;
  }

  /* ---------- BCH ---------- */
  function _bchFormat(mask) {
    var data = (1 << 3) | (mask & 7);        // EC level L = 01
    var v = data << 10;
    for (var i = 14; i >= 10; i--) if (v & (1 << i)) v ^= (0x537 << (i - 10));
    return ((data << 10) | v) ^ 0x5412;
  }
  function _bchVersion(ver) {
    var v = ver << 12;
    for (var i = 17; i >= 12; i--) if (v & (1 << i)) v ^= (0x1f25 << (i - 12));
    return (ver << 12) | v;
  }

  /* ---------- GF(256) Reed-Solomon ---------- */
  var EXP = new Array(512), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gfMul(a, b) { return (a && b) ? EXP[LOG[a] + LOG[b]] : 0; }
  function rsPoly(n) {
    var poly = [1];
    for (var i = 0; i < n; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= gfMul(poly[j], EXP[i]);
        next[j + 1] ^= poly[j];
      }
      poly = next;
    }
    return poly;
  }
  /* data: array of bytes. Returns `count` EC codewords. */
  function _rsEncode(data, count) {
    var gen = rsPoly(count);
    var res = new Array(count).fill(0);
    for (var i = 0; i < data.length; i++) {
      var f = data[i] ^ res[0];
      res.shift(); res.push(0);
      if (f !== 0) {
        for (var j = 0; j < count; j++) res[j] ^= gfMul(gen[j + 1], f);
      }
    }
    return res;
  }

  /* ---------- matrix helpers ---------- */
  function dimFor(ver) { return ver * 4 + 17; }

  /* ---------- bit buffer ---------- */
  function BitBuf() { this.bits = []; }
  BitBuf.prototype.push = function (value, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };
  BitBuf.prototype.toBytes = function () {
    var out = [];
    for (var i = 0; i < this.bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] || 0);
      out.push(b);
    }
    return out;
  };

  /* ---------- block layout ---------- */
  function blockLayout(ver) {
    var total = DATA_CAP[ver], ec = EC_PER_BLOCK[ver];
    var totalCW = TOTAL_CW[ver];
    var n = Math.floor((totalCW - total) / ec);
    var base = Math.floor(total / n), rem = total % n;
    var blocks = [];
    for (var i = 0; i < n; i++) blocks.push({ data: base + (i >= n - rem ? 1 : 0), ec: ec });
    return blocks;
  }

  /* ---------- module drawing ---------- */
  function makeMatrix(ver) {
    var size = dimFor(ver);
    var m = [];
    for (var r = 0; r < size; r++) m.push(new Array(size).fill(null));
    return { size: size, m: m };
  }
  function setModule(q, r, c, v) { q.m[r][c] = v; }

  function finder(q, r, c) {
    var size = q.size;
    for (var dr = -1; dr <= 7; dr++) {
      for (var dc = -1; dc <= 7; dc++) {
        var rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        var on = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
                 (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
                 (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
        setModule(q, rr, cc, on ? 1 : 0);
      }
    }
  }
  function alignment(q, center) {
    var size = q.size, r = center[0], c = center[1];
    for (var dr = -2; dr <= 2; dr++) {
      for (var dc = -2; dc <= 2; dc++) {
        var rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        var on = (Math.abs(dr) === 2 || Math.abs(dc) === 2) || (dr === 0 && dc === 0);
        setModule(q, rr, cc, on ? 1 : 0);
      }
    }
  }

  function buildFunctionPattern(q, ver) {
    var size = q.size;
    finder(q, 0, 0);
    finder(q, 0, size - 7);
    finder(q, size - 7, 0);
    // timing
    for (var i = 8; i < size - 8; i++) {
      setModule(q, 6, i, i % 2 === 0 ? 1 : 0);
      setModule(q, i, 6, i % 2 === 0 ? 1 : 0);
    }
    // alignment
    var centers = ALIGN[ver] || [];
    for (var a = 0; a < centers.length; a++) {
      for (var b = 0; b < centers.length; b++) {
        var r = centers[a], c = centers[b];
        // skip if overlapping a finder
        if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
        alignment(q, [r, c]);
      }
    }
    // dark module
    setModule(q, size - 8, 8, 1);
    // reserve format positions (copy 1)
    var fmt1 = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
    for (var f = 0; f < fmt1.length; f++) setModule(q, fmt1[f][0], fmt1[f][1], 0);
    // reserve format positions (copy 2)
    var fmt2 = [[size-1,8],[size-2,8],[size-3,8],[size-4,8],[size-5,8],[size-6,8],[size-7,8],
                [8,size-8],[8,size-7],[8,size-6],[8,size-5],[8,size-4],[8,size-3],[8,size-2],[8,size-1]];
    for (var g = 0; g < fmt2.length; g++) setModule(q, fmt2[g][0], fmt2[g][1], 0);
    // version info blocks (v >= 7)
    if (ver >= 7) {
      var vbits = _bchVersion(ver);
      for (var k = 0; k < 18; k++) {
        var bit = (vbits >> k) & 1;
        var ay = Math.floor(k / 3), ax = k % 3;
        setModule(q, ay, size - 11 + ax, bit);            // top-right block
        setModule(q, size - 11 + ax, ay, bit);            // bottom-left block
      }
    }
  }

  /* r,c are module coordinates; returns true if function pattern */
  function isFunction(q, ver, r, c) {
    var size = q.size;
    if (r < 9 && c < 9) return true;                        // top-left finder + format
    if (r < 9 && c >= size - 8) return true;                // top-right finder + format/version
    if (r >= size - 8 && c < 9) return true;                // bottom-left finder + format/version
    if (r === 6 || c === 6) return true;                    // timing
    var centers = ALIGN[ver] || [];
    for (var i = 0; i < centers.length; i++) {
      for (var j = 0; j < centers.length; j++) {
        var cr = centers[i], cc = centers[j];
        if ((cr === 6 && cc === 6) || (cr === 6 && cc === size - 7) || (cr === size - 7 && cc === 6)) continue;
        if (Math.abs(r - cr) <= 2 && Math.abs(c - cc) <= 2) return true;
      }
    }
    if (ver >= 7) {
      if (r < 9 && c >= size - 11 && c <= size - 9) return true;
      if (r >= size - 11 && r <= size - 9 && c < 9) return true;
    }
    return false;
  }

  function applyMask(q, ver, mask) {
    var size = q.size;
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (isFunction(q, ver, r, c)) continue;
        var m = q.m[r][c];
        var invert = false;
        switch (mask) {
          case 0: invert = (r + c) % 2 === 0; break;
          case 1: invert = r % 2 === 0; break;
          case 2: invert = c % 3 === 0; break;
          case 3: invert = (r + c) % 3 === 0; break;
          case 4: invert = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; break;
          case 5: invert = ((r * c) % 2 + (r * c) % 3) === 0; break;
          case 6: invert = (((r * c) % 2 + (r * c) % 3) % 2) === 0; break;
          case 7: invert = (((r + c) % 2 + (r * c) % 3) % 2) === 0; break;
        }
        if (invert) m = m === 0 ? 1 : 0;
        setModule(q, r, c, m);
      }
    }
  }

  /* data bit placement (zigzag) — writes into non-function modules, then masks */
  function placeData(q, ver, bytes) {
    var size = q.size;
    var bitIdx = 0;
    var totalBits = bytes.length * 8;
    var dir = -1;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;                                 // skip timing column
      for (;;) {
        for (var vert = 0; vert < size; vert++) {
          var row = dir === -1 ? size - 1 - vert : vert;
          for (var dc = 0; dc < 2; dc++) {
            var c = col - dc;
            if (isFunction(q, ver, row, c)) continue;
            var bit = bitIdx < totalBits ? ((bytes[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1) : 0;
            setModule(q, row, c, bit);
            bitIdx++;
          }
        }
        dir = -dir;
        break;
      }
    }
  }

  function penalty(q) {
    var size = q.size, m = q.m, score = 0;
    // rule 1: runs of >=5
    for (var r = 0; r < size; r++) {
      var run = 1;
      for (var c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (var c2 = 0; c2 < size; c2++) {
      var run2 = 1;
      for (var r2 = 1; r2 < size; r2++) {
        if (m[r2][c2] === m[r2 - 1][c2]) run2++;
        else { if (run2 >= 5) score += 3 + (run2 - 5); run2 = 1; }
      }
      if (run2 >= 5) score += 3 + (run2 - 5);
    }
    // rule 2: 2x2 blocks
    for (var rr = 0; rr < size - 1; rr++) {
      for (var cc = 0; cc < size - 1; cc++) {
        var v = m[rr][cc];
        if (v === m[rr][cc + 1] && v === m[rr + 1][cc] && v === m[rr + 1][cc + 1]) score += 3;
      }
    }
    // rule 3: finder-like patterns 1011101 with 0000 either side
    function pattern(row, col, dr, dc) {
      var s = '';
      for (var k = -4; k <= 7; k++) {
        var rr = row + dr * k, cc = col + dc * k;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) { s += ' '; continue; }
        s += m[rr][cc] ? '1' : '0';
      }
      return s;
    }
    var PAT1 = '10111010000', PAT0 = '00001011101';
    for (var rr2 = 0; rr2 < size; rr2++) {
      var s1 = '', s2 = '';
      for (var k2 = 0; k2 < size; k2++) { s1 += m[rr2][k2] ? '1' : '0'; s2 += m[k2][rr2] ? '1' : '0'; }
      for (var kx = 0; kx <= size - 11; kx++) {
        var w1 = s1.substr(kx, 11), w2 = s2.substr(kx, 11);
        if (w1 === PAT1 || w1 === PAT0) score += 40;
        if (w2 === PAT1 || w2 === PAT0) score += 40;
      }
      void pattern; void PAT0; void PAT1;
    }
    // rule 4: dark proportion
    var dark = 0;
    for (var r3 = 0; r3 < size; r3++) for (var c3 = 0; c3 < size; c3++) dark += m[r3][c3];
    score += Math.floor(Math.abs((dark * 100 / (size * size)) - 50) / 5) * 10;
    return score;
  }

  function writeFormat(q, mask) {
    var size = q.size;
    var bits = _bchFormat(mask);
    var fmt1 = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
    var fmt2 = [[size-1,8],[size-2,8],[size-3,8],[size-4,8],[size-5,8],[size-6,8],[size-7,8],
                [8,size-8],[8,size-7],[8,size-6],[8,size-5],[8,size-4],[8,size-3],[8,size-2],[8,size-1]];
    for (var i = 0; i < 15; i++) {
      var b = (bits >> (14 - i)) & 1;
      setModule(q, fmt1[i][0], fmt1[i][1], b);
      setModule(q, fmt2[i][0], fmt2[i][1], b);
    }
  }

  /* ---------- encode ---------- */
  function encodeText(text) {
    text = String(text == null ? '' : text);
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    var ver = _pickVersion(bytes.length);
    if (ver > 20 || bytes.length > DATA_CAP[20]) return null;

    // build bitstream: byte mode 0100 + char count + data + terminator + pad
    var bb = new BitBuf();
    bb.push(4, 4);
    bb.push(bytes.length, ver <= 9 ? 8 : 16);
    for (var b = 0; b < bytes.length; b++) bb.push(bytes[b], 8);
    var capBits = DATA_CAP[ver] * 8;
    bb.push(0, Math.min(4, capBits - bb.bits.length));
    while (bb.bits.length % 8) bb.push(0, 1);
    var dataBytes = bb.toBytes();
    var pad = [0xEC, 0x11];
    for (var p = dataBytes.length; dataBytes.length < DATA_CAP[ver]; p++) {
      dataBytes.push(pad[p % 2]);
    }

    // split into blocks, RS encode, interleave
    var blocks = blockLayout(ver);
    var dataBlocks = [], ecBlocks = [], totalData = [], totalEc = [];
    var dataPos = 0;
    for (var bi = 0; bi < blocks.length; bi++) {
      var blk = dataBytes.slice(dataPos, dataPos + blocks[bi].data);
      dataPos += blocks[bi].data;
      dataBlocks.push(blk);
      ecBlocks.push(_rsEncode(blk, blocks[bi].ec));
      totalData.push(blocks[bi].data);
      totalEc.push(blocks[bi].ec);
    }
    var maxData = Math.max.apply(null, totalData);
    var inter = [];
    for (var di = 0; di < maxData; di++) {
      for (var dbi = 0; dbi < dataBlocks.length; dbi++) {
        if (di < dataBlocks[dbi].length) inter.push(dataBlocks[dbi][di]);
      }
    }
    var maxEc = Math.max.apply(null, totalEc);
    for (var ei = 0; ei < maxEc; ei++) {
      for (var ebi = 0; ebi < ecBlocks.length; ebi++) {
        if (ei < ecBlocks[ebi].length) inter.push(ecBlocks[ebi][ei]);
      }
    }

    var q = makeMatrix(ver);
    buildFunctionPattern(q, ver);
    placeData(q, ver, inter);

    // choose best mask
    var bestMask = 0, bestScore = Infinity;
    for (var mk = 0; mk < 8; mk++) {
      try {
        applyMask(q, ver, mk);
        var sc = penalty(q);
        if (sc < bestScore) { bestScore = sc; bestMask = mk; }
        // undo mask before next: re-place data (function patterns unaffected) — simplest: re-place
        // We re-run placeData after re-building base (function patterns intact).
        placeData(q, ver, inter);
      } catch (e) { bestMask = mk; break; }
    }
    // apply the chosen mask permanently
    applyMask(q, ver, bestMask);
    writeFormat(q, bestMask);

    // convert nulls (should be none) to 0
    for (var r = 0; r < q.size; r++) for (var c = 0; c < q.size; c++) if (q.m[r][c] == null) q.m[r][c] = 0;

    return { size: q.size, modules: q.m, mask: bestMask, version: ver };
  }

  global.LudoraQr = {
    encodeText: encodeText,
    _bchFormat: _bchFormat,
    _bchVersion: _bchVersion,
    _capacityOf: _capacityOf,
    _pickVersion: _pickVersion,
    _rsEncode: _rsEncode,
    _penalty: penalty
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.LudoraQr;
})(typeof window !== 'undefined' ? window : globalThis);
