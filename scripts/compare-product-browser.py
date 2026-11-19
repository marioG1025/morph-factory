"""Compare the two recorded calendar patches against VibeCheck's rendered list and detail pages."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from comparison import draft_digest
from server import open_desk
from vibecheck import BASE

PATCHES = {
    "curated": ROOT / "ui/lab/calendar-day.patch",
    "independent-agent": ROOT / "docs/experiments/patches/vibecheck-agent-calendar.patch",
}


def compare(source, scratch):
    repo = scratch / "VibeCheck"
    subprocess.run(["git", "clone", "--quiet", "--no-local", "--no-checkout", "--", source, str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "checkout", "--quiet", "--detach", BASE], check=True)
    configured = [sys.executable, str(ROOT / "examples/vibecheck/check.py"), "--browser-dates"]
    outcomes = []
    with open_desk(repo, scratch / "desk", configured) as desk:
        desk.act("scan", {})
        offer = desk.live.command("candidate")
        desk.live.command("approve", expectedVersion=1, expectedDigest=offer["digest"])
        for name, path in PATCHES.items():
            diff = path.read_text(encoding="utf-8")
            desk.act("draft", {"title":name + " calendar repair", "base":BASE, "diff":diff, "ifEmpty":True})
            started = time.monotonic()
            measured = desk.compare({"base":BASE, "digest":draft_digest(desk.draft["diff"])})
            outcomes.append(measured)
            sides = {}
            for side in ("baseline", "candidate"):
                observations = measured[side]
                runtime = next((line for line in observations["output"].splitlines()
                                if line.startswith("VibeCheck browser runtime ")), None)
                sides[side] = {"status":observations["status"], "passed":observations["passed"],
                               "failed":observations["failed"], "durationMs":observations["durationMs"],
                               "runtime":runtime, "cases":observations["cases"]}
                if observations["status"] == "error":
                    print(observations["output"][-1800:], file=sys.stderr)
            print(json.dumps({"patch":name, "base":BASE, "candidateTree":measured["candidateTree"],
                              "diffDigest":measured["digest"], "releaseVersion":measured["releaseVersion"],
                              "elapsedMs":round((time.monotonic() - started) * 1000),
                              "counts":measured["summary"], **sides}), flush=True)
            desk.act("discard", {})
    clean = subprocess.check_output(["git", "-C", str(repo), "status", "--porcelain"])
    if clean:
        raise RuntimeError("The comparison changed the scratch product checkout.")
    if outcomes[0]["baseline"]["cases"] != outcomes[1]["baseline"]["cases"]:
        raise RuntimeError("The two original-product runs returned different case observations.")
    expected = {"fixed":12, "regressed":0, "unchanged":36, "added":0, "removed":0, "inconclusive":0}
    return all(run["summary"] == expected and run["baseline"]["passed"] == 36
               and run["baseline"]["failed"] == 12 and run["candidate"]["passed"] == 48
               and run["candidate"]["status"] == "passed" for run in outcomes)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=os.environ.get("MORPH_VIBECHECK_REPO") or
                        "https://github.com/marioG1025/VibeCheck.git", help="Source for the disposable product clone")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="morph-product-browser-") as directory:
        sys.exit(0 if compare(args.repo, Path(directory)) else 1)
