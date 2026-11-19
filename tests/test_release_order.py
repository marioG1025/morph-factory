"""A restore and a completed comparison must commit in the same order in both stores."""
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen

from comparison import draft_digest
from live_release import RUNTIME, node_binary
from server import RequestHandler, open_desk


class ReleaseOrdering(unittest.TestCase):
    def test_http_restore_waits_for_comparison_already_at_its_durable_commit(self):
        try:
            node_binary()
        except ValueError as exc:
            self.skipTest(str(exc))
        if not (RUNTIME / "node_modules/ws/package.json").exists():
            self.skipTest("Install the factory's locked runtime dependency for the live transport tests.")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "product"
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            subprocess.run(["git", "-C", str(repo), "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                            "commit", "-qm", "Initial commit", "--allow-empty"], check=True)
            with open_desk(repo, root / "state", [sys.executable, "-c", "print('checked')"]) as desk:
                base = desk.act("scan", {})["scan"]["head"]
                diff = "--- /dev/null\n+++ b/title.txt\n@@ -0,0 +1 @@\n+Saturday\n"
                desk.act("draft", {"title": "Add calendar day", "diff": diff})
                offer = desk.live.command("candidate")
                desk.live.command("approve", expectedVersion=1, expectedDigest=offer["digest"])
                self.exercise(desk, {"base": base, "digest": draft_digest(diff)})

    def exercise(self, desk, identity):
        at_save = threading.Event()
        restore_attempted = threading.Event()
        order = []
        lock, persist, command = desk.lock, desk.persist, desk.live.command

        class ObservedLock:
            def __enter__(self):
                # The only competing request at this point is the HTTP restore.
                if at_save.is_set():
                    restore_attempted.set()
                return lock.__enter__()

            def __exit__(self, *args):
                return lock.__exit__(*args)

        def pause_before_save(*args, **kwargs):
            at_save.set()
            self.assertTrue(restore_attempted.wait(10))
            persist(*args, **kwargs)
            order.append("saved comparison")

        def observe_command(operation, **fields):
            response = command(operation, **fields)
            if operation == "restore":
                order.append("restored release")
                # An uncoordinated restore crosses the barrier through this path.
                restore_attempted.set()
            return response

        with ThreadingHTTPServer(("127.0.0.1", 0), RequestHandler) as http:
            http.desk = desk
            origin = f"http://127.0.0.1:{http.server_port}"
            def post(path, payload):
                request = Request(origin + "/api/" + path, data=json.dumps(payload).encode(),
                                  headers={"Origin": origin, "Content-Type": "application/json"})
                with urlopen(request, timeout=20) as reply:
                    return json.load(reply)

            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                with patch.object(desk, "lock", ObservedLock()), patch.object(desk, "persist", pause_before_save), \
                     patch.object(desk.live, "command", observe_command), ThreadPoolExecutor(1) as pool:
                    saved = pool.submit(post, "compare", identity)
                    self.assertTrue(at_save.wait(10), "The comparison did not reach its durable commit.")
                    restored = post("live/restore", {"expectedVersion": 2})
                    self.assertEqual(restored["version"], 3)
                    self.assertEqual(saved.result()["releaseVersion"], 2)
            finally:
                http.shutdown()
                thread.join()
        self.assertEqual(order, ["saved comparison", "restored release"])
