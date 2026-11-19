# Change review in Firefox and WebKit

**Firefox 153.0 and WebKit 26.5 both received one VibeCheck comparison in two open tabs on Ubuntu.** Each engine passed the same acceptance scenario with zero skips using Playwright 1.62.1 and factory revision `0865fa9b755a4891a2adf4c1bbc2e416f4c93a9c`. [GitHub Actions run](https://github.com/marioG1025/morph-factory/actions/runs/44460895248)

| Engine | Playwright browser build | Runner | Scenario duration | Evidence |
| --- | ---: | --- | ---: | --- |
| Firefox 153.0 | 1538 | Ubuntu 24.04.5 x64, Linux 7.0.0-1017-azure | 5.65 s | [Firefox job](https://github.com/marioG1025/morph-factory/actions/runs/44460895248/job/135347131377) |
| WebKit 26.5 | 2336 | Ubuntu 24.04.5 x64, Linux 7.0.0-1017-azure | 8.91 s | [WebKit job](https://github.com/marioG1025/morph-factory/actions/runs/44460895248/job/135347130998) |

Both clients rejected altered rehearsal evidence, then accepted the genuine signed release. The original browser document, selected output pane, diff focus, text selection, scroll and expanded details survived the live update. In each engine, the operator initiated one comparison. The peer received the four-field LLP `shared` marker and fetched the matching report once. Both tabs showed four fixed date cases and two unchanged controls under the same run ID. Restoring the previous review removed Compare in both tabs. Verifying, saving and clearing left a real local review branch and a clean product checkout. [Acceptance assertions](../../tests/browser/review-acceptance.mjs)

The assertions passed on both engines without engine-specific behavior changes. The durations cover the full scenario and exclude browser installation. Each engine ran on a separate hosted worker. This WebKit observation covers Playwright’s headless Linux build. Testing the Safari application and its integration with macOS or iOS would require Apple devices.

Run the optional matrix from **Actions → Cross-browser Change review → Run workflow**, or follow the [local engine instructions](../../tests/browser/README.md). The same test also runs in the default Chromium suite.

## Earlier runs

Before shared result delivery, revision `c567ed8b160fcd755c07ce2c2955522136dfaf68` passed live layer approval, comparison, restore and save in both Firefox (7.32 seconds) and WebKit (8.65 seconds). [Initial matrix](https://github.com/marioG1025/morph-factory/actions/runs/44456752546)

Revision `db6f64a9bdfa384a599ab4445b3417a4b560cc91` added assertions for delivery of the actual LLP shared frame, one passive HTTP read and matching results in both open tabs after a single operator comparison. Firefox 153.0 on Ubuntu 24.04.5 x64 passed in 8.67 seconds with zero skips. [Firefox job](https://github.com/marioG1025/morph-factory/actions/runs/44459078947/job/135341192353)

The WebKit worker fetched 126 MB of Ubuntu libraries in 13 minutes 58 seconds. GitHub canceled installation at the 15-minute job limit immediately after the browser download. The acceptance step was skipped. The optional matrix now allows 30 minutes for the whole job and three minutes for the acceptance step itself. [WebKit installation log](https://github.com/marioG1025/morph-factory/actions/runs/44459078947/job/135341192752)
