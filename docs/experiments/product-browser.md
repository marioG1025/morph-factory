# VibeCheck concert dates in the rendered product

**Both calendar patches passed all 48 browser assertions.** The original showed the preceding day on the list and detail pages for three date-only events in Los Angeles and Honolulu. The factory’s prepared patch and the recorded agent proposal each fixed those 12 observations and preserved the other 36. [Prepared patch](../../ui/lab/calendar-day.patch) · [Agent patch](patches/vibecheck-agent-calendar.patch)

## What the operator compared

The factory ran a signed Change review release against VibeCheck commit `6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24`. Each call to `Desk.compare` created two disposable clones, checked out the original, applied the selected patch to the candidate, and invoked the same configured project check on both. The two independent original runs returned identical named case results. [Experiment runner](../../scripts/compare-product-browser.py)

| Candidate | Candidate Git tree | Original passed | Candidate passed | Fixed / regressed | Original / candidate check | Complete comparison |
| --- | --- | ---: | ---: | --- | --- | ---: |
| Prepared repair | `7bb71ffcea84f90271e5120e1b71003a64d7d214` | 36/48 | 48/48 | 12 / 0 | 12.52 s / 11.69 s | 26.84 s |
| Recorded independent agent repair | `1d96993724aa5201ee2f505b3688eb74335c2d1a` | 36/48 | 48/48 | 12 / 0 | 11.08 s / 11.77 s | 25.66 s |

Each side started VibeCheck’s own Vite server and launched headless Edge 157.0.4341.60 on Windows. Each zone got a fresh browser context with an English-US locale. The browser visited the real React list, clicked each event card, checked the event heading and date on its detail route, and returned using the product’s **Back to Shows** control. The fixture API served the six events and empty artist lists. These runs cover the rendered product with controlled event data. Live event ingestion, Spotify, and other locales were outside this check. The measured Vite version was 5.4.21. Timings include dependency installation into each disposable clone using an existing npm download cache. [Product browser check](../../examples/vibecheck/browser-dates.mjs)

## Expected local days

Every cell is a hand-written expectation. Each assertion checks the actual date text, including weekday, against the short list label or the long detail label displayed by VibeCheck.

| Event value | Los Angeles | Honolulu | Tokyo | UTC |
| --- | --- | --- | --- | --- |
| `2028-02-29` | Feb 29 | Feb 29 | Feb 29 | Feb 29 |
| `2027-03-14` | Mar 14 | Mar 14 | Mar 14 | Mar 14 |
| `2027-11-07` | Nov 7 | Nov 7 | Nov 7 | Nov 7 |
| `2028-03-01T00:15:00+09:00` | Feb 29 | Feb 29 | Mar 1 | Feb 29 |
| `2027-03-14T23:45:00-07:00` | Mar 14 | Mar 14 | Mar 15 | Mar 15 |
| `2027-11-07T00:30:00-08:00` | Nov 7 | Nov 6 | Nov 7 | Nov 7 |

On the original Los Angeles list, the leap-day fixture rendered **Mon, Feb 28, 2028**. Both candidates rendered **Tue, Feb 29, 2028**. The last instant rendered **Saturday, November 6, 2027** on the Honolulu detail route for all three revisions. All 24 offset-timestamp observations passed on every revision.

These retrospective cases were written after both patches existed. Their inputs differ from the six extracted formatter assertions used in the earlier proposal experiment and were absent from the agent request. The recorded proposal was reused for this experiment. [Original probe](../../examples/vibecheck/check-dates.cjs) · [Proposal history](agent-proposal.md)

## Reproduce

Use Python 3.11+, Git, Node 22+, npm, and the [browser dependencies](../../tests/browser/README.md). Run the comparison from the factory root.

```sh
python scripts/compare-product-browser.py
```

Supply `--repo /path/to/VibeCheck` to seed the disposable checkout from a local clone. The default fetches the pinned public product. The runner writes one JSON object per patch to stdout with its base, patch digest, candidate tree, release version, elapsed times, summary and all named results. Each case carries its zone, input, route, observed label and expected label.

For a separate factory desk on the pinned product, configure the trusted project check as `python /absolute/path/to/morph-factory/examples/vibecheck/check.py --browser-dates`. Compare results then displays the named `MORPH_CASE_REPORT` observations. The ordinary VibeCheck example continues to use the six quick formatter checks for calendar proposals.
