# First launch from a Windows ZIP

**Two fresh public source ZIPs opened usable VibeCheck desks in 4.33 and 4.32 seconds on this Windows machine.** Starting with an empty state directory each time, the package fetched the pinned product, installed its locked runtime dependency and rendered Change review. A browser operator then approved Compare results, ran the paired check, verified the patch and saved a local Git review branch.

## Tested artifact

On November 19, 2026 UTC, we cloned public `main`, created a ZIP with `git archive`, and extracted it into a fresh directory. The clone, extracted package, npm cache and desk state had separate paths containing spaces. The extracted source had no `.git` directory, installed runtime packages or pre-seeded product checkout. The repeat used a newer public commit with Git system and global configuration disabled. [First revision](https://github.com/marioG1025/morph-factory/tree/7acd4525398a6df3b712f8dd45f06850a2dbb7ac) · [Repeat revision](https://github.com/marioG1025/morph-factory/tree/83115a09643dda626a5110dfae4d500a439bf7be)

| Measurement | First | Repeat |
| --- | ---: | ---: |
| Archive size | 678,709 bytes | 681,233 bytes |
| Public clone, archive and extraction | 1.36 seconds | 1.33 seconds |
| First process launch to HTTP listener | 1.77 seconds | 1.75 seconds |
| First process launch to enabled approval control | 4.33 seconds | 4.32 seconds |
| Second process launch to restored review and comparison | 1.20 seconds | 1.08 seconds |

Setup requires Python 3.11+, Git, Node 22+ with npm, and first-run network access to GitHub and the npm registry. We used Windows 11, Python 3.11.0, Git 2.40.0.windows.1, Node 24.22.1, npm 9.5.0 and Microsoft Edge 157.0.4341.60. The repeat archive’s SHA-256 was `8eb523f7f20429b51347041bc0ecd152c6d69366e7b84b1f901b8e5394eff96d`. Both runs used fresh npm caches and confirmed that the extracted application installed its locked `ws@8.22.1`. The browser automation dependency lives outside the archive under test. These local timings include network and workstation load.

## What survived restart

The saved Git commit changed the concert-date formatters in `EventsPage.tsx` and `EventDetailPage.tsx`. Its parent was the [pinned VibeCheck commit](https://github.com/marioG1025/VibeCheck/tree/6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24). The original checkout stayed clean at that commit. Exactly one local review branch was added, and a read-only GitHub query confirmed the corresponding remote branch was absent.

A fresh application process and fresh browser context reopened the saved branch, exact diff, successful verification and comparison report. Four failures became passes and two timestamp controls kept passing. The desk served the same publisher key, signature and manifest at release 2. Test-owned files were removed after the run.

## Reproduce

Install the optional [Playwright test dependencies](../../tests/browser/README.md) in your working copy. From the factory root, run the following command. The local runner fetches whichever commit public `main` names when it starts and prints that SHA.

```sh
node scripts/packaging/verify-zip.mjs
```

To test a particular release download, pass `--archive "/path/to/Morph-Factory-v0.1.0.zip"`. Supply `--revision` with the full Git commit for an additional check against the ZIP’s embedded commit ID. The [source ZIP workflow](../../.github/workflows/package.yml) exercises the same extracted-package path on macOS, Ubuntu and Windows.

Pass `--scratch "path with spaces"` to choose the temporary workspace. The [smoke runner](../../scripts/packaging/verify-zip.mjs) launches the package through the Windows Python entry point below and drives the browser itself.

```powershell
python -B -u vibecheck.py --state-dir "Isolated desk state" --port 0 --no-open
```

The default port 8765 already served an active desk during this run. Using an explicit scratch state directory and an ephemeral port kept that desk outside the test. The Windows double-click wrapper invokes the same `vibecheck.py` entry point with default options. This measurement covers the CLI launch, application workflow and restart.
