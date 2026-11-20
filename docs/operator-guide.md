# Operating the local desk

Morph Factory turns a product idea or source finding into a patch you can inspect, test and keep on a Git review branch. For the guided experiment where you approve Compare results on an open draft, start with the [project walkthrough](../README.md#try-it-on-a-real-product).

## Open the VibeCheck desk

Install Python 3.11 or later, Git, and Node 22 or later with npm. On Windows, double-click **Open VibeCheck.cmd**. On other platforms, run the following from the repository root.

```sh
python3 vibecheck.py
```

The Windows launcher also accepts the Python launcher's arguments. For example, `& '.\Open VibeCheck.cmd' --port 8766` opens a different port from PowerShell. Use `--state-dir` for an independent desk on the same checkout.

The first run downloads the public VibeCheck repository into the application's local state directory and checks out commit `6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24`. The desk opens at [localhost:8765](http://127.0.0.1:8765/). Keep the process running while using it. A different port can be set with `--port 8766`.

1. Open **VibeCheck case file** to see the original and corrected concert dates. The example uses a fixture event on May 16 and the America/Chicago time zone.
2. Open the prepared calendar patch on the factory floor. Run its checks and inspect the diff. **Save review branch** creates a real Git commit on a new local branch. Your current branch and its working files stay in place.
3. Try the independent Vite build repair in the case file. Its verification installs VibeCheck's frontend dependencies in a temporary checkout and runs the product's production build. The date repair uses a focused six-case probe.
4. In **Live lab**, type an unfinished note, release version 2, then rehearse a failed edit. The host checks the queue and reports recovery. The lab tab runs the upstream task layers. VibeCheck uses the normal Git review path.

## Open your own product

Use a local checkout with at least one commit. Examples below show PowerShell.

```powershell
python server.py --repo "C:\projects\my-product"
```

Open the printed address and choose **Scan only**. The scanner reads committed source at HEAD. Its built-in rules identify a small set of setup and documentation issues, and surface maintainer notes. **Add your patch** accepts a unified Git diff. **Watch for new commits** checks the checkout for changes while the tab is open. The experiment history keeps the last 40 checks, saved branches and cleared drafts for that checkout.

To include your project's own checks, pass a trusted command as the last option. It runs from a fresh temporary checkout with the patch applied. Use a command that can prepare its dependencies there. For example, a Python repository with standard-library tests can use:

```powershell
python server.py --repo "C:\projects\my-product" --check python -m unittest discover -s tests
```

The desk reports exactly what ran. Without a project check, it validates patch application, whitespace and supported file types. It keeps the receipt tied to the base commit and exact diff. Restarting the server requires running verification again before saving an uncommitted proposal. Temporary checkouts isolate Git changes. Project commands execute with your OS account's permissions, so select commands and repositories you trust.

## Ask for an AI proposal

Install and sign in to the Codex CLI and make `codex` available on your PATH. Use **Propose an idea** on an empty desk. Describe the product behavior to change and optionally attach up to four tracked files, one path per line. The model can read a clean checkout. The change comes back as a draft. On the command line, repeat `--file` for each attachment.

```powershell
python propose.py --idea "Add a Clear search button when no shows match" --file Music_Show_Helper/Frontend/src/pages/EventsPage.tsx
```

A model run can return no supported change. Automatic scan rules, manual patch review, the VibeCheck examples and the LLP lab work independently of model access.

## Publish a reviewed change

Saving a branch is local. To preview a GitHub draft PR, use the command shown after saving a review branch. Add `--publish` to push that branch and open the draft PR using authenticated Git and GitHub CLI access to the repository.

If the desk stops during **Save review branch**, reopen it with the same checkout and state directory. Before creating the Git ref, the desk records the intended branch name, commit, base, and patch digest. If that branch already points to the intended commit, the desk recovers it and records one saved review. If the ref is missing or someone has moved it, the draft stays open. Run checks again before saving. A changed checkout HEAD requires a new draft against the current commit.

```powershell
python publish_review.py --repo "C:\projects\my-product" --branch "morph/your-review-branch"
```

To include the before-and-after results, run **Compare results** on the patch and download its experiment receipt from **Release details**. Pass that file alongside the saved branch to preview the exact Markdown evidence section.

```powershell
python publish_review.py --repo "C:\projects\my-product" --branch "morph/your-review-branch" --receipt "C:\receipts\morph-release-2.json"
```

The publisher verifies the release and passing server rehearsal signatures with the public key in the receipt. It checks that the comparison’s base commit and candidate tree match the local review commit’s parent and tree. The PR identifies the signed manifest by SHA-256 and labels the two statuses and six case counts as local observations. A receipt from another patch, missing comparison, or invalid signature stops publication before any push.

Add `--publish` to the same command after checking the preview. A retry reuses a matching remote branch or PR. If an existing PR for that commit has different evidence, the command points you to the existing body for review.

The helper supports github.com origins. Running with `--publish` pushes the local review branch and opens the draft. The [factory’s own example PR](https://github.com/marioG1025/morph-factory/pull/1) was created from the verified tree using this helper. Retrying with the same commit and evidence returned the existing PR.

## Implementation and evidence

The server uses Python's standard library. One server instance owns each checkout's local draft. Set `--state-dir` to choose a different location. The default uses LocalAppData on Windows and XDG state on Unix. Use localhost to access this desk.

The [Change review integration](../runtime/README.md) uses a durable publisher for each local checkout. The separate browser lab bundles the [LLP reference host and precompiled task examples](https://github.com/nik190799/live-layer-protocol/tree/7598909b2ae521ba9eb8ee12c825bcea912adede), released under the [Apache 2.0 license](../ui/lab/LICENSE.txt). The additional version 2 fault rehearsal derives from the upstream version 2 layer. A new publisher key is generated for each lab session.

VibeCheck case evidence comes from [the tested VibeCheck revision](https://github.com/marioG1025/VibeCheck/tree/6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24). The original calendar probe failed four of six cases. The patch passed all six, including both timestamp controls. The original frontend production build failed with TS2339. Applying the separate type declaration patch allowed the build to complete. The browser checks exercised list and detail navigation with a fixture API. Live SILO and Spotify services were outside these checks.
