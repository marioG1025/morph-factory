"""A current-commit finding is evidence. The operator decides what to do with it."""
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from comparison import ComparisonConflict
from head_check import check_head
from server import Desk, RequestHandler, proposal_files


class HeadIntake(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / "ordinary product"
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.invalid")
        (self.repo / "pricing.py").write_text(
            "def total(subtotal, delivery_fee):\n    return subtotal\n", encoding="utf-8")
        (self.repo / "test_price.py").write_text(
            "import unittest\nfrom pricing import total\nclass Price(unittest.TestCase):\n"
            "    def test_total(self):\n"
            "        \"Totals include the delivery fee.\"\n"
            "        self.assertEqual(total(8, 1), 9)\n", encoding="utf-8")
        self.git("add", "test_price.py", "pricing.py")
        self.git("commit", "-qm", "Product suite")
        self.base = self.git("rev-parse", "HEAD")
        self.command = [sys.executable, "-B", "-m", "unittest", "discover"]
        self.desk = Desk(self.repo, Path(self.temp.name) / "state", self.command)
        self.desk.act("scan", {})

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo).decode().strip()

    def run_check(self):
        return self.desk.act("check-head", {"base": self.base})["headCheck"]

    def test_named_failure_stays_on_head_and_never_starts_agent(self):
        test = self.repo / "test_price.py"
        test.write_text("pending user edit", encoding="utf-8")
        self.git("add", "test_price.py")
        index = self.git("write-tree")
        with patch("server.propose") as agent:
            evidence = self.run_check()
            agent.assert_not_called()
        self.assertEqual(evidence["status"], "failed")
        self.assertEqual(evidence["failed"], 1)
        self.assertIn("test_total", evidence["cases"][0]["name"])
        self.assertIn("8 != 9", evidence["cases"][0]["detail"])
        self.assertEqual(self.git("write-tree"), index)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.base)
        self.assertEqual(test.read_text(), "pending user edit")
        self.assertIsNone(self.desk.draft)
        source = {"base": self.base, "run": evidence["id"], "case": evidence["cases"][0]["id"]}
        self.desk.require_check_source(source)
        self.run_check()
        with self.assertRaises(ComparisonConflict):
            self.desk.start_agent(0, {"idea": "Fix the price", "checkSource": source})

    def test_empty_unclassified_and_environment_runs_have_no_failure_proposals(self):
        commands = [
            (self.command + ["-p", "absent_*.py"], "empty"),
            (["morph-no-such-executable-a032"], "error"),
            ([sys.executable, "-c", "import sys; sys.exit(3)"], "unclassified"),
        ]
        for command, status in commands:
            with self.subTest(status=status):
                row = check_head(self.repo, self.base, command)
                self.assertEqual(row["status"], status)
                self.assertFalse([case for case in row["cases"] if case["status"] == "failed"])
        with self.assertRaisesRegex(ValueError, "trusted project command"):
            check_head(self.repo, self.base, [])

    def test_replacement_draft_discards_pending_evidence_and_duplicate_run(self):
        started, release = threading.Event(), threading.Event()
        def wait(*args):
            started.set()
            self.assertTrue(release.wait(10))
            return {"status": "passed"}
        with patch("server.check_head", wait), ThreadPoolExecutor(max_workers=1) as pool:
            task = pool.submit(self.run_check)
            try:
                self.assertTrue(started.wait(3))
                with self.assertRaisesRegex(ComparisonConflict, "already running"):
                    self.run_check()
                self.desk.act("draft", {"title": "Operator replacement", "diff": "An unrelated patch."})
                self.desk.act("discard", {})
            finally:
                release.set()
            with self.assertRaisesRegex(ComparisonConflict, "changed during"):
                task.result(timeout=3)
        self.assertIsNone(self.desk.head_result)

    def test_stale_head_blocks_model_entry_and_late_draft(self):
        row = self.run_check()
        source = {"base": self.base, "run": row["id"], "case": row["cases"][0]["id"]}
        self.git("commit", "--allow-empty", "-qm", "Advance")
        with patch("server.propose") as agent:
            with self.assertRaises(ComparisonConflict):
                self.desk.start_agent(0, {"idea": "Fix the price", "checkSource": source})
            with self.assertRaises(ComparisonConflict):
                self.desk.act("draft", {"title": "Late", "diff": "patch", "checkSource": source})
            agent.assert_not_called()
        self.assertIsNone(self.desk.act("scan", {})["headCheck"])

    def test_explicit_submission_passes_edited_idea_to_worker_and_creates_only_a_draft(self):
        row = self.run_check()
        source = {"base": self.base, "run": row["id"], "case": row["cases"][0]["id"]}
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), RequestHandler)
        httpd.desk = self.desk
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        change = b"""--- a/pricing.py
+++ b/pricing.py
@@ -1,2 +1,2 @@
 def total(subtotal, delivery_fee):
-    return subtotal
+    return subtotal + delivery_fee
"""
        try:
            with patch("server.shutil.which", return_value=sys.executable), patch("propose.generate", return_value=change) as generate:
                idea = "Include the delivery fee in the price."
                files = ["test_price.py", "pricing.py"]
                result = self.desk.start_agent(httpd.server_port, {"idea": idea, "files": files, "checkSource": source})
                self.assertEqual(result["status"], "running")
                deadline = time.monotonic() + 20
                while self.desk.agent_status()["status"] == "running" and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertEqual(self.desk.agent["status"], "ready", self.desk.agent["message"])
                self.assertEqual(generate.call_args.args[3], idea)
                self.assertEqual(generate.call_args.args[4], files)
                self.assertEqual(self.desk.draft["base"], self.base)
                self.assertIsNone(self.desk.draft["review"])
                self.assertIsNone(self.desk.draft["verification"])
                self.assertFalse(self.git("branch", "--list", "morph/*"))
                self.assertEqual(self.git("status", "--short"), "")
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=3)

    def test_legacy_and_multiple_attachment_forms(self):
        self.assertEqual(proposal_files({"file": "pricing.py"}), ["pricing.py"])
        self.assertEqual(proposal_files({"file": " "}), [])
        self.assertEqual(proposal_files({"files": ["a.py", "nested\\b.py", "c.py", "d.py"]}),
                         ["a.py", "nested/b.py", "c.py", "d.py"])
        for value in ({"files": ["a"] * 5}, {"files": "../outside"}, {"files": ["a", None]},
                      {"files": ["a\nb"]}, {"files": ["C:/outside"]}, {"files": ["sub/../outside"]},
                      {"files": ["a"], "file": "b"}, {"files": [""]}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                proposal_files(value)
