# Two open reviews survive a full desk restart

Two Edge tabs stayed open while the factory’s Python server and Node LLP sidecar exited. After the desk restarted on the same port, the operator ran a new VibeCheck comparison. The peer displayed the same four fixes and two unchanged controls, with its original diff selection, focus and scroll position intact.

## Before and after

Both runs used the same browser experiment, product commit and signed Compare release. The first ran against a separate checkout of factory revision `070880c2a83ef76f5d5b4f734559e31ed3fafcc6`. The second used the implementation that saves the draft generation alongside the draft. [Persistence fix](https://github.com/marioG1025/morph-factory/commit/53cb9fa09b0ea285a955c52093625371dfc519d8)

| Observation | Original factory | With persisted draft generation |
| --- | --- | --- |
| Native draft generation before and after restart | 1 → 0 | 1 → 1 |
| Original operator and peer documents retained | Both | Both |
| Peer receives the prior run in the full LLP snapshot | Yes | Yes |
| Extra report reads for that prior run | 0 | 0 |
| Peer receives a new run in the next LLP delta | Yes | Yes |
| Peer reads the new report | Once | Once |
| Peer displays the new run | No | Yes |
| Comparison POSTs by operator / peer | 2 / 0 | 2 / 0 |

The operator measured once before stopping the desk and once after restarting it. In the original factory, LLP delivered both notifications correctly. The peer accepted the HTTP response only when the native draft generation still matched the generation it had opened. Reloading the desk reset that number to zero, so the peer continued showing the first run. Persisting the generation made the existing check accept the new report across restart while continuing to identify replacement drafts.

The successful Windows run used Edge 157.0.4341.60, signed release 2 and VibeCheck commit `6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24`. Both browser documents retained their time origin. The operator retained **Check output** and the peer retained **Diff**. Git reported a clean working tree after both measurements. [Experiment script](../../scripts/restart-desk.mjs)

## Hosted browser results

Firefox 153.0 and Playwright WebKit 26.5 each passed the same restart on Ubuntu 24.04.5 x64, Linux `7.0.0-1014-aws`, at factory revision `790fc47cfa4da5a4876dee8fda393f253948066d`. Each job first ran the ordinary approve, compare, restore and save scenario, then started a fresh two-tab desk for the process restart. [GitHub Actions run](https://github.com/marioG1025/morph-factory/actions/runs/44463017642)

| Engine | Both documents and peer selection retained | Peer reads for prior / new report | Peer comparison POSTs | Evidence |
| --- | --- | --- | ---: | --- |
| Firefox 153.0 | Yes | 0 / 1 | 0 | [Firefox job](https://github.com/marioG1025/morph-factory/actions/runs/44463017642/job/135354085087) |
| Playwright WebKit 26.5 | Yes | 0 / 1 | 0 | [WebKit job](https://github.com/marioG1025/morph-factory/actions/runs/44463017642/job/135354084637) |

Both logs record exit of the original Python and Node processes, generation `1` before and after restart, the prior run in the full snapshot and the new run in the delta. Each peer rendered four fixed cases and two unchanged controls. Both product checkouts ended clean.

## Reproduce

Set up the [browser dependencies](../../tests/browser/README.md), then run this command from the factory root.

```sh
node scripts/restart-desk.mjs
```

The script creates and removes a temporary desk state directory and product checkout. Set `MORPH_VIBECHECK_REPO` to an existing local VibeCheck checkout to seed the temporary clone. Otherwise the factory fetches its pinned product example. The original server binds a free loopback port, and the replacement opens that same port using the same saved state.

The script checks that both original process IDs exited before it starts the new server. It observes the peer’s actual WebSocket frames, counts native report reads and comparison requests, and verifies all four marker fields against the product commit, patch digest, release and run. Its JSON output contains the counters, browser version and observed generation change.
