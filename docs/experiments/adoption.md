# How long does live approval take?

This experiment times an operator approving Compare results on the real VibeCheck desk. Every open tab starts on the same Git patch with either Diff or Check output selected.

**With eight open tabs, the final tab gained an enabled Compare control 619 ms after the first one-click approval.** Four repeat one-click approvals took 123–137 ms. With rehearsal completed before the click, the first approval reached all eight tabs in 99 ms and repeats took 59–67 ms.

## Local results

We made 40 approvals across eight isolated groups on November 19, 2026 UTC. All 150 tab observations retained the same browser document, selected pane and patch. The checks from the last-ready tab in each of the eight groups returned four fixes and two unchanged controls. The measured groups had zero failed trials.

| Open tabs | Approval mode | First offer, ms | Four repeat offers in order, ms | Repeat median, ms |
| ---: | --- | ---: | --- | ---: |
| 1 | One click | 282 | 133, 134, 125, 124 | 129 |
| 1 | Rehearsed | 78 | 55, 49, 50, 50 | 50 |
| 2 | One click | 152 | 133, 120, 131, 128 | 129.5 |
| 2 | Rehearsed | 91 | 58, 60, 63, 64 | 61.5 |
| 4 | One click | 330 | 140, 140, 136, 142 | 140 |
| 4 | Rehearsed | 215 | 58, 65, 64, 89 | 64.5 |
| 8 | One click | 619 | 137, 123, 126, 131 | 128.5 |
| 8 | Rehearsed | 99 | 59, 62, 59, 67 | 60.5 |

The workstation ran Windows 11 Pro build 26300 on an AMD Ryzen 5 3600 (6 cores, 12 logical processors) with 15.91 GiB of visible RAM. The browser was headless Microsoft Edge 157.0.4341.60 and Node was 24.22.1. The existing factory soak and other workstation activity continued throughout. Free physical memory at the end of each trial ranged from 2.27 to 3.04 GiB. The groups ran sequentially on loopback, with one first-offer observation per bracket. These samples characterize this machine and load.

## Measurement

The clock starts when the operator’s button receives Playwright’s trusted click. Each tab observes its own document until the signed change supplies a visible, enabled **Run comparison** button. We subtract the click time from the latest observation across the group. The timestamps come from `performance.timeOrigin + performance.now()` in the browser. Node polling, tab navigation and the subsequent project check sit outside the timed interval. A background tab qualifies when its control has a visible layout box and is enabled.

**One-click approval** includes both isolated rehearsals in the timed action. **Rehearsed approval** starts after the operator has separately rehearsed the candidate on the current draft. Each tab count and mode gets a fresh browser process and isolated factory authority. The first offer is that group’s first live installation of the candidate. Subsequent offers reuse the same browser documents after a signed restore. The OS and browser disk caches can already be warm on the first offer.

After each offer the runner checks every document’s time origin, selected pane, base commit and SHA-256 of its exact UTF-8 diff. After the final offer in each group, the last tab to become ready clicks the new control and must produce four fixed date cases and two unchanged timestamp controls on the pinned VibeCheck checkout.

## Reproduce

Install the optional [browser test dependencies](../../tests/browser/README.md). Run the shorter sample from the factory root.

```sh
node scripts/measure-adoption.mjs --tabs 1,2,4 --trials 3
```

The longer run makes twenty offers in each bracket and includes eight tabs.

```sh
node scripts/measure-adoption.mjs --tabs 1,2,4,8 --trials 20 --modes implicit,rehearsed
```

The [runner](../../scripts/measure-adoption.mjs) prints JSON lines for the machine, group, per-tab and last-tab times, comparison outcome, and any setup, continuity or runtime failure. A failed group sets a nonzero exit status. `MORPH_VIBECHECK_REPO` can point to a local clone containing the pinned commit. All drafts, approvals and restores run on temporary checkouts and authorities.

## After the worker lifetime fix

On November 20, we repeated the two- and eight-tab measurements in Windows Edge 157.0.4341.60. The first checkout used the original worker pool. The second terminated each outgoing browser worker once its replacement was ready. All 32 approvals preserved the patch, pane and document. All eight groups finished with a real VibeCheck check that reported four fixes and two unchanged controls. [Worker lifetime experiment](worker-lifetime.md)

| Open tabs | Approval | Original pool, ms | Terminate outgoing worker, ms |
| ---: | --- | --- | --- |
| 2 | One click | 501, 910, 188, 150 | 260, 469, 141, 147 |
| 2 | Rehearsed before click | 132, 188, 69, 75 | 618, 186, 64, 66 |
| 8 | One click | 509, 205, 160, 169 | 238, 189, 162, 1,713 |
| 8 | Rehearsed before click | 108, 60, 58, 60 | 110, 74, 72, 68 |

Each cell gives the first approval followed by three repeats, measured until the last tab could run Compare. Other browser tests shared the workstation. One eight-tab approval took 1.71 seconds. Four observations per group are too few to estimate a service-level percentile. Repeat with `node scripts/measure-adoption.mjs --tabs 2,8 --trials 4 --modes implicit,rehearsed`. [Original revision](https://github.com/marioG1025/morph-factory/tree/dec5fb74a8046f8326829fe0a479c7b2a63c576a) · [Worker retirement change](https://github.com/marioG1025/morph-factory/commit/34449122f94d5f4d9d97df24c546c29c9dd03850)
