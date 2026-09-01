/* =========================================================================
   Ludora — net.js
   Serverless WebRTC transport.

   There is no Ludora-operated server anywhere in this stack: gameplay and
   game state travel exclusively over peer-to-peer DTLS-encrypted
   DataChannels. The only exchange needed to establish a connection is a
   one-time offer/answer code, moved by humans (copy/paste, native share,
   QR). A public STUN server may be used purely for NAT discovery during
   connection setup — it never sees game data (see README, "Serverless
   multiplayer" for the privacy note).

   Peer            — one RTCPeerConnection + ordered reliable DataChannel,
                     non-trickle ICE bundled into the codes.
   codePack/Unpack — {t, room, seat, secret, sdp} ⇄ short text code
                     (deflate via CompressionStream when available).
   VirtualNet      — in-memory transport used by the automated multiplayer
                     tests; injects latency/dropout, never touches real RTC.
   ========================================================================= */
(function (global) {
  'use strict';

  var MAX_MSG = 64 * 1024;            // hard cap on any wire message (dice commitments ≈ 41 KB)
  var MAX_PENDING = 60;               // queued sends before the channel is declared stuck
  var ICE_TIMEOUT = 7000;
  var DISCONNECT_GRACE = 9000;        // 'disconnected' is transient until this elapses

  /* ---------- connection codes ---------- */
  function b64e(s) {
    return btoa(unescape(encodeURIComponent(s)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64d(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return decodeURIComponent(escape(atob(s)));
  }
  function compress(str) {
    if (typeof CompressionStream === 'undefined') return Promise.resolve(null);
    try {
      var cs = new CompressionStream('deflate-raw');
      var blob = new Blob([str]);
      var out = new Response(blob.stream().pipeThrough(cs));
      return out.arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf);
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return b64e(bin);
      }).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }
  function decompress(b64) {
    if (typeof DecompressionStream === 'undefined') return Promise.resolve(null);
    try {
      var bin = b64d(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var ds = new DecompressionStream('deflate-raw');
      var out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
      return out.text().catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  /* pack an offer/answer payload into a shareable code */
  function codePack(payload) {
    var json = JSON.stringify(payload);
    return compress(json).then(function (deflated) {
      return deflated !== null
        ? 'LUD1.' + deflated
        : 'LUD0.' + b64e(json);
    });
  }
  /* strict, bounds-checked unpack; returns null on anything malformed */
  function codeUnpack(code) {
    if (typeof code !== 'string' || code.length > 24 * 1024) return Promise.resolve(null);
    var m = /^(LUD0|LUD1)\.([A-Za-z0-9_-]+)$/.exec(code.trim());
    if (!m) return Promise.resolve(null);
    var finish = function (json) {
      var obj;
      try { obj = JSON.parse(json); } catch (e) { return null; }
      if (!obj || typeof obj !== 'object') return null;
      if (obj.t !== 'o' && obj.t !== 'a') return null;
      if (typeof obj.sdp !== 'string' || obj.sdp.length > 16 * 1024) return null;
      if (typeof obj.room !== 'string' || !/^[A-Z]{3,8}-\d{3,5}$/.test(obj.room)) return null;
      if (typeof obj.seat !== 'number' || obj.seat < 0 || obj.seat > 3 || Math.floor(obj.seat) !== obj.seat) return null;
      if (typeof obj.secret !== 'string' || obj.secret.length < 8 || obj.secret.length > 64) return null;
      return obj;
    };
    if (m[1] === 'LUD0') return Promise.resolve(finish(b64d(m[2])));
    return decompress(m[2]).then(function (json) {
      return json !== null ? finish(json) : null;
    });
  }

  /* ---------- random ids / secrets ---------- */
  function randBytes(n) {
    var a = new Uint8Array(n);
    try { crypto.getRandomValues(a); }
    catch (e) { for (var i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256); }
    return a;
  }
  function b64rand(n) { var a = randBytes(n), s = ''; for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return b64e(s); }
  var WORDS = ['AMBER', 'BASIL', 'CEDAR', 'CORAL', 'DELTA', 'DUNE', 'EMBER', 'FERN', 'FLINT',
    'GROVE', 'HARBOR', 'IVY', 'JADE', 'LAGOON', 'MAPLE', 'MARBLE', 'NOVA', 'OAK', 'ONYX',
    'PEBBLE', 'PLUM', 'QUARTZ', 'RAPID', 'RIDGE', 'SAFFRON', 'SLATE', 'SPRUCE', 'TIDE',
    'UMBER', 'VELVET', 'WILLOW', 'ZEPHYR'];
  function roomId() {
    var w = WORDS[Math.floor(randBytes(1)[0] / 256 * WORDS.length) % WORDS.length];
    var d = 100 + (randBytes(2)[0] << 8 | randBytes(2)[1]) % 8900;
    return w + '-' + d;
  }
  function secret() { return b64rand(16); }

  /* ---------- Peer: one WebRTC connection ----------
     opts.factory — injectable RTCPeerConnection constructor (tests) */
  function Peer(opts) {
    opts = opts || {};
    this.pc = null; this.dc = null;
    this.open = false; this.closing = false;
    this.onmessage = null; this.onclose = null; this.onopen = null; this.onerror = null;
    this.onstate = null;              // 'connected' | 'reconnecting' (grace) | 'lost'
    this._graceTimer = null;
    this.droppedSends = 0;
    this._Factory = opts.factory || global.RTCPeerConnection || global.webkitRTCPeerConnection || null;
    this._pending = [];
    this.iceServers = opts.iceServers !== undefined ? opts.iceServers
      : [{ urls: 'stun:stun.l.google.com:19302' }];
    this.label = opts.label || 'peer';
  }

  Peer.prototype._makePC = function () {
    return new this._Factory({ iceServers: this.iceServers });
  };

  Peer.prototype.createOffer = function (meta) {
    return this.createOfferPayload(meta).then(function (payload) {
      return codePack(payload);
    });
  };
  /* payload variants: same flow, raw objects — used when another peer
     relays the exchange (host-migration mesh), so no human codes are needed */
  Peer.prototype.createOfferPayload = function (meta) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (!self._Factory) { reject(new Error('WebRTC unavailable in this browser')); return; }
      try {
        self.pc = self._makePC();
        self.dc = self.pc.createDataChannel('ludora', { ordered: true });
        self._wireChannel();
        self.pc.onicecandidate = function () {};
        self.pc.createOffer().then(function (offer) {
          return self.pc.setLocalDescription(offer);
        }).then(function () {
          return self._waitIce();
        }).then(function () {
          resolve({ t: 'o', room: meta.room, seat: meta.seat, secret: meta.secret, sdp: self.pc.localDescription.sdp });
        }).catch(reject);
        self._watchPc();
      } catch (e) { reject(e); }
    });
  };

  /* GUEST side: consume an offer code, produce the answer code */
  Peer.prototype.acceptOffer = function (code) {
    var self = this;
    return codeUnpack(code).then(function (payload) {
      if (!payload || payload.t !== 'o') throw new Error('That invite code is not valid');
      return self.acceptOfferPayload(payload);
    }).then(function (answer) {
      return codePack(answer);
    });
  };
  Peer.prototype.acceptOfferPayload = function (payload) {
    var self = this;
    if (!payload || payload.t !== 'o' || typeof payload.sdp !== 'string' || payload.sdp.length > 16 * 1024) {
      return Promise.reject(new Error('Bad connection payload'));
    }
    if (!self._Factory) return Promise.reject(new Error('WebRTC unavailable in this browser'));
    self.meta = payload;
    return new Promise(function (resolve, reject) {
      try {
        self.pc = self._makePC();
        self.pc.ondatachannel = function (ev) { self.dc = ev.channel; self._wireChannel(); };
        self.pc.onicecandidate = function () {};
        self.pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp }).then(function () {
          return self.pc.createAnswer();
        }).then(function (answer) {
          return self.pc.setLocalDescription(answer);
        }).then(function () {
          return self._waitIce();
        }).then(function () {
          resolve({ t: 'a', room: payload.room, seat: payload.seat, secret: payload.secret, sdp: self.pc.localDescription.sdp });
        }).catch(reject);
        self._watchPc();
      } catch (e) { reject(e); }
    });
  };

  Peer.prototype.acceptAnswer = function (code) {
    var self = this;
    return codeUnpack(code).then(function (payload) {
      return self.acceptAnswerPayload(payload);
    });
  };
  Peer.prototype.acceptAnswerPayload = function (payload) {
    var self = this;
    if (!payload || payload.t !== 'a' || typeof payload.sdp !== 'string' || payload.sdp.length > 16 * 1024) {
      return Promise.reject(new Error('That reply code is not valid'));
    }
    if (self.meta && payload.secret !== self.meta.secret) return Promise.reject(new Error('Reply code is for a different seat'));
    return self.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
  };

  /* Resolves only when ICE gathering genuinely completes. A timeout is a
     hard FAILURE with a visible message — never a silently incomplete SDP. */
  Peer.prototype._waitIce = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (!self.pc) { reject(new Error('Connection setup failed')); return; }
      if (self.pc.iceGatheringState === 'complete') { resolve(); return; }
      var done = false;
      var ok = function () { if (!done) { done = true; clearInterval(iv); clearTimeout(to); resolve(); } };
      var fail = function () {
        if (done) return;
        done = true; clearInterval(iv);
        reject(new Error('Connection setup timed out — weak network. Create a fresh invite and try again.'));
      };
      var iv = setInterval(function () {
        if (!self.pc || self.pc.iceGatheringState === 'complete') ok();
      }, 150);
      var to = setTimeout(fail, ICE_TIMEOUT);
    });
  };
  Peer.prototype._state = function (s) {
    if (this.onstate) { try { this.onstate(s); } catch (e) {} }
  };
  Peer.prototype._watchPc = function () {
    var self = this;
    if (!this.pc) return;
    this.pc.onconnectionstatechange = function () {
      var s = self.pc ? self.pc.connectionState : 'closed';
      if (s === 'connected') {
        /* recovered from a transient dropout by itself */
        if (self._graceTimer) { clearTimeout(self._graceTimer); self._graceTimer = null; }
        self._state('connected');
        return;
      }
      if (s === 'disconnected') {
        /* transient by default: Wi-Fi↔cellular switches and backgrounding
           routinely land here and recover without any action */
        if (self._graceTimer) return;
        self._state('reconnecting');
        self._graceTimer = setTimeout(function () {
          self._graceTimer = null;
          self._teardown('grace-timeout');   // out of grace → permanent loss
        }, DISCONNECT_GRACE);
        return;
      }
      if (s === 'failed' || s === 'closed') self._teardown('pc:' + s);
    };
  };
  Peer.prototype._wireChannel = function () {
    var self = this;
    this.dc.onopen = function () {
      self.open = true;
      if (self.onopen) self.onopen();
      self._pending.splice(0).forEach(function (m) { try { self.dc.send(m); } catch (e) {} });
    };
    this.dc.onmessage = function (ev) {
      if (typeof ev.data !== 'string' || ev.data.length > MAX_MSG) return;   // malformed → drop
      if (self.onmessage) self.onmessage(ev.data);
    };
    this.dc.onclose = function () { self._teardown('dc:close'); };
    this.dc.onerror = function () { self._teardown('dc:error'); };
  };
  Peer.prototype._teardown = function (why) {
    if (this.closing && why === 'pc:closed') return;
    if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null; }
    var wasOpen = this.open;
    this.open = false;
    if (wasOpen) this._state('lost');
    try { if (this.dc) this.dc.onclose = null; } catch (e) {}
    try { if (this.pc) this.pc.close(); } catch (e) {}
    this.pc = null; this.dc = null;
    if (wasOpen && this.onclose) this.onclose(why);
  };
  Peer.prototype.send = function (obj) {
    var m = JSON.stringify(obj);
    if (m.length > MAX_MSG) return false;
    if (this.open && this.dc) { try { this.dc.send(m); return true; } catch (e) { return false; } }
    if (!this.closing) {
      if (this._pending.length >= MAX_PENDING) {           // stuck channel: drop, don't grow
        this._pending.shift();
        this.droppedSends++;
        return false;
      }
      this._pending.push(m);
    }
    return true;
  };
  Peer.prototype.close = function () {
    this.closing = true;
    this._teardown('local');
  };

  /* ======================================================================
     VirtualNet — deterministic in-memory transport for automated tests.
     Usage:
       var vnet = new VirtualNet({latency: 30});
       hostPeer = vnet.hostPeer(meta);          // behaves like createOffer+acceptAnswer done
       guestPeer = vnet.join(meta);             // paired channel
       vnet.cut(guestPeer); vnet.restore(...)   // failure injection
     ====================================================================== */
  function VirtualNet(opts) {
    opts = opts || {};
    this.latency = opts.latency || 0;
    this.dropRate = opts.dropRate || 0;      // simulates transport failure → disconnect
    this.pairs = [];
    this.time = 0;
  }
  function VPeer(vnet, meta) {
    this.vnet = vnet; this.meta = meta;
    this.open = false; this.closing = false;
    this.peer = null;
    this.onmessage = null; this.onclose = null; this.onopen = null; this.onerror = null;
    this.sent = []; this.received = [];
    this._outbox = [];
  }
  VPeer.prototype._flushOne = function (entry) {
    if (entry.delivered) return;
    entry.delivered = true;
    var to = this.peer;
    if (!to) return;
    if (this.vnet.dropRate > 0 && Math.random() < this.vnet.dropRate) return;   // lossy transport
    if (to.onmessage) to.onmessage(JSON.stringify(entry.obj));
  };
  VPeer.prototype.send = function (obj) {
    this.sent.push(obj);
    if (!this.open || !this.peer || this.closing) return false;
    var entry = { obj: obj, delivered: false };
    this._outbox.push(entry);
    if (this.vnet.latency > 0) {
      var self = this;
      entry.timer = setTimeout(function () { self._flushOne(entry); }, this.vnet.latency);
    } else this._flushOne(entry);
    return true;
  };
  /* Mirrors real DataChannel semantics: closing flushes already-accepted
     messages before the connection goes away. */
  /* payload stubs mirroring Peer's machine-relayed API */
  VPeer.prototype.createOfferPayload = function (meta) {
    this.meta = { room: meta.room, seat: meta.seat, secret: meta.secret };
    return Promise.resolve({ t: 'o', room: meta.room, seat: meta.seat, secret: meta.secret, sdp: 'vnet-mesh' });
  };
  VPeer.prototype.acceptOfferPayload = function (payload) {
    this.meta = payload;
    return Promise.resolve({ t: 'a', room: payload.room, seat: payload.seat, secret: payload.secret, sdp: 'vnet-mesh' });
  };
  VPeer.prototype.acceptAnswerPayload = function () { return Promise.resolve(); };

  VPeer.prototype.close = function () {
    if (this.closing) return;
    this.closing = true;
    this._outbox.forEach(function (e) {
      if (!e.delivered) { if (e.timer) clearTimeout(e.timer); this._flushOne(e); }
    }, this);
    this._outbox.length = 0;
    var other = this.peer;
    this.open = false;
    if (other && other.open) {
      other.open = false;
      other.closing = true;
      if (other.onclose) setTimeout(function () { if (other.onclose) other.onclose('remote'); }, 0);
    }
    if (this.onclose) setTimeout(function () { if (this.onclose) this.onclose('local'); }.bind(this), 0);
  };
  VirtualNet.prototype._pair = function (a, b) {
    a.peer = b; b.peer = a; a.open = true; b.open = true;
    this.pairs.push([a, b]);
    if (a.onopen) a.onopen();
    if (b.onopen) b.onopen();
    return b;
  };
  /* host side of one seat connection */
  VirtualNet.prototype.hostPeer = function (meta) {
    var p = new VPeer(this, meta);
    p.meta = meta;
    var self = this;
    p.acceptAnswer = function () { return Promise.resolve(); };
    p._guestSlot = null;
    return p;
  };
  /* guest↔guest mesh channel: both sides create a meshPeer for the same
     {room, pairKey}; they auto-pair as soon as both exist (symmetric park) */
  VirtualNet.prototype.meshPeer = function (meta) {
    var p = new VPeer(this, meta);
    this._meshPending = this._meshPending || {};
    var key = meta.room + '|' + meta.pairKey;
    this._meshPending[key] = this._meshPending[key] || [];
    this._meshPending[key].push(p);
    if (this._meshPending[key].length >= 2) {
      var a = this._meshPending[key].shift(), b = this._meshPending[key].shift();
      this._pair(a, b);
    }
    return p;
  };
  /* guest side; wires itself to the host peer that was created for the seat */
  VirtualNet.prototype.join = function (hostPeer, meta) {
    var g = new VPeer(this, meta);
    return this._pair(hostPeer, g);
  };

  global.LudoraNet = {
    Peer: Peer, VirtualNet: VirtualNet,
    codePack: codePack, codeUnpack: codeUnpack,
    roomId: roomId, secret: secret,
    MAX_MSG: MAX_MSG
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.LudoraNet;
})(typeof window !== 'undefined' ? window : globalThis);
