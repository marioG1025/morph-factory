# The factory reviewed its own eight-tab startup failure

Two tabs opened at once on Windows sometimes stayed on “Connecting live layer”. The browser reported refused requests for the factory’s own scripts and styles. The Python 3.11 listener accepted only five queued connections by default. The candidate increased that queue to 128. [Tested patch](https://github.com/marioG1025/morph-factory/commit/a95ec7a3fa44edd6d0fcba9a9b121c32bda440b9)

We submitted the change to the factory as a product patch. Its project check opened eight separate browser contexts simultaneously against a fresh instance of the **factory revision under review**. Inside that instance, each tab opened the real VibeCheck calendar draft. The same external check ran on the original and patched Git trees. [Executable check](../../scripts/packaging/check-cold-tabs.mjs)

| What the browser observed | Original factory | With the patch |
| --- | ---: | ---: |
| Pinned VibeCheck draft available | Yes | Yes |
| Tabs showing the live review | 0 of 8 | 8 of 8 |
| Tabs acknowledging the signed layer | 0 of 8 | 8 of 8 |
| Failed requests and browser errors | 44 | 0 |

The last patched tab was ready after 3.214 seconds on this Windows Edge 157 run. On the outer review desk, **Check current commit** found the named startup failures. **Rehearse → Approve Compare results** updated two already-open documents. Running Compare in one delivered the result to both. The operator downloaded the receipt, reran checks and saved a local review branch. Its tree matched the original fix commit, `4bb98aae91dcf3495814a7cee3a743da96baf609`. The checkout stayed clean.

The exported receipt identifies the baseline, patch hash, tested candidate tree, two fixed cases and one unchanged control. It includes signatures for the live release and its server rehearsal. The browser observations come from the local project check. [Downloaded receipt](receipts/factory-cold-start.json) · [Baseline source](https://github.com/marioG1025/morph-factory/tree/dec5fb74a8046f8326829fe0a479c7b2a63c576a)

## Repeat the check

Install the [browser test dependencies](../../tests/browser/README.md) in your factory checkout. Run the following command from the root of the factory revision you want to measure, pointing Node at the external copy of the check.

```sh
node /path/to/morph-factory/scripts/packaging/check-cold-tabs.mjs
```

The script prints named outcomes and per-tab times. As a trusted project command, it also supplies the cases that Compare displays. Timing and the exact number of refused requests depend on the operating system and load. The regression test separately exercises a pending burst of 12 legitimate local connections. [Listener regression](../../tests/test_http_assets.py)
