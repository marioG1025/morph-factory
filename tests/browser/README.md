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

## Endurance interval coverage

Run `node tests/browser/soak.mjs` from the factory root. Set `MORPH_SOAK_MINUTES` for the timed interval and `MORPH_SOAK_INTERVAL_SECONDS` for the wait between comparisons. The wire runner accepts minutes and an output filename, for example `node runtime/tools/soak.mjs 5 wire-result.json`.

Both runners take a heartbeat every five seconds during intentional waits, including the wire test's 165-second idle-worker check. A gap above 15 seconds on either the UTC or monotonic clock, or a backwards UTC reading, fails the interval. The output's `coverage` field includes the heartbeat count and longest observed gap. A failure includes the UTC timestamps on both sides of the interruption. Cycle and transition counts separately describe the work the factory completed. Rerun a failed interval on an awake host with a stable clock. [Coverage regression tests](../../runtime/tests/soak-coverage.test.mjs)

## Optional Firefox and WebKit acceptance

The [cross-browser workflow](../../.github/workflows/browser-engines.yml) runs on manual dispatch. Each Ubuntu 24.04 job installs the browser build associated with the locked Playwright version and runs the same [two-tab Change review scenario](review-acceptance.mjs) as the default Chromium suite. The job summary records the engine version, platform and outcome. The first run passed on both engines. [Measured builds and job logs](../../docs/experiments/browser-engines.md)

To run the scenario locally on Ubuntu, use the following commands from `tests/browser` after `npm ci`. Choose `firefox` or `webkit` and leave `MORPH_BROWSER_EXECUTABLE` unset so the selected engine launches its matching build.

```sh
export MORPH_BROWSER_ENGINE=firefox
npx playwright install --with-deps "$MORPH_BROWSER_ENGINE"
npm run test:acceptance
```

The acceptance test opens a real VibeCheck draft in two tabs, rejects a corrupted rehearsal receipt, rehearses and approves the genuine release, checks pane and document continuity, and runs the paired product checks. It restores the original review, saves the verified patch on a Git branch, and confirms the source checkout is still clean.

## Scenarios

| Scenario | Observed behavior asserted by the suite |
| --- | --- |
| Two open desks | A tampered server rehearsal receipt blocks approval. A valid rehearsal preserves the draft. After approval, both tabs show the streamed action, the selected evidence pane survives, and the observer keeps its keyboard focus, selected text, scroll and open disclosure. |
| Paired VibeCheck results | The calendar patch fixes four cases and preserves two controls. Restoring the original review removes the action in both open tabs. |
| Shared comparison document | A four-field LLP marker prompts one observer read for the measured report. A duplicate notification and delayed response cannot attach an older result to a recreated draft. |
| Keep a tested patch | The baseline layer verifies and saves a real commit on a local review branch. Clearing the completed review keeps that branch and leaves the source checkout at its clean original commit. |
| Rejected credentials | A deliberately delayed, expired handshake receives a real server rejection. The same page obtains fresh credentials and keeps its selected pane. |
| Restarted release host | The test terminates only its own isolated sidecar. Its desk reconnects to the new endpoint and runs a real comparison on the original open draft. |
| Delayed result during a restore | One desk restores and reapproves Compare while the other has an unanswered remote call. Releasing the old reply cannot start work for the newer request. The current reply starts exactly one paired comparison. |
