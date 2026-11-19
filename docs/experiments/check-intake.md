# From a failing check to an editable proposal

An empty desk can now collect evidence before a patch exists. **Check current commit** runs the project command configured at startup in a clean, detached copy of the selected Git commit. A named failure opens an editable proposal containing its test name, observed result and full base commit. The operator can copy the text or submit it with **Generate patch**.

## Open a Python product

```sh
python3 server.py --repo /path/to/product --check python3 -m unittest discover -s tests
```

Click **Check current commit** under **Findings**, expand a failure, then choose **Prepare proposal**. In the form, edit the requested outcome and review the evidence. **Copy proposal text** works with an unavailable Codex CLI. If clipboard access is unavailable, the button selects the text for keyboard copying. Generating a patch requires its own button press and the authenticated CLI.

Project commands must work from a clean checkout. The desk understands failure names in native Python unittest output and in the same `MORPH_CASE_REPORT` JSONL format used by Compare results. The [unittest adapter](../../scripts/check-unittest.py) also reports structured fixture errors, skipped methods and empty discovery. Commands that report only a nonzero exit code display that outcome and their local output. A missing executable, a malformed case report, a timeout or an empty suite gets a diagnostic.

## What happened on two products

| Product | Command against committed source | Observation |
| --- | --- | --- |
| VibeCheck at `6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24` | Existing VibeCheck check with whole-commit scope | Four date cases failed across list and detail views. The frontend build also failed. The first proposal named `EventsPage · 2026-05-16` and included the observed May 15 and expected May 16 dates. |
| Independent Python pricing fixture | `python -B -m unittest discover` | `test_total (test_price.Price.test_total)` reported 8 instead of the expected 9 when the delivery fee was 1. The browser recognized the native unittest output without a project-specific adapter. |

The browser scenarios edited and copied the evidence for both products. They simulated an unavailable CLI and observed zero requests to start a model job or create a review branch. A separate local HTTP integration test explicitly submitted an edited idea to a controlled patch generator. The normal proposal worker created an unverified draft against the checked commit. Its final model response was supplied by the test fixture.

To open the empty VibeCheck intake alongside the prepared walkthrough, use a checkout at the pinned revision and a fresh state directory. Run this command from the factory repository in a POSIX shell.

```sh
python3 server.py --repo ../VibeCheck --state-dir .morph-state/intake --port 8766 \
  --check python3 "$PWD/examples/vibecheck/check.py"
```

The evidence is session-local and commit-specific. A new check invalidates the previous run. The backend verifies the run, commit and failing case before accepting a proposal and rechecks the source when the generated patch arrives. A different draft appearing and disappearing during the check invalidates the pending result. The UI shows up to 12 named failures or diagnostics, up to 600 characters of detail each, and the final 2,400 characters of command output. The prefilled request includes only the selected failure.

## Reproduce

The Python tests exercise named, empty, unavailable and unclassified command outcomes, staged work, stale evidence and concurrent draft changes.

```sh
python3 -m unittest tests.test_head_check -v
```

After [setting up the browser tests](../../tests/browser/README.md), set `MORPH_VIBECHECK_REPO` to a checkout containing the pinned VibeCheck commit and run the two product scenarios.

```sh
node --test tests/browser/intake.test.mjs
```
