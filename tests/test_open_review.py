"""A slow check must not lock the live desk or update a replacement draft."""
import json
import subprocess
import sys
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

    def test_new_commit_cannot_receive_the_old_verification(self):
        def advancing_check(*args):
            subprocess.run(["git", "-C", self.desk.repo, "-c", "user.name=Test",
                            "-c", "user.email=a@example.invalid", "commit", "-qm",
                            "Advance product", "--allow-empty"], check=True)
            return {"ok": True}

        with patch("server.verify_proposal", advancing_check):
            with self.assertRaisesRegex(ValueError, "checkout changed during verification"):
                self.desk.act("verify", {})
        self.assertIsNone(self.desk.draft["verification"])

    def restart(self, actions=()):
        script = """
import json, sys
from pathlib import Path
from server import Desk
desk = Desk(Path(sys.argv[1]), Path(sys.argv[2]), None)
desk.act('scan', {})
for name, payload in json.load(sys.stdin):
    desk.act(name, payload)
print(json.dumps(desk.state()))
"""
        result = subprocess.run([sys.executable, "-B", "-c", script, self.desk.repo, str(self.desk.file.parent)],
                                cwd=Path(__file__).resolve().parents[1], input=json.dumps(actions),
                                capture_output=True, text=True, timeout=20, check=True)
        return json.loads(result.stdout)

    def test_restart_preserves_the_incarnation_and_distinguishes_an_identical_replacement(self):
        before = self.desk.state()
        same = self.restart()
        self.assertEqual(same["draftGeneration"], before["draftGeneration"])
        self.assertEqual(same["draft"], before["draft"])
        cleared = self.restart([("discard", {})])
        self.assertEqual(cleared["draftGeneration"], before["draftGeneration"] + 1)
        self.assertIsNone(cleared["draft"])
        self.assertEqual(self.restart()["draftGeneration"], cleared["draftGeneration"])
        replaced = self.restart([("draft", {"title": same["draft"]["title"], "diff": same["draft"]["diff"]})])
        self.assertEqual(replaced["draft"], before["draft"])
        self.assertEqual(replaced["draftGeneration"], cleared["draftGeneration"] + 1)
        self.assertEqual(self.restart()["draftGeneration"], replaced["draftGeneration"])
        self.assertEqual([event["outcome"] for event in replaced["history"]], ["Cleared from desk"])

    def test_legacy_draft_and_history_migrate_once_without_fabricating_an_event(self):
        saved = json.loads(self.desk.file.read_text(encoding="utf-8"))
        del saved["draftGeneration"]
        saved["history"] = [{"title": "Previous draft", "base": saved["draft"]["base"], "outcome": "Cleared from desk"}]
        saved["draft"]["comparison"] = {"run": "a" * 32, "base": saved["draft"]["base"]}
        self.desk.file.write_text(json.dumps(saved), encoding="utf-8")
        migrated = self.restart()
        self.assertEqual(migrated["draft"], saved["draft"])
        self.assertEqual(migrated["history"], saved["history"])
        self.assertGreater(migrated["draftGeneration"], self.desk.draft_generation)
        self.assertLess(migrated["draftGeneration"], 2**53)
        on_disk = json.loads(self.desk.file.read_text(encoding="utf-8"))
        self.assertEqual(on_disk["draftGeneration"], migrated["draftGeneration"])
        self.assertEqual(self.restart()["draftGeneration"], migrated["draftGeneration"])

    def test_failed_replace_preserves_draft_generation_and_history_in_memory_and_on_disk(self):
        original = self.desk.state()
        saved_bytes = self.desk.file.read_bytes()
        with patch("server.os.replace", side_effect=OSError("No space")):
            for action, payload in (("discard", {}), ("draft", {"title": "Another", "diff": "another diff"})):
                with self.subTest(action=action), self.assertRaisesRegex(OSError, "No space"):
                    self.desk.act(action, payload)
        self.assertEqual(self.desk.state(), original)
        self.assertEqual(self.desk.file.read_bytes(), saved_bytes)
