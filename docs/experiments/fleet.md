# Canary delivery of Change review

Can a second factory desk keep reviewing a draft while the first tries Compare results? We ran the factory’s real browser/server Wasm pair through Nikhil’s fleet controller. Three Node client hosts ran the browser layer. One observed the `preview` channel, and two subscribed to `stable`. A relay ran the server layer separately on each channel. Every connection used a loopback WebSocket.

**The canary received a working Compare action while the other stable desk kept the baseline review and its matching server behavior.** When the relay received the canary’s acknowledgement, the experiment widened the release to the second stable desk. All three hosts kept their selected Check output pane through their respective updates.

## Reproduce

With Python 3.11+, Git and Node 22+ installed, run this command from the factory root.

```sh
python scripts/fleet/run.py
```

The runner fetches the [exact upstream revision](https://github.com/nik190799/live-layer-protocol/tree/7598909b2ae521ba9eb8ee12c825bcea912adede). To use an existing LLP clone, pass `--upstream /path/to/live-layer-protocol`. It reads the committed files, uses the factory’s locked WebSocket dependency, generates temporary keys and opens ephemeral loopback ports. Each line of output records one observation.

## What the hosts reported

The recorded run used [LLP d14ebf9](https://github.com/nik190799/live-layer-protocol/tree/d14ebf9f8d17a45a3619231d4a9c63c00845bf96). The controller starts at version 100 in this experiment. Its sequence advances across both channels.

| Stage | Preview observer | Stable canary | Other stable desk | Observation |
| --- | --- | --- | --- | --- |
| Open draft | Review 102 | Review 101 | Review 101 | All three selected Check output. |
| Preview | Compare 103 | Review 101 | Review 101 | The preview client’s Wasm event received permission from its own server lane. |
| Stable at 50%, canary ACK held | Compare 103 | Compare 104 | Review 101 | The fleet marked its stable relay complete. The relay still recorded two clients at 101 and one skip. The experiment held promotion. |
| Canary ACK delivered | Compare 103 | Compare 104 | Review 101 | The relay recorded one client at 104 and one skip. The canary’s remote operation worked. The other desk’s baseline service refused Compare. |
| Stable at 100% | Compare 103 | Compare 104 | Compare 104 | The relay recorded two clients at 104. The newly included desk could invoke Compare. |
| Restore stable | Compare 103 | Review 105 | Review 105 | Both stable clients lost the action and the original service refused comparison. Preview continued serving the Compare release. |

The script uses the actual factory manifests as inputs. The fleet signs a fresh envelope to include its channel, keyring epoch, version and rollout share. Placement, key prefixes, capability grants, slot order and module content addresses come from the factory release. The measured Compare client hash was `360131def246491798623dc6e773ff9c80bf625d55822b7bd75c67a0be6c8ed3`. Its service hash was `519e9701489a2fc64035f6422165580b16fe9ffa5ba8803b7e314792b7bde3bc`.

## Findings for an operator

1. **Server readiness and desk adoption arrive separately.** `FleetController.convergence("stable")` counts the relay as one host on that channel. `ServerHost.clientStatus(app)` has the separate downstream version and skip counts. For this known two-client group, our promotion requires the registered relay to converge, both stable clients to be present, one to acknowledge version 104 and one to report a skip. We withheld the actual ACK frame while the canary was live to exercise this distinction. [Upstream channel relay and client status](https://github.com/nik190799/live-layer-protocol/blob/d14ebf9f8d17a45a3619231d4a9c63c00845bf96/host/server-host.mjs)
2. **The paired release needs its complete manifest.** The pinned controller’s `rollout()` helper passes `layers`, `order` and the first percentage into `publish()`. It has no parameter for the factory’s signed placement and capability fields. The experiment uses the upstream `publish(channel, layers, {fields, order, percent})`, evaluates the downstream gate, then calls `setPercent(channel, 100)`. Widening re-signs the same version. [Upstream fleet controller](https://github.com/nik190799/live-layer-protocol/blob/d14ebf9f8d17a45a3619231d4a9c63c00845bf96/tools/fleet.mjs)
3. **Widening produced a misleading NACK.** The already-upgraded canary received the newly signed 100% manifest for the version it was running. The pinned remote client tried to apply it and reported `stale version 104 ≤ 104`. Its running hash, selected pane and successful remote call still matched 104. The runner prints the raw NACK alongside both clients’ version counts. A general promotion policy would need to distinguish this same-version reshare from a genuine refusal to install new bytes. [Upstream client adapter](https://github.com/nik190799/live-layer-protocol/blob/d14ebf9f8d17a45a3619231d4a9c63c00845bf96/host/remote-client.mjs)

This run measures release delivery, Wasm-rendered action availability, remote service permission and pane continuity on a fixed three-client roster. The clients use draft metadata and an observation callback for the final comparison capability. Real Git checkouts, browser DOM rendering and VibeCheck checks run in the separate [browser integration suite](../../tests/browser/README.md). The [fleet experiment source](../../scripts/fleet/rollout.mjs) can run independently of an open factory workspace.
