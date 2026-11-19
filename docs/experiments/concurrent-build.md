# A release arrived during a real VibeCheck production build

We started **Run checks** on the Vite type-declaration repair and approved **Compare results** from a second open tab while the first was still building. Both tabs gained the control in the same browser documents. The review server continued verifying the original patch and the observer stayed on **Diff**.

| Observation in one local run | Result |
| --- | --- |
| Time from the verification click until both tabs displayed Compare | 213 ms |
| Time from the same click until the candidate build returned | 10.822 s |
| Paired production build after approval | Original failed with TS2339. The candidate passed |
| Verified tree and independently compared candidate tree | Both `f90fcb602e5f095c39b3975100ef772bf861bda9` |

The run used two headless Edge tabs and the real TypeScript and Vite commands on the pinned VibeCheck checkout. These timings include browser and local scheduling and come from one workstation. For repeated click-to-control samples across tab counts, see the [adoption experiment](adoption.md).

## Two Windows fixes the run exposed

1. A Windows npm launcher can use the Node installation beside its own `npm.cmd`, even when the project commands resolve a different Node architecture from PATH. That combination installed the 32-bit Rollup dependency and then attempted to load a 64-bit one. The VibeCheck runner now uses the PATH-selected interpreter for npm’s CLI and the build.
2. The build itself succeeded, then the verification wrapper failed printing Vite’s check mark through a Windows text pipe. Both comparison and verification now use UTF-8 for Python command output. A regression test exercises a Unicode diagnostic.

## Reproduce

Prepare the [browser test dependencies](../../tests/browser/README.md) and install Node 22+ with npm. From the repository root, run the following. The check creates a temporary VibeCheck desk and performs three frontend installations and builds. A first run needs internet for packages.

```sh
node scripts/build-during-release.mjs
```

The script asserts that the controls arrived *before* the running build completed, that the two candidate trees agree, and that both browser documents survived. It prints its own timings and case counts. [Executable experiment](../../scripts/build-during-release.mjs)
