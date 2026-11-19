"""Verify the LLP source inventory, optionally against Git objects in an upstream clone."""
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
inventory = json.loads((ROOT / "docs/upstream/inventory.json").read_text(encoding="utf-8"))


def canonical(data, binary):
    return data if binary else data.replace(b"\r\n", b"\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", type=Path, help="Local nik190799/live-layer-protocol Git checkout")
    args = parser.parse_args()
    for entry in inventory["files"]:
        path = entry["local"]
        binary = path.endswith(".wasm")
        actual = canonical((ROOT / path).read_bytes(), binary)
        if hashlib.sha256(actual).hexdigest() != entry["sha256"]:
            sys.exit(f"Vendored contents changed: {path}. Review the source and update its inventory.")
        if args.checkout:
            blob = inventory["commit"] + ":" + entry["source"]
            original = canonical(subprocess.check_output(["git", "-C", str(args.checkout),
                                                          "show", blob]), binary)
            if "patch" in entry:
                changes = "".join(difflib.unified_diff(
                    original.decode().splitlines(True), actual.decode().splitlines(True),
                    fromfile=entry["source"], tofile=path))
                if changes != (ROOT / entry["patch"]).read_text(encoding="utf-8"):
                    sys.exit("Local changes differ from the documented patch: " + path)
            elif actual != original:
                sys.exit("Unrecorded change from upstream: " + path)
    print(f"Verified {len(inventory['files'])} pinned LLP assets at {inventory['commit']}.")


if __name__ == "__main__":
    main()
