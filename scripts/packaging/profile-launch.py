"""Profile a packaged VibeCheck launch through listener readiness using an isolated state."""
import argparse
import cProfile
from http.server import ThreadingHTTPServer
from pathlib import Path
import pstats
import sys
import tempfile
from unittest.mock import patch


def measure():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[2],
                        help="Extracted factory directory to run")
    args = parser.parse_args()
    sys.path.insert(0, str(args.source.resolve()))
    import vibecheck

    with tempfile.TemporaryDirectory(prefix="morph-launch-profile-") as scratch:
        argv = ["vibecheck.py", "--port", "0", "--no-open", "--state-dir", scratch]
        for sample in ("First launch", "Restart from saved state"):
            with patch.object(sys, "argv", argv), patch.object(ThreadingHTTPServer, "serve_forever") as ready:
                profiler = cProfile.Profile()
                profiler.runcall(vibecheck.main)
                ready.assert_called_once()
            print(sample, flush=True)
            pstats.Stats(profiler).strip_dirs().sort_stats("cumulative").print_stats(18)


if __name__ == "__main__":
    measure()
