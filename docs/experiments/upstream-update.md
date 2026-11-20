# Updating the factory to LLP 7598909

On November 20, 2026, Morph Factory v0.1.0 adopted Nikhil Ajay Kadalge’s update for text entered during a live layer swap. The previous pin was `d14ebf9`. One upstream commit changed the shared JavaScript host, the example renderer template, its generated demo and a browser test. [Upstream change in full](https://github.com/nik190799/live-layer-protocol/compare/d14ebf9f8d17a45a3619231d4a9c63c00845bf96...7598909b2ae521ba9eb8ee12c825bcea912adede)

## What a renderer gains

Suppose someone types while a signed update is still loading. LLP queues the committed write behind that update. Reading the committed store during a redraw can therefore replace the latest keystroke with older text. The new `host.bound(key)` reads the most recently typed value during that interval. The host clears its temporary copy after committing the last queued write for that key. A renderer binds an input by writing with `setBound` and reading with `bound`. The upstream demo exercises typing across an upgrade five times. [Host implementation](https://github.com/nik190799/live-layer-protocol/blob/7598909b2ae521ba9eb8ee12c825bcea912adede/host/llp-core.js#L720-L732) · [Upstream browser case](https://github.com/nik190799/live-layer-protocol/blob/7598909b2ae521ba9eb8ee12c825bcea912adede/test/browser.mjs#L73-L90)

## What the factory imported

The factory's Live lab now keeps its existing **Unfinished note** editable during an upgrade and renders it with `host.bound("draft")`. In Edge 157 we held the signed v2 module load, inserted “ Friday,” inside “Ship now”, and moved the caret to position 11. At redraw, the committed store still contained “Ship now”. The operator saw “Ship Friday, now” and kept focus and caret position 11. With the same host and a renderer that read only the committed store, the visible field reverted to “Ship now” and the caret moved to 8. After a fault rehearsal rolled back the guest, the real Add action consumed the complete note once. [Factory change](https://github.com/marioG1025/morph-factory/commit/d9bb142) · [Browser regression](../../tests/browser/lab.test.mjs)

Two of the 16 inventoried files changed bytes. The desk runtime and the Live lab both ship the upstream core with SHA-256 `fb4f2ad37c7d3bee285f0577055d38a6b5a06b71bdd90d42ebe74fb7abf6f736`. The Git comparison found identical WebSocket adapters, persistence, AssemblyScript SDK, upstream task Wasm and Go implementation across these revisions. The factory’s four compiled Change review modules kept their existing digests. [Source inventory](../upstream/inventory.json) · [Factory layers](../../layers/review/README.md)

All three local deltas still apply. The factory can bind the server to loopback, cancel a previously scheduled reconnect after a client closes, and exercise a controlled fault in its separate rehearsal example. Change review’s policy for retiring browser workers also lives in the factory. [Server patch](../upstream/server-host.mjs.patch) · [Client patch](../upstream/remote-client.mjs.patch) · [Rehearsal patch](../upstream/rehearsal_v2.ts.patch) · [Worker-lifetime experiment](worker-lifetime.md)

## Compatibility checks

| Check | Observed with the new core |
| --- | --- |
| Isolated factory checkout on Windows | All 10 signed-runtime tests passed after replacing only the two copies of the upstream core. |
| Two Edge 157 review tabs, real VibeCheck checkout | The operator rehearsed and approved Compare, measured four fixed cases and two unchanged controls, and restored the original review. The peer received one 264-byte shared update and requested the same saved run. |
| Windows Chromium 151, release turnover | After 61 approval/restore cycles, release 124 ran one comparison on the operator’s tab. The peer ran zero. Each tab kept its original document and WebSocket. The [single-file replay](offline-replay.md) also opened and completed offline with the new embedded core. |
| Go client replay | Six full view-tree and state checkpoints matched the JavaScript host across three signed versions. Both upstream commits contain the same Go source tree. |
| Fleet rollout | A preview and two stable clients reached the expected release versions. Widening the canary still produced the previously recorded same-version NACK. |

To verify the new pin against a clone containing the commit, run `python scripts/check-upstream.py --checkout /path/to/live-layer-protocol`. The check compares every inventoried file and each recorded patch with the upstream Git objects. [Two-tab acceptance test](../../tests/browser/review-acceptance.mjs) · [Go replay](go-host.md) · [Fleet procedure](fleet.md)

## Two upstream versions on one open draft

We loaded the original upstream client core in one Edge 157 tab and the newly pinned core in another. We checked the SHA-256 of the JavaScript bytes each tab received. Both used the current factory's WebSocket adapter, signed layers and publisher.

| Operator's client | Passive client | Compare release | What arrived at the passive tab |
| --- | --- | ---: | --- |
| Original `d14ebf9` | New `7598909` | 2 | Four fixed dates and two unchanged controls in one report read |
| New `7598909` | Original `d14ebf9` | 4 | The same result in one report read |

The operator ran the check once from each tab. The passive tab submitted zero comparison commands in either direction. Both tabs retained their original document and selected pane through restores to v3 and v5. Each run measured the same VibeCheck candidate tree, `7bb71ffcea84f90271e5120e1b71003a64d7d214`. Reproduce with `node scripts/interop/mixed-clients.mjs /path/to/live-layer-protocol` using an upstream clone containing both commits. [Mixed-client browser probe](../../scripts/interop/mixed-clients.mjs)
