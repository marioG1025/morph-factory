# Worker lifetime across repeated review releases

**Change review now terminates the outgoing browser worker after its replacement has passed LLP’s checks.** An Ubuntu Chromium run completed 61 VibeCheck comparisons, then timed out waiting for the next rehearsal to report success. Its log ends at the wait. A local two-tab reproduction reached the same v123 → v124 boundary and reported a Wasm memory allocation error during rehearsal. The original job’s underlying error remains unknown. [Hosted log](https://github.com/marioG1025/morph-factory/actions/runs/44469007641/job/135373647683) · [Two-tab regression](../../tests/browser/release-turnover.mjs)

## Which part accumulated memory pressure?

We isolated the browser workload on Windows. Two client hosts kept the same draft projection through 72 approval/restore pairs. Before each approval, a disposable rehearsal host loaded the current and proposed signed modules, then closed. All three hosts used the shipping review Wasm and upstream signature and hash checks. [Reproducible probe](../../scripts/probe-worker-lifetime.mjs)

| Browser and worker policy | Completed pairs out of 72 | Observation |
| --- | ---: | --- |
| Edge 157.0.4341.60, reference reuse | 38 | The next rehearsal could not allocate Wasm memory while loading its baseline. |
| Same Edge, terminate at each swap | 72 | Both clients and every rehearsal completed. This is the factory policy. |
| Same Edge, allow eight loads per worker | 72 | This experimental policy bounded reuse. |
| Same Edge, reference reuse with diagnostic garbage collection every eight pairs | 72 | A control with identical browser flags and zero requested collections stopped after 38. |
| Firefox 153.0 and WebKit 26.5, reference reuse | 72 each | Both engines completed the ordinary workload. |

On Edge, running only the persistent clients or only the disposable rehearsals also completed all 72 pairs. In the failing combined workload, at most nine worker handles were open and all were terminated during cleanup. Together with the collection control, this points to the timing of Wasm memory reclamation in reused workers. The failure occurred at different release numbers across the fixture and full application. A separate server run crossed v123 with two current key/value entries and a 265-byte rehearsal snapshot.

## What the host guarantees

The factory’s `ReviewHost` overrides the reference `LiveHost.retire` hook for both the open review and its rehearsal. LLP verifies the offer and stages the new module before calling `retire`. The factory closes the retired worker there. LLP retains previous hashes for schema-compatible rollback and can load their bytes into a fresh worker. The operator’s **Restore original review** action publishes the original pair under a higher signed version. Draft and selected-pane state belong to the host. The regression asserts that the two original documents survive and the v124 comparison still fixes four calendar cases. [Factory hook](../../ui/layers/review-client.js) · [Upstream commit and retirement order](https://github.com/nik190799/live-layer-protocol/blob/d14ebf9f8d17a45a3619231d4a9c63c00845bf96/host/llp-core.js#L608-L637)

## Reproduce

Install the [browser test dependencies](../../tests/browser/README.md), then run from the repository root. The probe prints the browser build, number of completed pairs, fallback count and any failure stage. A failure exits with status 1. Browser builds and collection schedules can change the failure boundary.

```sh
node scripts/probe-worker-lifetime.mjs reference
node scripts/probe-worker-lifetime.mjs retire
node scripts/probe-worker-lifetime.mjs eight-loads
node --test tests/browser/release-turnover.mjs
```

These runs measure release correctness. Click-to-ready latency is tracked in the separate [adoption experiment](adoption.md).
