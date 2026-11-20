"""Both launchers should diagnose invalid ports before opening a repository."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class LauncherArguments(unittest.TestCase):
    def rejected_port(self, launcher, port):
        with tempfile.TemporaryDirectory() as tmp:
            command = [sys.executable, str(ROOT / launcher), "--port", str(port),
                       "--state-dir", tmp, "--repo", str(Path(tmp) / "missing")]
            if launcher == "vibecheck.py":
                command.append("--no-open")
            result = subprocess.run(command, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("Port must be between 0 and 65535.", result.stderr)

    def test_demo_rejects_negative_port(self):
        self.rejected_port("vibecheck.py", -1)

    def test_demo_rejects_port_above_range(self):
        self.rejected_port("vibecheck.py", 65536)

    def test_generic_desk_rejects_negative_port(self):
        self.rejected_port("server.py", -1)

    def test_generic_desk_rejects_port_above_range(self):
        self.rejected_port("server.py", 65536)
