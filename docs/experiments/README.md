# Morph Factory experiment notebook

**Question.** Can an operator approve a new server operation while someone is reviewing a real product patch, and immediately use it from the same browser document?

**Observed.** On the pinned VibeCheck draft, both open tabs gained Compare results after approval. The browser test checks the original document, selected pane and draft identity, then invokes a real product comparison. The approved server module and the browser module appear together in a signed release. [Browser scenarios](../../tests/browser/README.md) · [Portable example receipt](receipts/vibecheck-calendar.json)

The [adoption measurements](adoption.md) cover 40 approvals across one, two, four and eight open tabs. The [concurrent build experiment](concurrent-build.md) records a release arriving in two open tabs during a real Vite build. The [check intake experiment](check-intake.md) starts earlier in the product workflow and turns a failing check into an editable proposal.

## The product change and the factory change

| Change | Original | With the patch or release |
| --- | --- | --- |
| VibeCheck date-only shows in America/Chicago | May 16 appears as May 15 in the event list and detail page. A January 1 case also displays the previous day. Two timed-event controls pass. | Both calendar dates display on their advertised day in both views. All six checks pass. [Product patch](../../ui/lab/calendar-day.patch) · [Executable probe](../../examples/vibecheck/check-dates.cjs) |
| VibeCheck frontend production build | TypeScript rejects `import.meta.env` with TS2339. | Adding the Vite client types allows TypeScript and Vite to complete. The check uses the same recorded dependency set for both revisions. [Product patch](../../ui/lab/vite-types.patch) · [Build runner](../../examples/vibecheck/check.py) |
| Factory Change review | The original server denies comparison. An open draft offers diff and check output. | The operator rehearses and approves the signed pair. Both open clients gain a working comparison. Restore publishes the previous pair under a higher version. [Wire tests](../../runtime/tests/review-host.test.mjs) |
| The same layer on a different host | The browser uses the upstream JavaScript host. | An unmodified upstream Go host independently verified the same signed manifests and produced the same complete UI tree and key/value state at six checkpoints. [Go experiment](go-host.md) |
| The factory’s own test discovery | The original Python invocation appeared to succeed after discovering zero tests. | The factory reviewed a one-file fix that made 13 tests discoverable. The verified candidate tree matched the commit saved on the local branch. [Self-hosting run](self-host.md) |
| Canary approval in a fixed three-client cohort | One stable desk receives Compare while another remains on the original review. | Waiting for the selected client’s ACK allows promotion. The controller can report completion before the downstream desk has acknowledged the change. Widening can produce a stale-version NACK on the already upgraded client. [Fleet experiment](fleet.md) |

VibeCheck’s reference revision is `6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24`. The focused calendar probe calls the two checked-out formatter functions. The separate screenshots exercise list and detail navigation against a fixture API. Spotify authentication and production event feeds are outside that test. [Pinned product](https://github.com/marioG1025/VibeCheck/tree/6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24) · [Original detail page](../../ui/lab/baseline-detail.png) · [Corrected detail page](../../ui/lab/corrected-detail.png)

## What we learned from LLP

**Placement changes the order of operations.** The server host commits its own layer before relaying the manifest. This let us use the server module as the authority for whether Compare is available. The browser verifies the offer and activates the matching UI. We recheck authority when starting a project command and before recording its result. [Release host](../../runtime/README.md) · [Python desk](../../server.py)

**Preserving a draft is an application contract.** The signed client layer owns the selected pane. The factory supplies a draft identity, diff and check output. We pass typed document references to the native renderer so large logs stay outside the Wasm string interface. The same Wasm renders on the Go host, where displaying document contents requires a Go-side renderer. [Layer contract](../../layers/review/README.md) · [Go replay](go-host.md)

**A valid signature can still describe the wrong behavior.** We tried a well-formed signed candidate whose service gave the wrong answer. The isolated server rehearsal rejected it while the active desk kept working. Approval binds the proposed client and server code, grants and placement via the digest of the entire manifest. The two server assertions exercise the current stateless service. Future state migrations will need representative data. [Rehearsal implementation](../../runtime/rehearsal.mjs) · [Test cases](../../runtime/tests/review-host.test.mjs)

**Reconnection is part of the operator experience.** A disconnected client could open a replacement socket after being disposed. We recorded the one-line upstream delta and tested a real disconnect, disposal and pending retry. A browser test separately restarts its test-owned publisher, obtains fresh credentials and compares on the same open draft. [Upstream delta](../upstream/remote-client.mjs.patch) · [Browser tests](../../tests/browser/README.md)

## Verify a downloadable result

```sh
node scripts/inspect-receipt.mjs docs/experiments/receipts/vibecheck-calendar.json --bundled
```

This checks the release signature, hashes the shipped browser and server Wasm bytes, and verifies the separate signed server rehearsal. The example reports four fixed cases, two unchanged, and zero regressions. Comparison counts are an unsigned observation from the local checkout. To verify publisher identity against a key obtained independently, supply that JWK as the second argument. To reproduce the product result itself, run the [VibeCheck walkthrough](../../README.md#try-it-on-a-real-product).

## Reproduce from source

```sh
npm ci --prefix runtime --omit=dev --ignore-scripts
python3 scripts/check-upstream.py
python3 -m unittest discover -s tests -v
npm test --prefix runtime
```

Set `MORPH_VIBECHECK_REPO` to a local checkout at the pinned product revision to include the VibeCheck comparison tests in the Python suite. The hosted checks prepare it explicitly. The [browser guide](../../tests/browser/README.md) covers Chromium setup, and [runtime notes](../../runtime/README.md) describe rebuilding all four modules. [Hosted checks](https://github.com/marioG1025/morph-factory/actions/workflows/check.yml)

To recreate the README animation, prepare Chromium as in the browser guide, run `node scripts/capture-demo.mjs <frame-directory>`, then run `python scripts/render-demo.py <frame-directory> docs/media/live-review.gif` with Pillow installed. Each frame is a screenshot of the running product.
