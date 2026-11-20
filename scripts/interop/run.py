"""Compare the factory's JavaScript client with the pinned upstream Go client."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT))
from live_release import ensure_dependencies, node_binary

UPSTREAM = "https://github.com/nik190799/live-layer-protocol.git"
REVISION = json.loads((ROOT / "docs/upstream/inventory.json").read_text(encoding="utf-8"))["commit"]


def export_upstream(tmp, checkout):
    if checkout is None:
        checkout = tmp / "upstream-git"
        subprocess.run(["git", "init", "-q", str(checkout)], check=True)
        subprocess.run(["git", "-C", str(checkout), "fetch", "-q", "--no-tags", "--depth=1",
                        UPSTREAM, REVISION], check=True)
    # An archive reads the exact commit even if the user's checkout has local edits.
    archive = tmp / "upstream.zip"
    subprocess.run(["git", "-C", str(checkout), "archive", "--format=zip", "-o", str(archive),
                    REVISION, "impl/go"], check=True)
    with zipfile.ZipFile(archive) as zipped:
        zipped.extractall(tmp)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", type=Path, help="A local LLP checkout containing the pinned commit")
    parser.add_argument("--go", default=shutil.which("go"), help="Go 1.24+ executable")
    opts = parser.parse_args()
    if not opts.go:
        parser.exit(1, "This optional experiment needs Go 1.24+. Install it or pass --go PATH.\n")
    node = node_binary()
    ensure_dependencies()
    go = str(Path(shutil.which(opts.go) or opts.go).resolve(strict=True))
    with tempfile.TemporaryDirectory(prefix="morph-go-interop-") as scratch:
        tmp = Path(scratch)
        export_upstream(tmp, opts.upstream)
        probe = tmp / "probe"
        probe.mkdir()
        shutil.copyfile(HERE / "replay.go", probe / "main.go")
        shutil.copyfile(tmp / "impl/go/go.sum", probe / "go.sum")
        (probe / "go.mod").write_text(
            "module morph.example/review-interop\n\ngo 1.24\n\n"
            "require github.com/nik190799/live-layer-protocol/impl/go v0.0.0\n"
            "require github.com/tetratelabs/wazero v1.9.0 // indirect\n\n"
            "replace github.com/nik190799/live-layer-protocol/impl/go => ../impl/go\n", encoding="utf-8")
        print(f"Upstream {REVISION}", flush=True)
        subprocess.run([go, "version"], check=True)
        subprocess.run([node, str(HERE / "export-review.mjs"), str(tmp)], cwd=ROOT, check=True)
        # Only the public dependency cache is shared. --readonly uses upstream's
        # checksum for wazero. LLP source comes exclusively from the pinned archive.
        env = {**os.environ, "GOWORK": "off", "GOTOOLCHAIN": "local"}
        subprocess.run([go, "run", "-mod=readonly", ".", str(tmp / "fixture.json")],
                       cwd=probe, env=env, check=True)
        releases = json.loads((tmp / "fixture.json").read_text(encoding="utf-8"))["releases"]
        unique_hashes = dict.fromkeys(r["manifest"]["layers"]["review"] for r in releases)
        print("Client layer SHA-256: " + ", ".join(unique_hashes))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        sys.exit(str(exc))
