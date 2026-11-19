"""Capture the three signed releases and six calendar probes from a disposable factory desk.

From the factory checkout, run

    python scripts/replay/capture.py --repo /path/to/local/VibeCheck

The source repository must contain the commit pinned by vibecheck.py. Each capture
creates a fresh local signing key. Its public key accompanies the signed releases.
The comparison is an unsigned observation of the trusted VibeCheck project check.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from comparison import draft_digest
from live_release import node_binary
from server import open_desk
from vibecheck import BASE

DEFAULT_OUTPUT = ROOT / "docs/experiments/receipts/vibecheck-replay.json"


def fields(record, names):
    return {name: record[name] for name in names.split()}


def public_release(evidence):
    # Rebuild the public projection. The receipt inspector verifies that it still
    # matches the actual signature, including every nested signed field.
    manifest = fields(evidence["manifest"], "llp app version order overlap x-morph-release")
    slots = "review reviewService"
    for name in ("layers", "hosts", "caps"):
        manifest[name] = fields(evidence["manifest"][name], slots)
    manifest["keys"] = {slot: fields(evidence["manifest"]["keys"][slot], "own read")
                        for slot in slots.split()}
    release = {"manifest": manifest, "sig": evidence["sig"]}
    if "serverRehearsal" in evidence:
        proof = evidence["serverRehearsal"]
        public = fields(proof, "app manifestDigest baseVersion version release ok elapsedMs atUtc sig")
        public["checks"] = [fields(check, "operation expected actual ok") for check in proof["checks"]]
        release["serverRehearsal"] = public
    return release


def public_observation(measured):
    return {"base": measured["base"], "patchDigest": measured["digest"], "candidateTree": measured["candidateTree"],
            "releaseVersion": measured["releaseVersion"], "original": measured["baseline"]["status"],
            "candidate": measured["candidate"]["status"],
            "counts": fields(measured["summary"], "fixed regressed unchanged added removed inconclusive"),
            "cases": [fields(case, "id name classification before after") for case in measured["changes"]]}


def capture(source, scratch):
    repo = scratch / "product"
    subprocess.run(["git", "clone", "--quiet", "--no-local", "--no-checkout", "--",
                    str(source.resolve(strict=True)), str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "checkout", "--quiet", "--detach", BASE], check=True)
    subprocess.run(["git", "-C", str(repo), "remote", "remove", "origin"], check=True)
    check = [sys.executable, str(ROOT / "examples/vibecheck/check.py")]
    patch = (ROOT / "ui/lab/calendar-day.patch").read_text(encoding="utf-8")
    with open_desk(repo, scratch / "desk", check) as desk:
        desk.act("scan", {})
        desk.act("draft", {"base": BASE, "title": "Keep date-only concerts on the advertised day",
                           "diff": patch, "ifEmpty": True})
        first = desk.live.command("evidence")
        offer = desk.live.command("candidate")
        desk.live.command("approve", expectedVersion=1, expectedDigest=offer["digest"])
        second = desk.live.command("evidence")
        measured = desk.compare({"base": BASE, "digest": draft_digest(patch)})
        desk.live.command("restore", expectedVersion=2)
        third = desk.live.command("evidence")

    public_key = fields(first["publicKey"], "kty crv x y ext key_ops")
    if not all(event["publicKey"] == public_key for event in (first, second, third)):
        raise ValueError("The three releases must share one public verification key.")
    releases = [public_release(event) for event in (first, second, third)]
    phases = [(r["manifest"]["version"], r["manifest"]["x-morph-release"]) for r in releases]
    if phases != [(1, "review"), (2, "compare"), (3, "review")]:
        raise ValueError("The observed releases differ from the expected review sequence.")
    if releases[0]["manifest"]["layers"] != releases[2]["manifest"]["layers"]:
        raise ValueError("The restored release uses different Wasm modules from the original review.")
    for release in releases:
        receipt = {"format": "morph-factory/experiment-receipt-v1", "signedRelease":
                   {"manifest": release["manifest"], "sig": release["sig"], "publicKey": public_key}}
        if "serverRehearsal" in release:
            receipt["serverRehearsal"] = release["serverRehearsal"]
        envelope = scratch / "receipt.json"
        envelope.write_text(json.dumps(receipt), encoding="utf-8")
        subprocess.run([node_binary(), str(ROOT / "scripts/inspect-receipt.mjs"), str(envelope), "--bundled"],
                       check=True)
    observation = public_observation(measured)
    counts = observation["counts"]
    if (observation["releaseVersion"] != 2 or (observation["original"], observation["candidate"]) != ("failed", "passed")
            or len(observation["cases"]) != 6 or counts["fixed"] != 4 or counts["unchanged"] != 2):
        raise ValueError("The project check did not reproduce the four date repairs and two passing controls.")
    return {"format": "morph-factory/review-replay-v1", "publicKey": public_key,
            "releases": releases, "observation": observation}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", required=True, type=Path, help="Local checkout or bare clone of VibeCheck")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Destination for the public capture")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="morph-replay-") as directory:
        replay = capture(args.repo, Path(directory))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=args.output.parent, delete=False) as pending:
        pending_path = Path(pending.name)
    try:
        pending_path.write_bytes((json.dumps(replay, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
        os.replace(pending_path, args.output)
    finally:
        pending_path.unlink(missing_ok=True)
    print("Wrote", args.output)


if __name__ == "__main__":
    main()
