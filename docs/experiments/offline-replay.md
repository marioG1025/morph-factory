# Replay a signed VibeCheck session offline

The single-file replay lets someone try Change review with a browser. Open the HTML file, select **Check output**, and choose **Apply signed update**. **Compare results** appears on the same draft. Select **Show captured comparison** to see which four calendar cases changed. **Restore original review** removes the capability and preserves the selected tab.

## What executes

The file contains the factory’s three recorded release envelopes, their signed server rehearsals, the four Wasm binaries, the real VibeCheck patch and the six observed case outcomes. The builder embeds the pinned upstream `llp-core.js` unchanged and includes the Apache 2.0 license. No package installation is needed to open the finished file.

Two instances of LLP’s `LiveHost` execute in the visitor’s browser. One takes client placement and renders the review tree. The other takes server placement and executes the same stateless `reviewService` module as the live desk. An in-page adapter delivers the two service operations. Each host verifies the recorded manifest signature and hashes the Wasm it loads. Before each transition, the page also verifies the separate signed server rehearsal using the captured public key.

| Signed release | Response when the service receives Compare | Action available in the review tree |
| --- | --- | --- |
| 1 · Original review | Refused | Diff and Check output |
| 2 · Compare | Allowed | Compare results appears |
| 3 · Restored review | Refused | Original review actions return |

The result table comes from a real run of the calendar check on VibeCheck commit `6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24` and patched tree `7bb71ffcea84f90271e5120e1b71003a64d7d214`. These product observations are unsigned. The [live desk](../../README.md#try-it-on-a-real-product) runs the check anew, uses a WebSocket between the hosts, and can save a real Git branch. [Public capture](receipts/vibecheck-replay.json) · [Pinned product revision](https://github.com/marioG1025/VibeCheck/tree/6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24)

## Build and verify

From the factory checkout, use Python 3.11+ to build the file from the checked-in evidence.

```sh
python3 scripts/replay/build.py Morph-Factory-Replay.html
```

The [browser test](../../tests/browser/replay.test.mjs) opens the local file with network access disabled, follows all three signed releases in one document, checks the two actual server replies and the six case rows, then tries an altered manifest. The replay stops at that altered release.

To repeat the product work, supply a VibeCheck clone containing the pinned commit. The capture script creates an independent checkout, local signing key and state directory, so a new run has its own signatures. Two independent captures reproduced the same product base, patch digest, tree and case outcomes.

```sh
python3 scripts/replay/capture.py --repo /path/to/VibeCheck --output fresh-replay.json
```
