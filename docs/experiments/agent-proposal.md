# A signed-in proposal for VibeCheck’s concert dates

We started an empty factory desk against the public VibeCheck revision `6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24`. A real Codex CLI reported a signed-in ChatGPT session. The desk gave it a disposable read-only product checkout and an explicit request about the event list and detail formatters. Neither request included the factory’s prepared calendar patch. [Original list page](https://github.com/marioG1025/VibeCheck/blob/6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24/Music_Show_Helper/Frontend/src/pages/EventsPage.tsx) · [Original detail page](https://github.com/marioG1025/VibeCheck/blob/6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24/Music_Show_Helper/Frontend/src/pages/EventDetailPage.tsx)

## Evidence the operator selected

**Check current commit** ran the six calendar probes in America/Chicago. The operator selected `EventsPage · 2026-05-16` and opened **Prepare proposal**. The actual observation was Friday, May 15, where the list should show Saturday, May 16.

| Original input | List | Detail |
| --- | --- | --- |
| May 16 as a date only | May 15 · failed | May 15 · failed |
| January 1 as a date only | December 31 · failed | December 31 · failed |
| May 16 at 03:00 UTC | May 15 · passed | May 15 · passed |

The operator edited the brief to request the advertised local calendar day for date-only events, preserving timestamp handling and each page’s display style. It named both tracked TSX paths and limited changes to their two formatters.

## Completed model requests

**First request, one attachment.** The form attached the original list-page source. The detail path appeared in the brief. Codex returned its explicit `NO_CHANGE` response, so the desk kept the intake open and created no draft. This run produced no patch digest or candidate tree.

**Follow-up, both attachments.** The form accepted both original source paths, one per line. The failing case and edited brief stayed the same. Codex generated four additions across the two requested files. Each formatter detects a date-only input and selects UTC for displaying that value. Timestamp inputs retain the existing locale behavior. Git normalized and applied the model’s response in the proposal worker. [Exact generated patch](patches/vibecheck-agent-calendar.patch)

**Run checks** passed on the actual generated draft. The operator approved signed Change review version 2 and ran **Compare results** on the same open draft. Both date-only dates passed on both screens. Both timestamp controls continued to pass. The result was **4 fixed, 2 unchanged and 0 regressions**.

| Generated candidate | Recorded value |
| --- | --- |
| SHA-256 of the exact normalized UTF-8 patch | `c6979d5d70245f4034c9deae8aec566c33c4ef45140c005c51ee74585727c34f` |
| Git tree from both verification and comparison | `1d96993724aa5201ee2f505b3688eb74335c2d1a` |
| Comparison cases | Original 2/6 passing · generated candidate 6/6 passing |
| CLI used | `codex-cli 0.169.0-alpha.11.1` with ChatGPT sign-in |

The experiment ended with the product checkout clean at its original commit. It created no review branch, push or pull request. The evidence table identifies a Git tree and patch digest from the temporary experiment. The tree was never published to the VibeCheck repository.

## Replay evidence without a model

On a fresh empty desk, import the downloadable patch with **Add your patch**, verify it and compare it. We repeated this path and exported a receipt from its independent signed release. The replay reproduced the original proposal run’s patch digest, candidate tree and case counts. Its manifest and server rehearsal are signed. Product comparison counts are observations recorded by the local check runner. [Exact normalized diff](patches/vibecheck-agent-calendar.patch) · [Sanitized replay receipt](receipts/vibecheck-agent-calendar.json)

```sh
node scripts/inspect-receipt.mjs docs/experiments/receipts/vibecheck-agent-calendar.json --bundled
```

## Reproduce with a signed-in CLI

Use a disposable checkout of the pinned VibeCheck revision, a fresh state directory, Node 22+, Git, Python 3.11+ and an authenticated Codex CLI. Starting at the factory repository root, the following POSIX-shell command uses the focused date check for intake, verification and comparison.

```sh
python3 server.py --repo /path/to/VibeCheck --state-dir .morph-state/agent-dates --port 8766 \
  --check node "$PWD/examples/vibecheck/check-dates.cjs"
```

1. Choose **Check current commit**. Open the May 16 list failure and select **Prepare proposal**.
2. Request the advertised day on both screens for date-only values. Ask to preserve existing timestamp handling and formatting. Enter the original event-list and event-detail paths in **Tracked files for context**, one per line.
3. Review the text and choose **Generate patch** to send that request to the signed-in CLI. The model may return a patch or decline the change.
4. If a draft appears, inspect the file paths and diff. Use **Run checks**, approve **Compare results**, then use **Run comparison** on that draft. The comparison records both runs, the exact patch digest and the candidate Git tree. Creating a review branch is a separate action.

The probe executes the two production formatter functions against three inputs each. Broader browser rendering, service integration and production deployment are outside this measurement. [Date probe](../../examples/vibecheck/check-dates.cjs)
