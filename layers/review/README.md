# Change review layer

**Change review is Morph Factory’s first live product surface.** Open a draft in two tabs, select **Check output** in one, and approve **Compare results** in the other. Each tab receives the signed release and gains a working comparison on its own open draft. **Restore original review** publishes a new release that removes that action.

## What runs where

| Component | Responsibility |
| --- | --- |
| [Review layer](review.ts) | AssemblyScript emits the panel, selected evidence view, available actions and document references. Both [v1](v1.ts) and [v2](v2.ts) export the upstream LLP render/event ABI and state schema 1. |
| [Browser adapter](../../ui/layers/review-client.js) | Projects draft facts into the local LLP store, hosts signed releases, rehearses candidates, connects the real remote capability, and delegates approved work to the desk. |
| [Native renderer](../../ui/layers/review-renderer.js) | Maps the Wasm view tree to semantic HTML. Stable element keys preserve focus, scroll, selection and open disclosures during a compatible swap. |
| [Server layer](../../runtime/layers) | The companion signed Wasm module answers whether comparison is enabled. The local comparison endpoint checks the same authority before running the project check. |
| [Release host](../../runtime/README.md) | Owns release signing, persists the server commit, then relays the signed manifest to connected browsers using Nikhil’s protocol. |

The browser binds to the public key provided by the local desk at startup. On reconnect it obtains fresh credentials while retaining that key and the running host. A changed publisher requires opening a new desk. An established desk can inspect **Release details** for accepted versions, acknowledged clients and both running module hashes.

## State and capabilities

The signed manifest grants the browser layer read access to the `desk/` prefix and write access to `review/`. The host projects the current patch identity, title, summary, status and available evidence into `desk/`. The patch identity combines the base commit with SHA-256 of the exact UTF-8 diff. The layer owns the selected pane, any pending comparison request and its status under `review/`.

Both releases use `deskAction` to request the existing verify, save and discard workflows. The Compare release also requests `remote` and `compare`. Clicking **Run comparison** sends `reviewService:compare` through the upstream WebSocket adapter. A successful reply triggers the local paired check for that patch identity. The factory compares the original commit and patched tree in temporary checkouts and stores the report against that draft.

Full diffs and command output may exceed the SDK’s string buffer. The layer emits a document reference; the native renderer reads the corresponding draft data and inserts literal text into the DOM. This lets long patches scroll and lets the browser retain selections through an update.

When another tab completes a comparison, the upstream shared-state mirror delivers an opaque run ID, base commit, diff digest and release version. A matching desk fetches the saved report and updates the same Wasm-rendered panel. [Cross-tab delivery experiment](../../docs/experiments/shared-comparison.md)

## Rehearse a release

1. **Rehearse** obtains the candidate manifest, its signature and the signed server rehearsal. The browser recomputes SHA-256 over the canonical manifest and verifies the server receipt against the desk’s publisher.
2. An isolated browser `LiveHost` takes a copy of the current store and applies the active release followed by the candidate. It checks that the title, patch identity and selected pane survive and that the candidate renders a comparison action.
3. **Approve Compare results** runs rehearsal automatically if necessary. Approval includes the expected current version and rehearsed manifest digest. A tab applies the new controls only after its live host accepts the manifest delivered over the socket.

The rehearsal exercises the release contract. **Run comparison** exercises the product itself. To see both in the VibeCheck example, run the paired calendar probe and expand **Original output** and **Patched output**.

## Build and test

The shipped desk includes compiled modules. To rebuild both browser and server releases with Node 22 or later, run these commands from the repository root.

```sh
npm ci --prefix layers/review
npm run build --prefix layers/review
```

[Browser integration tests](../../tests/browser/README.md) cover the real release stream, paired VibeCheck checks, and recovery after losing the publisher connection. This experiment uses the [AssemblyScript SDK from Nikhil’s pinned upstream revision](https://github.com/nik190799/live-layer-protocol/blob/d14ebf9f8d17a45a3619231d4a9c63c00845bf96/sdk/assemblyscript/llp.ts).
