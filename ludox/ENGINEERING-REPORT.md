# Ludora — Production Upgrade & Serverless Multiplayer · Engineering Report

**Verdict: complete.** 112 automated checks pass across five suites. Offline gameplay has zero backend dependency; online play adds WebRTC peer-to-peer as a layer, not a dependency.

## Files changed
| File | Change |
|---|---|
| `js/net.js` **new** | WebRTC `Peer` (offer/answer codes, non-trickle ICE, ordered DataChannel), connection-code codec (deflate via `CompressionStream`, strict regex/bounds unpack), `VirtualNet` test transport with flush-on-close semantics |
| `js/mp.js` **new** | `Room` (host-authoritative) + `Guest` protocol: seat secrets, whitelisted messages, bounds checks, flood limits, strike/kick, sequence numbers, keepalive + RTT, disconnect detection, reattach-on-reconnect, AI takeover, early end, injectable protocol clock |
| `js/qr.js` **new** | From-scratch QR encoder (byte mode, EC-L, v1–20, all 8 masks + penalty selection, RS interleaving). Zero dependencies |
| `js/persist.js` **new** | Versioned+checksummed envelopes, last-good-backup rotation, torn-write recovery, migration chains, IndexedDB primary / localStorage mirror / memory fallback, snapshot isolation, strict export/import |
| `js/store.js` | Rewritten as a thin shim over persist (same synchronous API; lazy schema registration: profile v1→v2, match v1→v2) |
| `js/game.js` | Net roles (`netHost`/`netGuest`): host syncs every transition (`rolled`/`moved`/`turn`/`end` fx + full state); guests are snapshot-driven replicas (validated `validateState`, seq-guarded, same visual pipeline). Dirty-flag rendering (idle frames skip all canvas work), reused draw buffers, reduced-motion support, SR announcements, dead-seat turn skipping, mid-roll game-over guards, online matches excluded from local resume |
| `js/profile.js` | Schema v2 (+online stats), online matches count for the local player, `v:2` on save |
| `js/engine.js` | `MODES` + validation accept `online` |
| `js/audio.js` | `navigator` guard (non-browser/edge environments) |
| `js/board.js` | Yard initial letters — non-color player identification |
| `js/ui.js` | Multiplayer hub/host lobby/guest flow/invite+QR sheets/connection chip/disconnect sheets; online variants of pause & end screens; `#sr-live` announcements; export/import UI; nav teardown for rooms; storage reconciliation hook |
| `index.html`, `css/app.css` | New screens, net chip, sr-only live region, icon sprite (+share), MP styles, a11y helpers; script order persist→store |
| `sw.js` | Version `v1.1.0`, precaches the four new modules — `addAll` keeps the shell atomic |
| `dev/` | `harness.js` (deterministic clock + stub canvas), `mp-tests.cjs` (21), `persist-tests.cjs` (16), `qr-tests.cjs` (6), extended `tests.cjs` (52) & `integration.cjs` (17) |
| `README.md`, `ludora.html` | Multiplayer docs + rebuilt single-file bundle (293 KB) |

## Multiplayer architecture
- **Transport**: WebRTC DataChannels, ordered/reliable, DTLS-encrypted. No Ludora server, no signaling backend — humans carry a one-time invite/reply code (copy · native share · QR with `#j=` deep link). A public STUN server is used only for NAT discovery; it never sees game data. Same-LAN play works even without it.
- **Authority**: the host runs the *same* engine as offline play. Guest inputs are requests (`roll`, `move{token}`) re-validated host-side (right seat → right phase → legal move). Guests never mutate state; they apply validated, sequence-numbered snapshots and replay the host's fx through the identical animation path. Dice are host-generated (`crypto.getRandomValues`, rejection-sampled) and ride the sync stream — verified identical across all clients.
- **Failure handling**: ping/pong keepalive (2.5 s / 9 s), disconnect broadcast + visible skip (never a silent freeze), reconnection by re-invite with identity/seat retention and live-state resume, mid-match AI takeover, host early-end by progress, host-leave room closure.

## Security (honest scope)
Session-level integrity: seat secrets in codes, message whitelisting, bounds checks, seq guards, flood/strike kicks, fx field clamping, no executable payloads, all text escaped. This is *not* server-side anti-cheat — there is no server; a modified client can always lie to itself locally. Host authority prevents peers from injecting illegal moves into the shared game.

## Persistence changes
Dual-store (IDB primary, LS mirror, memory fallback), checksummed envelopes, backup rotation, torn-write recovery, migration chains (legacy v1 profiles upgrade losslessly — tested), snapshot isolation (a live-match mutation can never poison a save — bug found & fixed by tests), strict export/import. Not tamper-proof, by design of the platform.

## Accessibility
ARIA live region for turns/rolls/captures/wins; labeled controls & `role=switch`; keyboard (Space/1–4/Esc, push-stack back); visible focus; ≥44 px targets; non-color identification (names in HUD/chip + yard initials); reduced-motion honored in CSS *and* canvas animation.

## Performance findings
Render loop now draws **zero** canvas work while idle (dirty-flag; verified single-frame settle during AI/remote turns); per-frame allocations removed (reused draw buffers, bound rAF handler); static/dynamic layers remain split; particles self-prune; all MP protocol work is O(seats) JSON. Bundle: 45 KB gzipped core (+~28 KB multiplayer).

## Tests — 112 passing / 0 failing
- Unit 52 · Persistence 16 · QR 6 (incl. published 0x77C4 vector) · Multiplayer 21 · Integration 17.
- Multiplayer coverage includes full 2/3/4-player games **and** mixed human+AI through the real controllers over the virtual network; 5 consecutive clean suite runs after flake fixes.
- Verified live: all assets 200 (correct MIME), SW version bump, offline shell precache list, single-file bundle self-contained.

## Known limitations
1. Host is a single point of failure; no host migration. 2. Guest reconnect needs a fresh seat invite. 3. Manual code exchange is inherent to serverless signaling. 4. QR capped at v20 (~860 B) — very long invites fall back to copy/share. 5. STUN dependency for cross-NAT play. 6. Cross-device QA beyond jsdom/Node (iOS Safari, Android Chrome on real hardware) could not be executed in this environment — code paths are guarded, but field verification remains.

## Remaining production risks
- WebRTC SDP munging differences across browsers (mitigated: full SDP carried, no trickle).
- iOS backgrounding can drop DataChannels mid-match (mitigated: visible disconnect handling + reconnect path).
- IndexedDB eviction under storage pressure in Safari (mitigated: LS mirror + recovery flows).
