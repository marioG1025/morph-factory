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
from unittest.mock import patch
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

    def test_durable_comparison_survives_an_unavailable_notification(self):
        from server import Desk
        state = Path(self.temp.name) / "desk"
        command = [sys.executable, "-c", "print('check complete')"]
        desk = Desk(self.repo, state, command)
        self.addCleanup(desk.close)
        desk.act("scan", {})
        desk.act("draft", {"title": "Change day", "diff": self.diff})
        persisted = []

        def fail_notification(result):
            persisted.append(json.loads(desk.file.read_text(encoding="utf-8"))["draft"]["comparison"])
            raise OSError("Test relay is offline")

        with patch.object(desk.live, "require_compare", return_value={"version": 2}), \
             patch.object(desk.live, "comparison_saved", fail_notification), self.assertLogs("morph", "ERROR"):
            result = desk.compare({"base": self.base, "digest": draft_digest(self.diff)})
        self.assertEqual(persisted, [result])
        self.assertRegex(result["run"], "^[0-9a-f]{32}$")
        self.assertEqual(Desk(self.repo, state, command).state()["draft"]["comparison"], result)

    def test_current_report_route_reads_only_the_requested_persisted_run(self):
        from server import Desk, RequestHandler
        state = Path(self.temp.name) / "desk"
        desk = Desk(self.repo, state, None)
        desk.act("scan", {})
        desk.act("draft", {"title": "Change day", "diff": self.diff})
        result = {"run": "a" * 32, "base": self.base, "digest": draft_digest(self.diff),
                  "releaseVersion": 2, "summary": {"fixed": 1}}
        desk.persist({**desk.draft, "comparison": result})
        desk.close()
        desk = Desk(self.repo, state, None)
        self.addCleanup(desk.close)
        with ThreadingHTTPServer(("127.0.0.1", 0), RequestHandler) as http:
            http.desk = desk
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            origin = f"http://127.0.0.1:{http.server_port}"
            def get(path, headers=None):
                try:
                    response = urlopen(Request(origin + path, headers=headers or {}), timeout=5)
                except HTTPError as exc:
                    response = exc
                with response:
                    self.assertEqual(response.headers.get("Cache-Control"), "no-store")
                    return response.status, json.load(response)

            route = "/api/comparisons/" + result["run"]
            try:
                with patch.object(desk.live, "command", side_effect=AssertionError("A read started the live host")), \
                     patch("server.compare_proposal", side_effect=AssertionError("A read ran the project check")):
                    expected = (200, {"draftGeneration": desk.draft_generation, "comparison": result})
                    self.assertEqual(get(route), expected)
                    self.assertEqual(get(route, {"Origin": origin}), expected)
                    self.assertEqual(get(route, {"Origin": "https://elsewhere.invalid"})[0], 403)
                    for invalid in ("b" * 32, result["run"].upper(), result["run"][:-1], result["run"] + "/", ""):
                        self.assertEqual(get("/api/comparisons/" + invalid)[0], 404)
                    for changed in ({"base": "0" * 40}, {"digest": "0" * 64}, {"run": "b" * 32}):
                        desk.persist({**desk.draft, "comparison": {**result, **changed}})
                        self.assertEqual(get(route)[0], 404)
                    legacy = {key: value for key, value in result.items() if key != "run"}
                    desk.persist({**desk.draft, "comparison": legacy})
                    self.assertEqual(get(route)[0], 404)
                    self.assertEqual(get("/api/state")[1]["draft"]["comparison"], legacy)
                    desk.act("discard", {})
                    self.assertEqual(get(route)[0], 404)
            finally:
                http.shutdown()
                thread.join()

    def approved_desk(self):
        from live_release import node_binary
        from server import Desk
        try:
            node_binary()
        except ValueError as exc:
            self.skipTest(str(exc))
        if not (ROOT / "runtime/node_modules/ws/package.json").exists():
            self.skipTest("Install the factory's locked runtime dependency for the live transport tests.")
        state = Path(self.temp.name) / "desk"
        self.check_runs = Path(self.temp.name) / "check-runs.txt"
        command = [sys.executable, "-c", f"with open({str(self.check_runs)!r}, 'a') as f: f.write('x')"]
        desk = Desk(self.repo, state, command)
        self.addCleanup(desk.close)
        desk.act("scan", {})
        desk.act("draft", {"title": "Change day", "diff": self.diff})
        offer = desk.live.command("candidate")
        desk.live.command("approve", expectedVersion=1, expectedDigest=offer["digest"])
        return desk, state

    def stored_runs(self, state):
        runs = []
        for log in state.rglob("log.jsonl"):
            for line in log.read_text(encoding="utf-8").splitlines():
                for key, value in json.loads(line).get("set", []):
                    if key == "shared/review/comparison":
                        runs.append(json.loads(value)["run"])
        return runs

    def test_reconnect_recovers_a_post_save_stop_once_through_session_bootstrap(self):
        from server import RequestHandler, open_desk
        desk, state = self.approved_desk()
        with patch.object(desk.live, "comparison_saved", side_effect=SystemExit("stop after save")):
            with self.assertRaises(SystemExit):
                desk.compare({"base": self.base, "digest": draft_digest(self.diff)})
        saved = json.loads(desk.file.read_text(encoding="utf-8"))["draft"]["comparison"]
        self.assertEqual(self.stored_runs(state), [])
        desk.close()

        # Both the missed event and a lost acknowledgement must converge to
        # one journal entry, even on a second complete desk/sidecar restart.
        for _ in range(2):
            with open_desk(self.repo, state, desk.command) as reopened:
                with ThreadingHTTPServer(("127.0.0.1", 0), RequestHandler) as http:
                    http.desk = reopened
                    thread = threading.Thread(target=http.handle_request)
                    thread.start()
                    try:
                        with urlopen(f"http://127.0.0.1:{http.server_port}/api/live/session", timeout=15) as reply:
                            self.assertEqual(json.load(reply)["version"], 2)
                    finally:
                        thread.join(15)
                self.assertEqual(reopened.draft["comparison"], saved)
                self.assertEqual(self.stored_runs(state), [saved["run"]])
        self.assertEqual(self.check_runs.read_text(), "xx")

    def test_connected_peer_retries_after_transient_failure_without_session_requests(self):
        desk, state = self.approved_desk()
        send = desk.live.comparison_saved
        attempts = []
        delivered = threading.Event()

        def temporarily_offline(report):
            attempts.append(report["run"])
            if len(attempts) == 1:
                raise OSError("Temporary relay failure")
            response = send(report)
            delivered.set()
            return response

        with patch.object(desk.live, "comparison_saved", temporarily_offline), self.assertLogs("morph", "ERROR"):
            result = desk.compare({"base": self.base, "digest": draft_digest(self.diff)})
            self.assertTrue(delivered.wait(15), "A passive subscriber needs recovery without another HTTP request.")
            with desk.lock:
                self.assertIsNone(desk._notice_retry)
            desk.live_session()
        self.assertEqual(attempts, [result["run"], result["run"]])
        self.assertEqual(self.stored_runs(state), [result["run"]])
        self.assertEqual(self.check_runs.read_text(), "xx")

    def test_retry_drops_a_replaced_draft_and_a_withdrawn_release(self):
        desk, state = self.approved_desk()
        identity = {"base": self.base, "digest": draft_digest(self.diff)}
        for change in ("replace", "withdraw"):
            with desk.lock:
                with patch.object(desk.live, "comparison_saved", side_effect=OSError("Temporary failure")), \
                     self.assertLogs("morph", "ERROR"):
                    desk.compare(identity)
                timer = desk._notice_retry
                if change == "replace":
                    # The new incarnation even has the same patch and base.
                    desk.act("draft", {"title": "Change day again", "diff": self.diff})
                else:
                    desk.live.command("restore", expectedVersion=2)
                    next_offer = desk.live.command("candidate")
                    desk.live.command("approve", expectedVersion=3, expectedDigest=next_offer["digest"])
            timer.join(15)
            self.assertFalse(timer.is_alive())
            self.assertIsNone(desk._notice_retry)
            self.assertEqual(self.stored_runs(state), [])
        self.assertEqual(self.check_runs.read_text(), "xxxx")


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
                                           "expectedDigest": offered["digest"]})
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
