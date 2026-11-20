"""Start a local Morph Factory desk with the verified VibeCheck date repair ready for review."""
import argparse
import errno
from http.client import HTTPConnection, HTTPException
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import webbrowser
from server import DeskHTTPServer, open_desk, RequestHandler, default_state_dir, desk_identity, git_value

BASE = "6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24"
ROOT = Path(__file__).resolve().parent
URL = "https://github.com/marioG1025/VibeCheck.git"


def matching_listener(port, repo, state_dir):
    """Return false for a free port, true for the requested desk, or explain the conflict."""
    # A connection to an unused Windows port can time out instead of returning
    # connection-refused. A successful bind establishes availability without HTTP.
    with DeskHTTPServer(("127.0.0.1", port), RequestHandler, bind_and_activate=False) as probe:
        try:
            probe.server_bind()
            return False
        except OSError as exc:
            if exc.errno not in (errno.EADDRINUSE, errno.EACCES) and getattr(exc, "winerror", None) not in (10048, 10013):
                raise
    hint = f"Stop the listener on port {port} or launch with --port 0 to choose a free port."
    connection = HTTPConnection("127.0.0.1", port, timeout=1.5)
    try:
        connection.request("GET", "/api/desk-identity")
        response = connection.getresponse()
        if response.status == 404 and response.getheader("Server", "").startswith("MorphFactory/"):
            raise ValueError("An older Morph Factory desk cannot confirm its checkout and state directory. " + hint)
        if response.status != 200:
            raise ValueError("The running service could not confirm the requested desk. " + hint)
        try:
            identity = json.loads(response.read(4096))
        except ValueError:
            identity = None
        if not isinstance(identity, dict) or not isinstance(identity.get("deskId"), str):
            raise ValueError("The running service could not confirm the requested desk. " + hint)
    except ConnectionRefusedError:
        return False
    except (OSError, HTTPException) as exc:
        raise ValueError("Could not identify the running service. " + hint) from exc
    finally:
        connection.close()
    root = Path(git_value(repo, "--show-toplevel")) if repo.is_dir() else repo
    if identity["deskId"] != desk_identity(root, state_dir):
        raise ValueError("The running desk uses a different checkout or state directory. " + hint)
    if identity.get("head") != BASE:
        raise ValueError("The running checkout is no longer at the VibeCheck example revision. " + hint)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, help="Existing VibeCheck checkout at the example commit")
    parser.add_argument("--state-dir", type=Path, default=default_state_dir())
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()
    url = f"http://127.0.0.1:{args.port}/"
    repo = args.repo or (args.state_dir / "examples" / "VibeCheck")
    if args.port and matching_listener(args.port, repo, args.state_dir):
        if args.no_open:
            raise ValueError(f"The requested VibeCheck desk is already running at {url}")
        print("Opening the running VibeCheck desk at " + url)
        webbrowser.open(url)
        return
    if args.repo is None and not repo.exists():
        repo.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".morph-setup-", dir=repo.parent) as staging:
            candidate = Path(staging) / "VibeCheck"
            subprocess.run(["git", "clone", "--no-checkout", URL, str(candidate)], check=True)
            subprocess.run(["git", "-C", str(candidate), "checkout", "--detach", BASE], check=True)
            try:
                candidate.rename(repo)
            except OSError:
                if not repo.is_dir():
                    raise
    if git_value(repo, "--verify", "HEAD") != BASE:
        sys.exit("This case file needs VibeCheck at " + BASE + ". Use server.py --repo PATH for any other revision.")
    command = [sys.executable, str(ROOT / "examples/vibecheck/check.py")]
    with open_desk(repo, args.state_dir, command) as desk, DeskHTTPServer(("127.0.0.1", args.port), RequestHandler) as server:
        server.desk = desk
        desk.act("scan", {})
        if not desk.draft:
            desk.act("draft", {"base": BASE, "title": "Keep date-only concerts on the advertised day",
                "diff": (ROOT / "ui/lab/calendar-day.patch").read_text(encoding="utf-8")})
        url = f"http://127.0.0.1:{server.server_port}/"
        print(f"Morph Factory is running at {url}\nReviewing {repo.resolve()}\nPress Ctrl+C to stop.", flush=True)
        if not args.no_open:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass

if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        sys.exit(str(exc))
