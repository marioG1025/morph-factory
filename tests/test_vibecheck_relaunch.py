"""Exercise a second launch against a real HTTP desk with two same-revision checkouts."""
from contextlib import contextmanager
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.request import urlopen

from server import DeskHTTPServer, RequestHandler, git_value, open_desk
import vibecheck


@contextmanager
def serving(desk, handler=RequestHandler):
    with DeskHTTPServer(("127.0.0.1", 0), handler) as http:
        http.desk = desk
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        try:
            yield http.server_port
        finally:
            http.shutdown()
            thread.join()


class VibeCheckRelaunch(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.state = self.root / "review state"
        self.repo = self.state / "examples" / "VibeCheck"
        self.repo.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(["git", "-C", str(self.repo), "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                        "commit", "-qm", "Pinned fixture", "--allow-empty"], check=True)
        self.base = git_value(self.repo, "HEAD")

    def launch(self, port, state, *args):
        argv = ["vibecheck.py", "--port", str(port), "--state-dir", str(state), *map(str,args)]
        with patch.object(sys, "argv", argv), patch.object(vibecheck, "BASE", self.base), \
                patch.object(DeskHTTPServer, "serve_forever", side_effect=AssertionError("Relaunch started another server")):
            vibecheck.main()

    def test_free_fixed_port_does_not_require_an_http_round_trip(self):
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        with patch.object(vibecheck, "HTTPConnection", side_effect=AssertionError("No listener to query")):
            self.assertFalse(vibecheck.matching_listener(port, self.repo, self.state))

    def test_only_exact_checkout_and_state_reopen_in_the_browser(self):
        second_state = self.root / "another state"
        clone = second_state / "examples" / "VibeCheck"
        clone.parent.mkdir(parents=True)
        subprocess.run(["git", "clone", "--quiet", "--no-local", str(self.repo), str(clone)], check=True)
        self.assertEqual(git_value(clone, "HEAD"), self.base)
        with open_desk(self.repo, self.state, None) as desk, serving(desk) as port, patch.object(vibecheck.webbrowser, "open") as opened:
            desk.act("scan", {})
            with urlopen(f"http://127.0.0.1:{port}/api/desk-identity") as reply:
                identity = json.load(reply)
            self.assertEqual(set(identity), {"deskId", "head"})
            self.assertRegex(identity["deskId"], "^[0-9a-f]{64}$")
            self.assertEqual(identity["head"], self.base)
            self.launch(port, self.state)
            self.launch(port, self.state, "--repo", self.repo)
            self.assertEqual(opened.call_count, 2)
            opened.assert_called_with(f"http://127.0.0.1:{port}/")
            opened.reset_mock()
            for state, repo_args in [(second_state, []), (second_state, ["--repo", self.repo]),
                                     (self.state, ["--repo", clone]), (second_state, ["--no-open"])]:
                with self.subTest(state=state, args=repo_args), self.assertRaisesRegex(ValueError, "--port 0"):
                    self.launch(port, state, *repo_args)
            opened.assert_not_called()
            with self.assertRaisesRegex(ValueError, "already running"):
                self.launch(port, self.state, "--no-open")
            opened.assert_not_called()

    def test_older_desk_without_state_identity_is_identified(self):
        class EarlierDesk(RequestHandler):
            def do_GET(self):
                if self.path == "/api/desk-identity":
                    self.send_json({"error":"Unknown resource."}, 404)
                else:
                    super().do_GET()
        with open_desk(self.repo, self.state, None) as desk, serving(desk, EarlierDesk) as port, patch.object(vibecheck.webbrowser, "open") as opened:
            desk.act("scan", {})
            with self.assertRaisesRegex(ValueError, "older.*--port 0"):
                self.launch(port, self.state)
            opened.assert_not_called()
