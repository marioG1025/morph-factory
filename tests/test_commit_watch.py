"""Concurrent watchers share a trusted HEAD check and yield to operator work."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from head_check import check_head
from factory import inspect_repo
from server import Desk


class CommitWatch(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        repo = root / "product"
        repo.mkdir()
        self.repo = repo
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Commit watch test")
        self.git("config", "user.email", "watch@example.invalid")
        self.commit("start")
        self.desk = Desk(repo, root / "state", [sys.executable, "-c", "print('Product checked')"])
        self.desk.act("scan", {})

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo).decode().strip()

    def commit(self, name):
        self.git("commit", "-qm", name, "--allow-empty")

    def request(self):
        head = self.desk.head()
        return {"base": head["head"], "checkKey": head["checkKey"], "generation": head["draftGeneration"]}

    def simultaneous(self, during):
        started, finish = threading.Event(), threading.Event()
        def slow(*args):
            started.set()
            self.assertTrue(finish.wait(10))
            return check_head(*args)
        target = self.request()
        with patch("server.check_head", side_effect=slow) as check, ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(self.desk.act, "watch-check", target)
            try:
                self.assertTrue(started.wait(3))
                self.assertEqual(self.desk.act("watch-check", target)["status"], "running")
                during(target)
            finally:
                finish.set()
            outcome = first.result(timeout=15)
            self.assertEqual(check.call_count, 1)
            return target, outcome

    def test_watchers_share_one_run_but_operator_can_explicitly_rerun(self):
        target, outcome = self.simultaneous(lambda target: None)
        result = outcome["state"]["headCheck"]
        with patch("server.check_head") as check:
            cached = self.desk.act("watch-check", target)
            self.assertEqual(cached["state"]["headCheck"]["id"], result["id"])
            check.assert_not_called()
        manual = self.desk.act("check-head", target)
        self.assertNotEqual(manual["headCheck"]["id"], result["id"])
        self.assertIsNone(manual["draft"])
        self.assertEqual(self.git("branch", "--list", "morph/*"), "")

    def test_moving_head_drops_the_old_result_and_checks_latest_commit(self):
        target, old = self.simultaneous(lambda target: self.commit("New revision"))
        self.assertEqual(old["status"], "moved")
        self.assertIsNone(self.desk.head_result)
        self.assertEqual(self.desk.act("watch-check", target)["status"], "moved")
        latest = self.desk.act("watch-check", self.request())
        self.assertEqual(latest["state"]["headCheck"]["base"], self.git("rev-parse", "HEAD"))

    def test_opening_and_discarding_a_draft_invalidates_an_old_watch_request(self):
        def interrupt(target):
            self.desk.act("draft", {"title": "Operator selection", "diff": "Operator draft"})
            self.assertEqual(self.desk.act("watch-check", target)["status"], "occupied")
            self.assertEqual(self.desk.draft["diff"], "Operator draft")
            self.desk.act("discard", {})
        target, old = self.simultaneous(interrupt)
        self.assertEqual(old["status"], "occupied")
        self.assertIsNone(self.desk.head_result)
        with patch("server.check_head") as check:
            self.assertEqual(self.desk.act("watch-check", target)["status"], "occupied")
            check.assert_not_called()

    def test_command_identity_is_required_and_no_configured_check_cannot_run(self):
        target = self.request()
        with patch("server.check_head") as check:
            self.assertEqual(self.desk.act("watch-check", {**target, "checkKey": "old"})["status"], "command-changed")
            plain = Desk(self.repo, Path(self.temp.name) / "other", None)
            self.assertEqual(plain.act("watch-check", target)["status"], "command-changed")
            check.assert_not_called()

    def test_two_watchers_share_one_source_scan_for_a_new_head(self):
        self.commit("Observed update")
        with patch("server.inspect_repo", wraps=inspect_repo) as scan:
            first = self.desk.act("scan", {"ifChanged": True})
            second = self.desk.act("scan", {"ifChanged": True})
            self.assertEqual(first["scan"]["head"], second["scan"]["head"])
            self.assertEqual(scan.call_count, 1)
            self.desk.act("scan", {})
            self.assertEqual(scan.call_count, 2)
