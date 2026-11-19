"""Start a local Morph Factory desk with the verified VibeCheck date repair ready for review."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import webbrowser
from urllib.request import urlopen
from server import DeskHTTPServer, open_desk, RequestHandler, default_state_dir, git_value

BASE = "6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24"
ROOT = Path(__file__).resolve().parent
URL = "https://github.com/marioG1025/VibeCheck.git"

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, help="Existing VibeCheck checkout at the example commit")
    parser.add_argument("--state-dir", type=Path, default=default_state_dir())
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()
    url = f"http://127.0.0.1:{args.port}/"
    if args.port and not args.no_open:
        try:
            with urlopen(url + "api/state", timeout=0.8) as reply:
                existing = json.load(reply)
            match = (existing.get("scan") or {}).get("head") == BASE
            if match and (args.repo is None or args.repo.resolve() == Path(existing["repo"]).resolve()):
                print("Opening the running VibeCheck desk at " + url)
                webbrowser.open(url)
                return
        except (OSError, ValueError, KeyError):
            pass
    repo = args.repo or (args.state_dir / "examples" / "VibeCheck")
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
