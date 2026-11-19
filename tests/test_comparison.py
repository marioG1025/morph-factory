"""Contracts for replaying exactly one proposed patch on two independent Git trees."""

import json
import os
from http.server import ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from comparison import compare_proposal, draft_digest


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True, encoding="utf-8").strip()


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / "real product"
        self.repo.mkdir()
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.name", "Fixture")
        git(self.repo, "config", "user.email", "fixture@example.test")
        path = self.repo / "title.txt"
        path.write_text("Friday\n", encoding="utf-8")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "Original")
        self.base = git(self.repo, "rev-parse", "HEAD")
        self.diff = "--- a/title.txt\n+++ b/title.txt\n@@ -1 +1 @@\n-Friday\n+Saturday\n"

    def compare(self, script):
        return compare_proposal(self.repo, self.base, self.diff, [sys.executable, "-c", script])

    def test_reports_identical_case_ids_same_path_selection_and_preserves_dirty_checkout(self):
        (self.repo / "title.txt").write_text("Unsaved edit", encoding="utf-8")
        (self.repo / "staged.txt").write_text("Staged edit", encoding="utf-8")
        git(self.repo, "add", "staged.txt")
        before_status = git(self.repo, "status", "--porcelain")
        before_index = git(self.repo, "write-tree")
        script = """
import json, os, pathlib, sys
from pathlib import Path
assert json.loads(os.environ["MORPH_CHANGED_PATHS"]) == ["title.txt"]
assert not Path("staged.txt").exists()
day = Path("title.txt").read_text().strip()
ok = day == "Saturday"
rows = [{"id": "title", "name": "Calendar day", "status": "passed" if ok else "failed", "detail": day},
        {"id": "control", "name": "Control", "status": "passed", "detail": "Stable"}]
if ok:
    rows.reverse()
Path(os.environ["MORPH_CASE_REPORT"]).write_text("".join(json.dumps(x) + chr(10) for x in rows))
print(day)
sys.exit(0 if ok else 1)
"""
        result = self.compare(script)
        self.assertEqual(result["baseline"]["status"], "failed")
        self.assertEqual(result["candidate"]["status"], "passed")
        self.assertEqual(result["summary"]["fixed"], 1)
        self.assertEqual(result["summary"]["unchanged"], 1)
        self.assertEqual(result["digest"], draft_digest(self.diff))
        self.assertEqual(result["baseline"]["output"].strip(), "Friday")
        self.assertEqual(result["candidate"]["output"].strip(), "Saturday")
        self.assertEqual(self.base, git(self.repo, "rev-parse", "HEAD"))
        self.assertEqual(before_status, git(self.repo, "status", "--porcelain"))
        self.assertEqual(before_index, git(self.repo, "write-tree"))
        self.assertEqual((self.repo / "title.txt").read_text(), "Unsaved edit")

    def test_generic_command_regression_and_stale_base(self):
        result = self.compare("from pathlib import Path; import sys; sys.exit(int('Saturday' in Path('title.txt').read_text()))")
        self.assertEqual(result["summary"]["regressed"], 1)
        with self.assertRaisesRegex(ValueError, "HEAD changed"):
            compare_proposal(self.repo, "0" * 40, self.diff, [sys.executable])

    def test_missing_command_and_bad_patch_are_not_product_failures(self):
        result = compare_proposal(self.repo, self.base, self.diff, ["morph-no-such-executable-872"])
        self.assertEqual(result["summary"]["inconclusive"], 1)
        self.assertEqual(result["baseline"]["status"], "error")
        self.assertIsNone(result["candidate"]["exitCode"])
        with self.assertRaisesRegex(ValueError, "trusted project check"):
            compare_proposal(self.repo, self.base, self.diff, None)
        with self.assertRaises(ValueError):
            compare_proposal(self.repo, self.base, self.diff.replace("Friday", "Sunday"), [sys.executable])

    def test_partial_report_cannot_hide_runner_failure(self):
        script = """
import json, os, sys
from pathlib import Path
row = {"id":"first","name":"First check","status":"passed","detail":"Done"}
Path(os.environ["MORPH_CASE_REPORT"]).write_text(json.dumps(row))
sys.exit(1)
"""
        result = self.compare(script)
        self.assertEqual(result["candidate"]["failed"], 1)
        self.assertEqual(result["candidate"]["status"], "failed")
        self.assertIn("Check completion", [c["name"] for c in result["candidate"]["cases"]])


@unittest.skipUnless(os.getenv("MORPH_VIBECHECK_REPO"), "Set MORPH_VIBECHECK_REPO to run the pinned product checks.")
class VibeCheckComparisonTests(unittest.TestCase):
    def compare(self, patch):
        repo = os.environ["MORPH_VIBECHECK_REPO"]
        base = "6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24"
        diff = (ROOT / "ui/lab" / patch).read_text(encoding="utf-8")
        result = compare_proposal(repo, base, diff, [sys.executable, str(ROOT / "examples/vibecheck/check.py")])
        self.assertEqual(result["baseline"]["status"], "failed", result["baseline"]["output"])
        self.assertEqual(result["candidate"]["status"], "passed", result["candidate"]["output"])
        return result

    def test_dates(self):
        result = self.compare("calendar-day.patch")
        self.assertEqual(result["summary"]["fixed"], 4)
        self.assertEqual(result["summary"]["unchanged"], 2)
        self.assertEqual(result["candidate"]["passed"], 6)

    def test_frontend_build(self):
        result = self.compare("vite-types.patch")
        self.assertIn("TS2339", result["baseline"]["output"])
        self.assertEqual(result["summary"]["fixed"], 1)
        self.assertIn("TypeScript and Vite completed", result["candidate"]["cases"][0]["detail"])

    def test_live_gate_approval_compare_restore_on_one_open_draft(self):
        from server import Desk, RequestHandler
        command = [sys.executable, str(ROOT / "examples/vibecheck/check.py")]
        with tempfile.TemporaryDirectory() as state_dir:
            desk = Desk(os.environ["MORPH_VIBECHECK_REPO"], Path(state_dir), command)
            server = ThreadingHTTPServer(("127.0.0.1", 0), RequestHandler)
            server.desk = desk
            origin = f"http://127.0.0.1:{server.server_port}"
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            def request(path, body=None):
                req = Request(origin + "/api/" + path, data=json.dumps(body).encode() if body is not None else None,
                              headers={"Origin": origin, "Content-Type": "application/json"})
                try:
                    with urlopen(req, timeout=90) as reply:
                        return reply.status, json.load(reply)
                except HTTPError as exc:
                    return exc.code, json.load(exc)
            try:
                _, scan = request("scan", {})
                base = scan["scan"]["head"]
                patch = (ROOT / "ui/lab/calendar-day.patch").read_text(encoding="utf-8")
                status, result = request("draft", dict(title="Show day", diff=patch, base=base))
                self.assertEqual(status, 200, result)
                identity = {"base": base, "digest": draft_digest(patch)}
                self.assertEqual(request("compare", identity)[0], 409)
                initial = request("live/status")[1]
                offered = request("live/candidate")[1]
                status, approved = request("live/approve", {"expectedVersion": initial["version"],
                                           "expectedReviewHash": offered["manifest"]["layers"]["review"]})
                self.assertEqual(status, 200, approved)
                self.assertEqual(request("compare", {**identity, "digest": "0" * 64})[0], 409)
                status, evidence = request("compare", identity)
                self.assertEqual(status, 200, evidence)
                self.assertEqual(evidence["releaseVersion"], approved["version"])
                self.assertEqual(evidence["summary"]["fixed"], 4)
                self.assertEqual(request("state")[1]["draft"]["comparison"], evidence)
                self.assertEqual(request("live/restore", {"expectedVersion": approved["version"]})[0], 200)
                self.assertEqual(request("compare", identity)[0], 409)
                self.assertEqual(request("state")[1]["draft"]["diff"], patch)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)
                desk.live.close()


if __name__ == "__main__":
    unittest.main()
