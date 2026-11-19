"""Test launcher that records the PID of this desk's own LLP sidecar for restart tests."""
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from live_release import LiveRelease
from vibecheck import main

start = LiveRelease._start


def observed_start(self):
    start(self)
    Path(os.environ["MORPH_TEST_SIDECAR_PID"]).write_text(str(self.process.pid), encoding="ascii")


LiveRelease._start = observed_start
main()
