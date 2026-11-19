# The same Change review layer on the JavaScript and Go hosts

Morph’s review layer ran on LLP’s independent Go client. Its complete UI tree and host-owned key/value state matched the JavaScript client at six checkpoints. Selecting **Check output** on version 1, installing **Compare results** on version 2, and restoring the earlier code on version 3 all preserved the selected tab and draft identity.

The experiment ran on Windows x64 on November 18, 2026 with Go 1.26.2, wazero 1.9.0 and Node 24.22.1. Both hosts consumed the same signed manifests and Wasm bytes from the factory. The Go runtime came from an archive of the pinned [upstream Go implementation](https://github.com/nik190799/live-layer-protocol/tree/d14ebf9f8d17a45a3619231d4a9c63c00845bf96/impl/go).

## What ran

The JavaScript fixture exporter starts the actual factory publisher and LLP server on loopback with a fresh signing key. It captures each signed envelope **after** the server accepts it. The JS client applies those envelopes, dispatches the operator’s tab changes, and renders its review tree. The probe then hands the public key, envelopes, content-addressed blobs and recorded actions to the Go client. Go independently verifies each release, runs the same UI code under wazero, and compares its full tree and state against each JS result.

| Version | Action | Observation on both hosts |
| --- | --- | --- |
| 1 | Open the draft | The view references the diff document. |
| 1 | Select Check output | The selected tab and document change to checks. |
| 2 | Approve the signed Compare release | The compare action appears while the checks tab stays selected. |
| 2 | Supply the comparison-available flag | The tree references both checks and comparison documents. |
| 3 | Restore the original layer | The compare action disappears and the checks tab stays selected. |
| 3 | Select Diff | The diff document returns on the same draft. |

The Go client fetched two distinct client layer blobs across three releases. It reused the original blob on restore. It also respected client/server placement and produced exactly one client slot named `review`.

The initial measurement used these SHA-256 content addresses. Rebuilding changed source may yield different addresses. The runner prints the hashes it actually evaluated.

| Client layer | SHA-256 |
| --- | --- |
| Original review | `621de1317f6babd1a03e82ca9c5a2c0617101cc1a0036484cb96a688b3d28e77` |
| Compare release | `360131def246491798623dc6e773ff9c80bf625d55822b7bd75c67a0be6c8ed3` |

## What the result means for a second client

The Wasm layer emits factory-specific nodes such as `document` with a `source` attribute of `diff`, `checks`, or `comparison`. Both runtimes preserve these nodes and attributes in their output trees. On the browser, Morph’s [review renderer](../../ui/layers/review-renderer.js) turns those references into the real diff, check log and comparison panel. A Go desktop or terminal app would supply its own renderer and document data. Matching tree output establishes instruction parity. It does not establish pixel parity.

The Go replay reads its envelopes locally. The JavaScript server handles the server role, while the Go client exercises signature verification, client placement, rendering, state and blob reuse. This experiment uses a fixture for draft metadata and the availability of check results. The factory’s real VibeCheck product checks run separately.

## Reproduce

With Python 3.11+, Git, Node 22+, npm and Go 1.24+ available, run this from the factory repository root.

```sh
python scripts/interop/run.py
```

The runner fetches the pinned upstream commit and prepares a temporary Go module. On a first run the Go toolchain may fetch wazero; its checksum comes from the pinned upstream `go.sum`. Set `--upstream /path/to/live-layer-protocol` to use a local checkout containing that commit. Set `--go /path/to/go` to use a portable Go binary. Fixture contents and temporary keys are removed when the run exits.

The Windows measurement used the official portable Go archive and verified its published SHA-256, `98eb3570bade15cb826b0909338df6cc6d2cf590bc39c471142002db3832b708`. [Go release archive](https://go.dev/dl/#go1.26.2)

The [optional parity workflow](../../.github/workflows/interop.yml) runs on demand and on pull requests that affect these components.
