"""Build a single-file offline browser replay from a captured VibeCheck review."""
import argparse
import base64
import hashlib
import json
from pathlib import Path


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def embedded(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":")).replace("<", "\\u003c")


def build(output):
    recording = json.loads((ROOT / "docs/experiments/receipts/vibecheck-replay.json").read_text(encoding="utf-8"))
    diff = (ROOT / "ui/lab/calendar-day.patch").read_text(encoding="utf-8")
    if hashlib.sha256(diff.encode()).hexdigest() != recording["observation"]["patchDigest"]:
        raise ValueError("The product diff differs from the captured VibeCheck patch.")
    blobs = {}
    for prefix in ("ui/layers/review", "runtime/layers/service"):
        for version in (1, 2):
            raw = (ROOT / f"{prefix}-v{version}.wasm").read_bytes()
            blobs[hashlib.sha256(raw).hexdigest()] = base64.b64encode(raw).decode("ascii")
    for release in recording["releases"]:
        if any(key not in blobs for key in release["manifest"]["layers"].values()):
            raise ValueError("A signed release references a module outside the bundled replay.")
    # Embed the pinned Git source bytes even when a Windows checkout has CRLF.
    core_source = (ROOT / "runtime/vendor/llp/llp-core.js").read_bytes().replace(b"\r\n", b"\n")
    core = base64.b64encode(core_source).decode("ascii")
    script = (HERE / "replay.mjs").read_text(encoding="utf-8").replace(
        '"./llp-core.js"', '"data:text/javascript;base64,' + core + '"')
    page = (HERE / "page.html").read_text(encoding="utf-8")
    for placeholder, value in {
        "/* BUNDLED_REPLAY */": embedded({"recording": recording, "diff": diff, "blobs": blobs}),
        "/* REPLAY_MODULE */": script,
        "<!-- UPSTREAM_LICENSE -->": (ROOT / "runtime/vendor/llp/LICENSE").read_text(encoding="utf-8"),
    }.items():
        if page.count(placeholder) != 1:
            raise ValueError("Ambiguous replay template marker " + placeholder)
        page = page.replace(placeholder, value)
    output.write_bytes(page.encode("utf-8"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Destination HTML file")
    build(parser.parse_args().output)
