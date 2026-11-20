"""Run a canary release of the factory Wasm using the pinned LLP fleet controller."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT))
from live_release import ensure_dependencies, node_binary

PIN = json.loads((ROOT / "docs/upstream/inventory.json").read_text(encoding="utf-8"))["commit"]
UPSTREAM = "https://github.com/nik190799/live-layer-protocol.git"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", type=Path, help="Local LLP Git checkout containing the pinned revision")
    args = parser.parse_args()
    node = node_binary()
    ensure_dependencies()
    with tempfile.TemporaryDirectory(prefix="morph-fleet-") as directory:
        tmp = Path(directory)
        checkout = args.upstream or tmp / "source"
        if not args.upstream:
            subprocess.run(["git", "init", "-q", str(checkout)], check=True)
            subprocess.run(["git", "-C", str(checkout), "fetch", "-q", "--no-tags",
                            "--depth=1", UPSTREAM, PIN], check=True)
        # Read committed source even when the supplied upstream checkout has local edits.
        for name in ("tools/fleet.mjs", "host/fleet.js", "host/llp-core.js", "package.json"):
            dest = tmp / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(subprocess.check_output(["git", "-C", str(checkout), "show", f"{PIN}:{name}"]))
        shutil.copytree(ROOT / "runtime/node_modules/ws", tmp / "node_modules/ws")
        print(f"Upstream LLP {PIN}", flush=True)
        subprocess.run([node, str(HERE / "rollout.mjs"), str(tmp)], check=True)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        sys.exit(str(exc))
