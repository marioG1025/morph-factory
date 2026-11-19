# Change review in Firefox and WebKit

**Firefox 153.0 and WebKit 26.5 both passed the same two-tab VibeCheck workflow on Ubuntu.** Each job used the same factory revision, signed browser/server Wasm, product checkout and acceptance assertions. Each ran one test with zero skips. [GitHub Actions run](https://github.com/marioG1025/morph-factory/actions/runs/44456752546)

| Engine | Playwright browser build | Runner | Scenario duration | Evidence |
| --- | ---: | --- | ---: | --- |
| Firefox 153.0 | 1538 | Ubuntu 24.04.5 x64, Linux 7.0.0-1014-aws | 7.32 s | [Firefox job](https://github.com/marioG1025/morph-factory/actions/runs/44456752546/job/135333526627) |
| WebKit 26.5 | 2336 | Ubuntu 24.04.5 x64, Linux 7.0.0-1017-azure | 8.65 s | [WebKit job](https://github.com/marioG1025/morph-factory/actions/runs/44456752546/job/135333526256) |

Both clients rejected altered rehearsal evidence, then accepted the genuine signed release. The original browser document, selected output pane, diff focus, text selection, scroll and expanded details survived the live update. Both engines ran the comparison and showed four fixed date cases and two unchanged controls. Restoring the previous review removed Compare in both tabs. Verifying, saving and clearing left a real local review branch and a clean product checkout.

The assertions passed on both engines without engine-specific behavior changes. The durations cover the full scenario and exclude browser installation. Each engine ran on a separate hosted worker. This WebKit observation covers Playwright’s headless Linux build. Testing the Safari application and its integration with macOS or iOS would require Apple devices.

The run used Playwright 1.62.1 at factory revision `c567ed8b160fcd755c07ce2c2955522136dfaf68` on November 19, 2026 UTC. Run the optional matrix from **Actions → Cross-browser Change review → Run workflow**, or follow the [local engine instructions](../../tests/browser/README.md). The [shared test](../../tests/browser/review-acceptance.mjs) also runs in the default Chromium suite.
