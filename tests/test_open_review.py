"""A slow check must not lock the live desk or update a replacement draft."""
import subprocess
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from server import Desk


class OpenReview(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.folder.cleanup)
        root = Path(self.folder.name)
        repo = root / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repo, check=True)
        subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=a@example.invalid",
                        "commit", "-qm", "Base", "--allow-empty"], cwd=repo, check=True)
        self.desk = Desk(repo, root / "state", None)
        self.desk.act("scan", {})
        self.desk.act("draft", {"title": "First patch", "diff": "example patch"})

    def test_new_draft_can_replace_in_flight_check(self):
        started, finish = threading.Event(), threading.Event()

        def slow_check(*args):
            started.set()
            if not finish.wait(10):
                self.fail("Desk was locked by a pending check")
            return {"ok": True}

        with patch("server.verify_proposal", slow_check), ThreadPoolExecutor(max_workers=2) as pool:
            pending = pool.submit(self.desk.act, "verify", {})
            try:
                self.assertTrue(started.wait(3))
                state = pool.submit(self.desk.state).result(timeout=2)
                self.assertEqual(state["draft"]["title"], "First patch")
                self.desk.act("discard", {})
                self.desk.act("draft", {"title": "Second patch", "diff": "different patch"})
            finally:
                finish.set()
            with self.assertRaisesRegex(ValueError, "changed during verification"):
                pending.result(timeout=4)
        self.assertIsNone(self.desk.draft["verification"])
        self.assertEqual(self.desk.draft["title"], "Second patch")

    def test_stale_tab_cannot_discard_a_different_patch(self):
        with self.assertRaisesRegex(ValueError, "draft has changed"):
            self.desk.act("discard", {"expectedPatch": {"base": self.desk.draft["base"], "digest": "old"}})
        self.assertEqual(self.desk.draft["title"], "First patch")
