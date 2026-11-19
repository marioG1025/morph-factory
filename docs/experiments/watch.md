# Check new commits while the desk is open

On an empty desk, turn on **Watch for new commits** to rescan committed source. To run the configured project command, also select **Run project check on new commits**. The first commit the tab sees becomes its starting point. **Check current commit** remains available for checking that starting point immediately.

When a new commit fails a named check, the result appears in **Findings**. **Prepare proposal** opens the same editable evidence used by manual intake. The operator can copy it, edit it, or explicitly submit it to a signed-in model. The watcher’s automatic actions are reading the local checkout and running the trusted command in a temporary clone. A command configured to install packages or contact a service retains its usual OS permissions. [Check intake](check-intake.md)

## What the two tabs observed

| Temporary product checkout | New failing commit | Later repair | Command invocations |
| --- | --- | --- | --- |
| Python pricing fixture | Removing the delivery fee made the total 8 instead of 9. Both tabs showed one named failure. | Reverting the change returned the suite to passing. | Zero in scan-only mode. One for the failing revision and one for the passing revision. |
| Pinned VibeCheck project | Reverting the calendar fix made four date-only checks fail in the list and detail views. Both tabs showed the failures. | Restoring the fix returned the six-case calendar probe to passing. | Zero in scan-only mode. One for the failing revision and one for the passing revision. |

The browser test counted actual command launches in a log outside the product checkout and checked the SHAs against the two observed commits. It also opened the editable failure form and recorded zero model submissions, draft creations or review-branch requests during watching. Both project working trees stayed clean. VibeCheck’s temporary test branch started from the [pinned revision](https://github.com/marioG1025/VibeCheck/tree/6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24) and used the [published calendar patch](patches/vibecheck-agent-calendar.patch) to control when the bug appeared.

## Watching behavior

- Each visible tab normally polls about every ten seconds and tracks the last HEAD it saw. A tab coming back into view observes the current tip. Intermediate commits between observations can be skipped.
- Tabs connected to the same desk share one in-flight command and reuse its result for the current commit and configured check. The manual **Check current commit** action can rerun that command.
- An open draft pauses watched checks. A draft created during a run invalidates that result, even if it is discarded before the command exits. A HEAD move during a run discards the old result and lets the watcher pick up the latest commit.
- A hidden tab or an open proposal form waits before requesting more work. Turning watching off stops future requests from that tab. A command already started can finish. Closing all tabs leaves no background scheduler.
- With no configured command, scan-only watching remains available. A runner error pauses watched checks and keeps scanning on. A connection failure pauses the watcher and displays the error. Once a command changes, the operator must opt in to that command.

## Reproduce

Run the backend tests and the [browser scenarios](../../tests/browser/watch.test.mjs) after preparing the [browser test environment](../../tests/browser/README.md). Set `MORPH_VIBECHECK_REPO` to a clone containing the pinned public commit to include the real-product case.

```sh
python3 -m unittest tests.test_commit_watch -v
node --test tests/browser/watch.test.mjs
```
