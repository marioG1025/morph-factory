# Third-party work

## Live Layer Protocol

**Author:** Nikhil Ajay Kadalge. **License:** Apache License 2.0. **Reference revision:** [d14ebf9](https://github.com/nik190799/live-layer-protocol/tree/d14ebf9f8d17a45a3619231d4a9c63c00845bf96).

The browser lab contains the reference JavaScript host in `ui/lab/llp-core.js` and the precompiled task layers `tasks.wasm`, `tasks_v2.wasm`, and `tasks_trap.wasm`. The additional `rehearsal_v2.ts` and compiled module derive from the upstream v2 task layer and add a controlled test failure for rehearsal. The local publisher signs with a new key each lab session. The [upstream license](ui/lab/LICENSE.txt) accompanies these files.

Read the [protocol specification](https://github.com/nik190799/live-layer-protocol/blob/d14ebf9f8d17a45a3619231d4a9c63c00845bf96/SPEC.md), [server and client notes](https://github.com/nik190799/live-layer-protocol/blob/d14ebf9f8d17a45a3619231d4a9c63c00845bf96/docs/HOSTS.md), and [the author's paper](https://doi.org/10.5281/zenodo.24349382).

## VibeCheck

[VibeCheck](https://github.com/marioG1025/VibeCheck/tree/6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24) is the target product in the reproducible case file. The launcher clones it separately. The example patches include the relevant surrounding source as Git diff context. The browser images show a test event served through a fixture API.
