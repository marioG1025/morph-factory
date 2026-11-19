# Browser integration tests

These tests start an isolated Morph Factory desk and drive Chromium against the pinned VibeCheck checkout. The tests exercise the actual signed browser/server Wasm pair, project checks and WebSocket relay.

From the repository root, install the test dependencies and browser using Node 22 or later. Python, Git and the runtime prerequisites in the [factory quickstart](../../README.md) must be available.

```sh
npm ci --prefix tests/browser
cd tests/browser
npx playwright install chromium
npm test
```

The standard VibeCheck launcher obtains the pinned public repository. To use an existing local clone instead, set `MORPH_VIBECHECK_REPO` to its path. The test harness clones that checkout into its own temporary directory. Set `MORPH_BROWSER_EXECUTABLE` for an existing Chromium-compatible browser or `MORPH_PYTHON` to select a Python executable.

| Scenario | Observed behavior asserted by the suite |
| --- | --- |
| Two open desks | A tampered server rehearsal receipt blocks approval. A valid rehearsal preserves the draft. After approval, both tabs show the streamed action, the selected evidence pane survives, and the observer keeps its keyboard focus, selected text, scroll and open disclosure. |
| Paired VibeCheck results | The calendar patch fixes four cases and preserves two controls. Restoring the original review removes the action in both open tabs. |
| Keep a tested patch | The baseline layer verifies and saves a real commit on a local review branch. Clearing the completed review keeps that branch and leaves the source checkout at its clean original commit. |
| Rejected credentials | A deliberately delayed, expired handshake receives a real server rejection. The same page obtains fresh credentials and keeps its selected pane. |
| Restarted release host | The test terminates only its own isolated sidecar. Its desk reconnects to the new endpoint and runs a real comparison on the original open draft. |
| Delayed result during a restore | One desk restores and reapproves Compare while the other has an unanswered remote call. Releasing the old reply cannot start work for the newer request. The current reply starts exactly one paired comparison. |
