"""The browser entry points must work on a cold, local desk."""
from contextlib import ExitStack
import socket
import threading
import unittest
from unittest.mock import patch
from urllib.request import urlopen

from server import DeskHTTPServer, RequestHandler


class BrowserAssetTypes(unittest.TestCase):
    def test_only_one_listener_owns_the_printed_desk_url(self):
        with DeskHTTPServer(("127.0.0.1", 0), RequestHandler) as original:
            address = original.server_address
            with self.assertRaises(OSError), DeskHTTPServer(address, RequestHandler):
                pass
        with DeskHTTPServer(address, RequestHandler) as reopened:
            self.assertEqual(reopened.server_port, address[1])

    def test_simultaneous_cold_tabs_can_queue_their_initial_requests(self):
        # Model two tabs each opening six HTTP/1 connections before the accept loop drains them.
        with DeskHTTPServer(("127.0.0.1", 0), RequestHandler) as http, ExitStack() as clients:
            for _ in range(12):
                clients.enter_context(socket.create_connection(http.server_address, timeout=2))

    def test_loopback_listener_needs_no_reverse_dns(self):
        with patch("socket.getfqdn", side_effect=AssertionError("Unexpected DNS lookup")):
            with DeskHTTPServer(("127.0.0.1", 0), RequestHandler) as http:
                self.assertEqual(http.server_name, "127.0.0.1")
                self.assertEqual(http.server_port, http.socket.getsockname()[1])
                self.assertGreater(http.server_port, 0)

    def test_bootstrap_assets_override_an_incorrect_system_registration(self):
        routes = {
            "/": "text/html",
            "/style.css": "text/css",
            "/app.js": "text/javascript",
            "/layers/review-client.js": "text/javascript",
            "/vendor/llp/remote-client.mjs": "text/javascript",
            "/layers/review-v1.wasm": "application/wasm",
        }
        with patch("server.mimetypes.guess_type", return_value=("text/plain", None)):
            with DeskHTTPServer(("127.0.0.1", 0), RequestHandler) as http:
                thread = threading.Thread(target=http.serve_forever, daemon=True)
                thread.start()
                try:
                    for path, expected in routes.items():
                        with self.subTest(path=path), urlopen(f"http://127.0.0.1:{http.server_port}{path}", timeout=5) as reply:
                            self.assertEqual(reply.headers.get_content_type(), expected)
                            self.assertEqual(reply.headers["X-Content-Type-Options"], "nosniff")
                finally:
                    http.shutdown()
                    thread.join()
