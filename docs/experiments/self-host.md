# Morph Factory reviewed its own test discovery fix

On its own repository, the startup guide’s Python verification example returned exit code 0 after running zero tests. Python 3.11’s default unittest discovery skipped the `tests/` directory at the repository root because it had no package marker. A one-file candidate added `tests/__init__.py` and made the existing suite discoverable.

We tested a clean clone of [Factory revision ba00706](https://github.com/marioG1025/morph-factory/tree/ba00706ee729490e870057c1db29a1e37fd315df) through the same browser controls available to any product. The clone had a staged file and an unfinished README edit. Its Git remote was removed before starting the desk.

| Measurement | Original | Candidate |
| --- | --- | --- |
| Discovered Python tests | 0 | 13 |
| Passing test methods | 0 | 10 |
| Optional VibeCheck tests skipped | 0 | 3 |
| Check that discovery finds at least one test | Failed | Passed |

The operator clicked **Scan only**, imported the unified diff with **Add your patch**, selected **Check output**, and approved **Compare results**. The compare action appeared on the open draft and kept the selected tab. Both revisions used the same trusted check command in separate temporary checkouts. The new evidence showed ten previously undiscovered passing methods and three opt-in methods that require an external VibeCheck checkout.

**Run checks** verified the candidate separately. **Save review branch** created a real local Git commit. Its parent matched the pinned snapshot. The saved commit, comparison and verification all identified candidate tree `0d4d87a0e37c31072ecf7ecb676167deac85fda3`, with `tests/__init__.py` as its only change. The operator’s checked-out branch, index and modified README retained their initial contents. The generated clone, review branch and local state are removed at the end of each run.

## Use named checks on a Python product

The factory now includes a [standard-library unittest adapter](../../scripts/check-unittest.py). It discovers the project’s suite, requires at least one test, prints unittest’s normal output and gives Compare results stable per-test IDs. You can use it from the factory checkout without adding a dependency to the product.

```powershell
$checkRunner = (Resolve-Path .\scripts\check-unittest.py).Path
python server.py --repo C:\projects\my-product --check python $checkRunner --start-dir tests
```

Set `--start-dir` to the product’s test directory or use the default repository root. Set `--pattern` if its test files use a different naming convention. The adapter preserves assertion failures, skipped tests, unexpected successes and fixture errors in the evidence. Subtest outcomes appear under their parent method. For a suite exceeding the desk’s case-report limit, it reports a suite total and writes the normal test diagnostics to the command output. Projects that already have another trusted test command can continue to pass that command to `--check`.

## Reproduce the browser experiment

Use a full factory clone containing the pinned revision, Python 3.11+, Git and Node 22+. From the repository root, install the browser test dependencies and run the [self-hosting experiment](../../scripts/self-host.mjs).

```sh
cd tests/browser
npm ci
npx playwright install chromium
cd ../..
node scripts/self-host.mjs
```

The runner starts the normal `server.py --repo … --check …` entry point, drives the local browser, then checks Git’s actual refs, trees and the operator’s pending edits. It prints the case counts and branch result. Set `MORPH_BROWSER_EXECUTABLE` to use an existing Chromium-compatible browser. The recorded run used Windows x64, Python 3.11.0, Git 2.40.0, Node 24.22.1 and Microsoft Edge 157.0.4341.60.
