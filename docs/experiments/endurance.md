# Endurance on an open VibeCheck review

**Two Windows browser runs recorded 41 and 31 completed review cycles.** In every cycle the operator approved Compare, measured the original and patched VibeCheck checkouts, and restored the baseline. Both browser documents and the draft survived each cycle. Each comparison reported four fixed date cases and zero regressions. An independent Ubuntu run completed 61 cycles before its next rehearsal timed out. [Machine-readable measurements](results/endurance.json) · [Hosted job log](https://github.com/marioG1025/morph-factory/actions/runs/44469007641/job/135373647683)

## How long activity was observed

The local runs overlapped on one Windows workstation. The timestamps below are UTC on November 19, 2026. Each observation span includes the planned waits between samples. Around ten hours separate the last observations and the final records. The logs provide no evidence of repeated activity in that gap, so these runs do not establish four uninterrupted hours of operation.

| Local run | Start | Last observed | Span to observation | Final record | Gap to final record |
| --- | --- | --- | ---: | --- | ---: |
| Two open VibeCheck browser tabs | 03:36:21.134 | 07:00:58.271 | 3h 24m 37s | 17:07:49.069 | 10h 6m 51s |
| Two tabs with peer result delivery | 04:33:00.570 | 07:04:14.201 | 2h 31m 14s | 17:07:49.070 | 10h 3m 35s |
| Two upstream WebSocket clients | 03:36:49.278 | 07:04:57.389 | 3h 28m 08s | 17:07:49.091 | 10h 2m 52s |
| Two clients with signed rehearsal evidence | 04:00:53.415 | 07:03:41.534 | 3h 2m 48s | 17:07:47.162 | 10h 4m 06s |

For browser runs, the start is the first completed cycle’s timestamp minus its measured duration. The end is the last completed cycle. The longest gaps between successive cycle completions were 308.327 and 311.681 seconds. The initial wire span ends at the last of 193 native samples. Those samples saw the transition counter move from 14 to 205 with a maximum sampling gap of 60.105 seconds. The signed wire span ends at its last process-memory sample. Its last explicitly timestamped protocol event was a successful host restart at 06:47:14.266 UTC. The final counters below cover the whole run and do not timestamp each transition.

## What completed

| Run | Completed observations | Recovery evidence |
| --- | --- | --- |
| Initial browser pair | 41 comparisons and restores | 13 observer network-offline toggles. This version recorded the browser setting only. |
| Shared-result browser pair | 31 matching peer results | 10 confirmed disconnects followed by full snapshots and 21 live deltas. The passive tab submitted zero comparison commands. |
| Initial WebSocket client pair | 206 transitions, 412 acknowledgements, 840 state checks | 2 host restarts, 22 brief reconnects, one real credential expiry and one idle worker wake. |
| Signed-evidence client pair | 182 transitions, 364 acknowledgements, 744 state checks, 184 verified rehearsal receipts | 2 host restarts, 20 brief reconnects, one real credential expiry and one idle worker wake. |

The first browser pair’s median completed cycle took 1,730 ms and its 95th percentile was 2,992 ms. In the signed wire run, the interval from approval returning to both client acknowledgements had a median of 24 ms and a 95th percentile of 34 ms over 182 transitions, with 20 ms polling. A separate experiment measures the operator click through to the last tab’s usable control. [Browser adoption measurements](adoption.md)

## Hosted run and separate recovery checks

The original Ubuntu job requested 65 minutes. Its first completed cycle was at 06:06:33.615 UTC and its 61st at 07:07:23.739 UTC. It recorded **20 full snapshots, 41 deltas, 61 run-specific report reads, zero extra full-state reads and zero passive comparison requests**. At 07:08:53 UTC on cycle 62, the runner timed out after 30 seconds waiting for the explicit rehearsal-success message. That cycle had not advanced to approval or product measurement. The job failed. Its log does not identify the underlying error. [Failed hosted job](https://github.com/marioG1025/morph-factory/actions/runs/44469007641/job/135373647683)

A local Chromium reproduction completed 61 approve/restore pairs, then recorded a WebAssembly memory allocation failure when the browser rehearsed release 124 from release 123. The original hosted log captured only the rehearsal timeout. After the factory began retiring replaced browser workers, the same local sequence rehearsed release 124 successfully. The operator measured four fixes and two unchanged controls. Both tabs kept one connection and recorded zero browser errors. [Worker-lifetime experiment](worker-lifetime.md) · [Two-tab regression](../../tests/browser/release-turnover.mjs)

A separate rapid Windows probe with a 60-second token lifetime completed 8 cycles, then timed out waiting for a comparison response. It exercised a different failure stage. A short wire run on revision `4b9773c` completed 5 transitions and 10 acknowledgements in 7m 30s.

A dedicated suspended-tab test held the reviewer offline for 61 real minutes. The existing document obtained one new session, received a full snapshot and displayed the operator’s saved run. The original credential had been expired for 60 seconds. This trace recorded no rejected handshake with that old token. The operator performed one comparison and the passive reviewer performed zero. [Suspended reviewer experiment](shared-comparison.md#observations)

## Subsequent hosted attempts

Each timed Ubuntu attempt used a new disposable desk. The counts show only cycles that finished all assertions.

| Timed run | Revision | Job result | Completed cycles | Full snapshots / deltas | Report reads / extra full-state reads / peer comparison requests |
| --- | --- | --- | ---: | --- | --- |
| [5-minute job](https://github.com/marioG1025/morph-factory/actions/runs/44781206863/job/136444049125) | `3444912` | success | 5 | 1 / 4 | 5 / 0 / 0 |

## Windows process sampling

The sampler recorded private memory for the test-owned process trees between 04:08:24.589 and 07:03:41.534 UTC, approximately every five minutes. Other work shared the machine. These samples describe the observed process groups during that window.

| Process tree | Samples | First MiB | Min–max MiB | Last MiB |
| --- | ---: | ---: | ---: | ---: |
| Browser driver and its children | 36 | 555.0 | 554.5–592.9 | 575.0 |
| Initial wire client and host | 36 | 170.3 | 170.3–221.3 | 218.7 |
| Signed-evidence client and host | 36 | 166.6 | 166.6–230.0 | 218.5 |

## Reproduce

Install the [runtime](../../runtime/README.md) and the [browser test dependencies](../../tests/browser/README.md). Run the wire and browser probes in separate terminals. Durations are in minutes. The browser harness uses a disposable product checkout. [Browser runner](../../tests/browser/soak.mjs) · [Wire runner](../../runtime/tools/soak.mjs) · [Hosted workflow](../../.github/workflows/endurance.yml)

```sh
node runtime/tools/soak.mjs 230 wire-result.json
MORPH_SOAK_MINUTES=227 node tests/browser/soak.mjs
```

In PowerShell, set `$env:MORPH_SOAK_MINUTES="227"` before running `node tests/browser/soak.mjs`.
