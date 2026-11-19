# Live Change review

The factory uses [Nikhil Ajay Kadalge's Live Layer Protocol](https://github.com/nik190799/live-layer-protocol/tree/d14ebf9f8d17a45a3619231d4a9c63c00845bf96) to deliver **Change review** to the already-open factory floor. Two signed modules travel together. The client module draws the review controls. The server module answers which operations the current release permits.

| Release | Client slot `review` | Server slot `reviewService` |
| --- | --- | --- |
| Baseline | Shows the current draft and review actions | Reports the baseline release and refuses the compare operation |
| Compare results | Adds the paired comparison action on the open draft | Enables the compare operation for the approved release |
| Restore baseline | Streams the original client module under a newer signed version | Withdraws comparison for new requests |

## What happens when you approve

1. The local desk starts a Node sidecar connected to Python over standard input and output. Its publisher signs a proposed manifest with a locally generated P-256 key. The manifest names both SHA-256 module hashes, their client/server placement, their allowed state keys and their capabilities.
2. A disposable `ServerLiveHost` receives a copy of the committed server store and current release, then applies the actual candidate. It calls `reviewService:release` and `reviewService:compare` and signs a separate receipt of their expected and observed replies. This exercises server behavior before approval and gives the shadow host no project-command capabilities. The current server slot owns no business data to migrate. An incompatible future schema would need a representative server-state fixture.
3. The browser retrieves the candidate and signed server receipt and rehearses its own half. Approving sends the version currently on the desk and the SHA-256 digest of the **whole canonical candidate manifest**. A change to either binary, the capability grant, or any other signed field invalidates that approval.
4. `ServerHost.offer` verifies the release and activates the server slot. Upstream `ServerHost` persists the committed release before relaying the signed manifest to connected clients over its authenticated WebSocket. A new caller can therefore use the new server operation as soon as its compatible client has swapped.
5. Upstream `connectServer` receives the manifest. `LiveHost` verifies its signature, requests the content-addressed client module, rehearses the swap, and reports an ACK or NACK. The review panel receives an updated view from Wasm while the open draft stays in the factory.
6. The compare button calls `reviewService:compare` over LLP. The Python endpoint also asks the **currently active server Wasm** for permission before running the configured project check on the base and candidate. The factory owns Git checkouts and verification commands. The Wasm service owns permission to invoke comparison.

The approval route uses an in-process call to the upstream server host's `offer` entry point. The downstream server-to-browser link uses the upstream WebSocket protocol. Signing and serving run in the same local Node process for this experiment. The Python app and the user's target repository continue to use normal application code.

## Run and reproduce

Node 22 or later is required. The Python launcher checks `MORPH_NODE`, the normal executable path, and the bundled Codex runtime when available. The first use installs the locked `ws` dependency with npm lifecycle scripts disabled. To prepare dependencies explicitly, from the repository root run:

```sh
npm ci --prefix runtime --omit=dev --ignore-scripts
node --test runtime/tests/review-host.test.mjs
```

The checked-in modules are precompiled. To rebuild the four client and server modules with the pinned AssemblyScript compiler:

```sh
npm ci --prefix layers/review --ignore-scripts
npm run --prefix layers/review build
git diff --exit-code -- ui/layers runtime/layers
```

The wire test uses two real WebSocket clients and the actual modules. It checks client ACKs and state preservation, verifies that a candidate with different server code cannot use the old approval, exercises the remote operation, restarts the server on the persisted state, and restores baseline functionality through a newer release.

For a longer local test, `node runtime/tools/soak.mjs 5 /path/to/report.json` runs for five minutes and writes its progress and final result to a JSON file. Longer runs exercise idle-worker eviction, periodic reconnection, one-hour real token expiry and restoration across server restarts. The runner operates in a temporary directory and needs no GitHub, model or production services.

## Bootstrap, persistence, and trust

The WebSocket listens on loopback. The factory's same-origin HTTP bootstrap supplies a short-lived local operator token, the public verification key, the WebSocket address, and the active version. The connection token is checked during a WebSocket hello. Its default lifetime is one hour. Set `MORPH_SESSION_TTL_MS` to any integer from 1,000 to 86,400,000 before starting the desk to test reconnect behavior with a different lifetime.

The desk creates a checkout-specific live-state directory inside `--state-dir`. It stores its publisher key and the upstream host's content-addressed blobs and signed releases there. Keep that directory private. A process-held lock permits one live host to own the same persisted state at a time. On restart, the server re-verifies the saved signature before offering the release again. A local operator who replaces both the state and bootstrap can establish a different trust origin. This experiment makes no hardware-root or remote multi-user trust claim.

| Local interface | Purpose |
| --- | --- |
| `GET /api/live/session` | Same-origin client bootstrap, including authentication token |
| `GET /api/live/candidate` | Signed candidate, whole-manifest digest, and public key |
| `GET /api/live/blob/<sha256>` | Module bytes for candidate rehearsal |
| `POST /api/live/approve` | Commit the candidate for the expected active version and digest |
| `POST /api/live/restore` | Sign and commit the baseline as a newer release |
| `GET /api/live/status` | Active placement, grants, client connections and ACK count |
| `GET /api/live/evidence` | Active signed manifest, signature, public verification key and persisted signed server rehearsal receipt if available. Contains no session token |

The acknowledgement count records client-reported protocol state. It cannot certify correct human-visible behavior. The browser integration tests cover the review flow separately.

## Upstream provenance

Pinned upstream commit `d14ebf9f8d17a45a3619231d4a9c63c00845bf96`, Apache License 2.0. The [license text](vendor/llp/LICENSE) accompanies the copied files.

| Included under `runtime/vendor/llp/` | Upstream source at the pinned revision |
| --- | --- |
| `llp-core.js` | [Shared LiveHost, JCS signing, SHA-256 assets, state rules and worker isolation](https://github.com/nik190799/live-layer-protocol/blob/d14ebf9f8d17a45a3619231d4a9c63c00845bf96/host/llp-core.js) |
| `server-host.mjs` | [Server host, capability calls, release ordering, WebSocket relay and ACK handling](https://github.com/nik190799/live-layer-protocol/blob/d14ebf9f8d17a45a3619231d4a9c63c00845bf96/host/server-host.mjs) |
| `remote-client.mjs` | [Browser/Node connection adapter](https://github.com/nik190799/live-layer-protocol/blob/d14ebf9f8d17a45a3619231d4a9c63c00845bf96/host/remote-client.mjs) |
| `server-store.mjs`, `at-rest.mjs` | [Durable state and release store](https://github.com/nik190799/live-layer-protocol/blob/d14ebf9f8d17a45a3619231d4a9c63c00845bf96/host/server-store.mjs) and its [storage codecs](https://github.com/nik190799/live-layer-protocol/blob/d14ebf9f8d17a45a3619231d4a9c63c00845bf96/host/at-rest.mjs) |
| `fleet.js` | [Fleet support imported by the client and server modules](https://github.com/nik190799/live-layer-protocol/blob/d14ebf9f8d17a45a3619231d4a9c63c00845bf96/host/fleet.js) |
| `llp.ts` | [AssemblyScript layer SDK](https://github.com/nik190799/live-layer-protocol/blob/d14ebf9f8d17a45a3619231d4a9c63c00845bf96/sdk/assemblyscript/llp.ts) |

**Integration changes.** The vendored `ServerHost.listen` accepts an optional bind address so Morph can explicitly bind to `127.0.0.1`. The default argument preserves the upstream call shape. We also observed an upstream reconnect race: disposing a disconnected link while its retry timer was pending opened a new socket anyway. One line in `remote-client.mjs` checks the closed flag before opening a socket. The wire suite covers the disconnect, dispose and retry sequence.

Fleet rollouts and encrypted storage are present as upstream dependencies. The local Change review experiment uses one channel and persists public code and release state without opting into those features.
