import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL(".", import.meta.url));
const compiler = fileURLToPath(new URL("./node_modules/assemblyscript/bin/asc.js", import.meta.url));
for (const revision of ["v1", "v2"]) {
  const layers = [
    [revision + ".ts", "../../ui/layers/review-" + revision + ".wasm"],
    ["../../runtime/layers/service-" + revision + ".ts", "../../runtime/layers/service-" + revision + ".wasm"],
  ];
  for (const [source, target] of layers) {
    const build = spawnSync(process.execPath, [compiler, source, "-o", target, "-O3"], {cwd, stdio: "inherit"});
    if (build.error) throw build.error;
    if (build.status !== 0) process.exit(build.status ?? 1);
  }
}
