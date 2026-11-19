"""Change the release twice during a real VibeCheck build and check which result survives."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
import tempfile
import threading
from time import monotonic, sleep
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from comparison import draft_digest
from server import open_desk, RequestHandler, ThreadingHTTPServer
from vibecheck import BASE


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True, help="Pinned VibeCheck checkout")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="morph-withdraw-") as tmp:
        directory = Path(tmp)
        marker = directory / "project-check-started"
        probe = directory / "build.py"
        # Mark entry into the trusted command. runpy then executes the normal project check.
        probe.write_text("from pathlib import Path\nimport runpy\n"
                         f"Path({str(marker)!r}).touch()\n"
                         f"runpy.run_path({str(ROOT / 'examples/vibecheck/check.py')!r}, run_name='__main__')\n",
                         encoding="utf-8")
        with open_desk(args.repo, directory / "state", [sys.executable, str(probe)]) as desk:
            if desk.head()["head"] != BASE:
                raise ValueError("Use the VibeCheck commit " + BASE)
            with ThreadingHTTPServer(("127.0.0.1", 0), RequestHandler) as http:
                http.desk = desk
                server_thread = threading.Thread(target=http.serve_forever, daemon=True)
                server_thread.start()
                try:
                    run = exercise(http.server_port, marker)
                    print(json.dumps(run, indent=2))
                finally:
                    http.shutdown()
                    server_thread.join()


def exercise(port, marker):
    def api(action, payload=None):
        origin = f"http://127.0.0.1:{port}"
        request = Request(origin + "/api/" + action,
                          data=None if payload is None else json.dumps(payload).encode(),
                          headers={"Origin": origin, "Content-Type":"application/json"})
        with urlopen(request, timeout=300) as response:
            return json.load(response)

    def approve():
        release = api("live/status")
        candidate = api("live/candidate")
        return api("live/approve", {"expectedVersion":release["version"], "expectedDigest":candidate["digest"]})

    api("scan", {})
    patch = (ROOT / "ui/lab/vite-types.patch").read_text(encoding="utf-8")
    api("draft", {"base":BASE, "diff":patch, "title":"Restore Vite environment types"})
    identity = {"base":BASE, "digest":draft_digest(patch)}
    first = approve()
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(api, "compare", identity)
        deadline = monotonic() + 30
        while not marker.exists():
            if monotonic() >= deadline or pending.done():
                raise RuntimeError("The baseline production check did not start.")
            sleep(0.03)
        restored = api("live/restore", {"expectedVersion":first["version"]})
        latest = approve()
        try:
            pending.result()
        except HTTPError as error:
            if error.code != 409 or "live release changed during comparison" not in json.load(error)["error"]:
                raise
        else:
            raise AssertionError("A superseded comparison was accepted.")
    assert not api("state")["draft"].get("comparison")
    fresh = api("compare", identity)
    assert fresh["releaseVersion"] == latest["version"] and fresh["summary"]["fixed"] == 1
    assert fresh["baseline"]["status"] == "failed" and fresh["candidate"]["status"] == "passed"
    return {"base":BASE, "candidateTree":fresh["candidateTree"], "withdrawn":first["version"],
            "restored":restored["version"], "current":latest["version"],
            "oldComparisonDiscarded":True, "freshComparison":fresh["summary"]}


if __name__ == "__main__":
    main()
