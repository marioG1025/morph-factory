"""Git invariants that protect the maintainer's current checkout."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import factory
from server import Desk


class LocalReview(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / "music project"
        self.repo.mkdir()
        self.git("init", "--quiet", "-b", "main")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test")
        self.git("config", "core.autocrlf", "false")
        (self.repo / "README.md").write_bytes(b"# Concert guide\n\n```sh\ncd Frontend\n```\n")
        front = self.repo / "apps" / "Frontend"
        front.mkdir(parents=True)
        (front / "index.html").write_bytes(b"<title>Concert guide</title>\n")
        self.git("add", ".")
        self.git("commit", "-qm", "Create example")
        self.draft = factory.inspect_repo(self.repo)["proposal"]

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo).decode().strip()

    def user_state(self):
        return (
            self.git("rev-parse", "HEAD"),
            self.git("branch", "--show-current"),
            self.git("write-tree"),
            self.git("status", "--porcelain=v1"),
            (self.repo / "README.md").read_bytes(),
        )

    def verify(self, command=None):
        return factory.verify_proposal(self.repo, self.draft["base"], self.draft["diff"], command)

    def test_local_review_preserves_pending_work(self):
        (self.repo / "staged.txt").write_bytes(b"staged")
        self.git("add", "staged.txt")
        (self.repo / "README.md").write_bytes(b"the maintainer is editing this")
        (self.repo / "untracked.txt").write_bytes(b"untracked")
        before = self.user_state()
        verification = self.verify([sys.executable, "-c",
            "from pathlib import Path; assert 'cd apps/Frontend' in Path('README.md').read_text()"])
        self.assertTrue(verification["ok"], verification["output"])
        review = factory.create_review_branch(self.repo, **self.draft, verification=verification)
        self.assertEqual(self.user_state(), before)
        self.assertEqual(self.git("rev-parse", review["branch"] + "^"), self.draft["base"])
        self.assertIn("cd apps/Frontend", self.git("show", review["branch"] + ":README.md"))

    def test_failing_project_check_prevents_saving(self):
        result = self.verify([sys.executable, "-c", "print('Date check failed'); raise SystemExit(1)"])
        self.assertFalse(result["ok"])
        self.assertIn("Date check failed", result["output"])
        with self.assertRaises(ValueError):
            factory.create_review_branch(self.repo, **self.draft, verification=result)
        self.assertEqual(self.git("branch", "--list", "morph/*"), "")

    def test_unicode_check_output_on_a_pipe(self):
        result = self.verify([sys.executable, "-c", "print(chr(0x2713) + ' build complete')"])
        self.assertTrue(result["ok"], result["output"])
        self.assertIn("✓ build complete", result["output"])

    def test_new_head_invalidates_receipt(self):
        result = self.verify()
        self.git("commit", "--allow-empty", "-qm", "Advance main")
        with self.assertRaisesRegex(ValueError, "HEAD changed"):
            factory.create_review_branch(self.repo, **self.draft, verification=result)

    def test_verified_patch_cannot_be_substituted(self):
        result = self.verify()
        changed = {**self.draft, "diff": self.draft["diff"].replace("+cd apps/Frontend", "+cd other")}
        with self.assertRaises(ValueError):
            factory.create_review_branch(self.repo, **changed, verification=result)

    def open_draft(self):
        state_dir = Path(self.temp.name) / "desk-state"
        desk = Desk(self.repo, state_dir, None)
        desk.act("scan", {})
        desk.act("draft", {})
        return state_dir, desk

    def test_process_exit_after_git_save_recovers_exactly_one_local_review(self):
        state_dir, desk = self.open_draft()
        (self.repo / "staged.txt").write_bytes(b"pending index")
        self.git("add", "staged.txt")
        (self.repo / "README.md").write_bytes(b"pending readme")
        (self.repo / "notes.txt").write_bytes(b"untracked notes")
        self.git("branch", "morph/other-review", self.draft["base"])
        before = self.user_state()
        script = """
import os, sys
from pathlib import Path
from server import Desk
class InterruptedDesk(Desk):
    def persist(self, draft, outcome=None):
        if outcome == 'Review branch created':
            os._exit(75)
        super().persist(draft, outcome)
desk = InterruptedDesk(Path(sys.argv[1]), Path(sys.argv[2]), None)
receipt = desk.act('verify', {})['draft']['verification']
desk.act('review', {'digest': receipt['digest']})
"""
        interrupted = subprocess.run([sys.executable, "-c", script, str(self.repo), str(state_dir)],
                                     cwd=Path(factory.__file__).parent, timeout=30, capture_output=True)
        self.assertEqual(interrupted.returncode, 75, interrupted.stderr)
        planned = json.loads(desk.file.read_text(encoding="utf-8"))["draft"]["pendingReview"]
        branches = self.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/morph/")
        self.assertIn(f"refs/heads/{planned['branch']} {planned['commit']}", branches)
        resumed = Desk(self.repo, state_dir, None)
        self.assertEqual(resumed.draft["review"], planned)
        for _ in range(2):
            saved = resumed.act("review", {"digest": planned["digest"]})
            self.assertEqual(saved["draft"]["review"], planned)
        self.assertNotIn("pendingReview", saved["draft"])
        self.assertEqual(sum(event["outcome"] == "Review branch created" for event in saved["history"]), 1)
        self.assertEqual(self.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/morph/"), branches)
        self.assertEqual(self.user_state(), before)

    def test_uncreated_or_moved_review_ref_is_never_adopted_or_overwritten(self):
        state_dir, desk = self.open_draft()
        receipt = desk.act("verify", {})["draft"]["verification"]
        git = factory._git

        def interrupt_before_ref(repo, *args, **kwargs):
            if args[0] == "update-ref":
                raise OSError("Interrupted before Git ref creation")
            return git(repo, *args, **kwargs)

        with patch("factory._git", interrupt_before_ref), self.assertRaises(OSError):
            desk.act("review", {"digest": receipt["digest"]})
        planned = desk.draft["pendingReview"]
        self.git("branch", planned["branch"], self.draft["base"])
        resumed = Desk(self.repo, state_dir, None)
        self.assertIsNone(resumed.draft.get("review"))
        self.assertIsNone(resumed.draft.get("verification"))
        with self.assertRaisesRegex(ValueError, "passing verification"):
            resumed.act("review", {"digest": receipt["digest"]})
        self.git("commit", "--allow-empty", "-qm", "Advance main")
        with self.assertRaisesRegex(ValueError, "older commit"):
            resumed.act("review", {"digest": receipt["digest"]})
        self.assertEqual(self.git("rev-parse", planned["branch"]), self.draft["base"])
        self.assertEqual(self.git("branch", "--list", "morph/*").strip(), planned["branch"])


if __name__ == "__main__":
    unittest.main()
