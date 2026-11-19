"""Git invariants that protect the maintainer's current checkout."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import factory


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


if __name__ == "__main__":
    unittest.main()
