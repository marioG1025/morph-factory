"""Two HTTP servers must not write the same checkout's saved review concurrently."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from server import open_desk


class DeskOwnership(unittest.TestCase):
    def test_second_launcher_cannot_replace_the_active_draft(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / "product"
            state = root / "state"
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            subprocess.run(["git", "-C", str(repo), "-c", "user.name=Test", "-c",
                            "user.email=test@example.invalid", "commit", "-q", "--allow-empty",
                            "-m", "Initial commit"], check=True)
            with open_desk(repo, state, None) as owner:
                owner.act("scan", {})
                owner.act("draft", {"title":"Active draft", "diff":"pending draft"})
                before = owner.file.read_bytes()
                launch = Path(__file__).resolve().parents[1] / "server.py"
                other = subprocess.run([sys.executable, str(launch), "--repo", str(repo),
                                        "--state-dir", str(state), "--port", "0"],
                                       capture_output=True, text=True, timeout=10)
                self.assertNotEqual(other.returncode, 0)
                self.assertIn("already has a desk", other.stderr)
                self.assertEqual(owner.file.read_bytes(), before)
                with open_desk(repo, root / "independent-state", None) as separate:
                    self.assertIsNone(separate.draft)
            with open_desk(repo, state, None) as reopened:
                self.assertEqual(reopened.draft["title"], "Active draft")
