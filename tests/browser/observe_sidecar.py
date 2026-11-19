"""Test launcher for observing a disposable desk and interrupting a single armed notification."""
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

if "MORPH_TEST_NOTICE_DIR" in os.environ:
    import server

    directory = Path(os.environ["MORPH_TEST_NOTICE_DIR"])
    compare = server.compare_proposal
    notify = LiveRelease.comparison_saved

    def count_product_comparison(*args, **kwargs):
        with (directory / "product-comparisons").open("a", encoding="ascii") as counts:
            counts.write("comparison\n")
        return compare(*args, **kwargs)

    def stop_before_notification(self, result):
        armed = directory / "stop-next-notice"
        if armed.exists():
            armed.unlink()
            (directory / "interrupted-run").write_text(result["run"], encoding="ascii")
            # The desk persisted this result before invoking its LLP notifier.
            os._exit(86)
        return notify(self, result)

    server.compare_proposal = count_product_comparison
    LiveRelease.comparison_saved = stop_before_notification

main()
