# Third-party work

## Live Layer Protocol

Nikhil Ajay Kadalge authored Live Layer Protocol. Morph Factory uses its Apache License 2.0 reference implementation at [7598909](https://github.com/nik190799/live-layer-protocol/tree/7598909b2ae521ba9eb8ee12c825bcea912adede).

| Upstream component | How Morph uses it |
| --- | --- |
| JavaScript client host and connection adapter | Apply and render signed factory layers, preserve key/value state and acknowledge releases over WebSocket. |
| Server host, store and dependencies | Verify the paired release, run its server Wasm, serve content-addressed assets and relay changes to open desks. |
| AssemblyScript SDK | Compile the factory’s client and server review layers to four checked-in Wasm modules. |
| Task example layers | Demonstrate stateful swaps and recovery in the separate Live lab. |
| Go client implementation | Replay the factory’s actual signed release on an independent client in an [optional experiment](docs/experiments/go-host.md). The experiment fetches the pinned upstream implementation. |

The [source inventory](docs/upstream/inventory.json) maps each vendored file to an upstream path. Local deltas cover [explicit loopback binding](docs/upstream/server-host.mjs.patch), [disposal during a pending reconnect](docs/upstream/remote-client.mjs.patch) and the [lab’s controlled rehearsal fault](docs/upstream/rehearsal_v2.ts.patch). The factory’s own review modules and product-checking code live outside the vendored host.

To compare the inventory against upstream Git objects, use a local clone containing the pinned revision and run `python scripts/check-upstream.py --checkout /path/to/live-layer-protocol`. To check only the vendored contents, omit the checkout argument. [Reference host license](runtime/vendor/llp/LICENSE) · [Integration details](runtime/README.md#upstream-provenance)

The browser lab contains the reference JavaScript host in `ui/lab/llp-core.js` and the precompiled task layers `tasks.wasm`, `tasks_v2.wasm`, and `tasks_trap.wasm`. The additional `rehearsal_v2.ts` and compiled module derive from the upstream v2 task layer and add a controlled test failure for rehearsal. The local publisher signs with a new key each lab session. The [upstream license](ui/lab/LICENSE.txt) accompanies these files.

Read the [protocol specification](https://github.com/nik190799/live-layer-protocol/blob/7598909b2ae521ba9eb8ee12c825bcea912adede/SPEC.md), [server and client notes](https://github.com/nik190799/live-layer-protocol/blob/7598909b2ae521ba9eb8ee12c825bcea912adede/docs/HOSTS.md), and [the author's paper](https://doi.org/10.5281/zenodo.24349382).

## VibeCheck

[VibeCheck](https://github.com/marioG1025/VibeCheck/tree/6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24) is the target product in the reproducible case file. The launcher clones it separately. The example patches include the relevant surrounding source as Git diff context. The browser images show a test event served through a fixture API.
