"""Serve Morph Factory's review desk for one local Git checkout."""

import argparse
import hashlib
import json
import logging
import mimetypes
import os
import re
import secrets
from pathlib import Path, PureWindowsPath
import shutil
import subprocess
import tempfile
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import TCPServer
from datetime import datetime, timezone
from urllib.parse import unquote, urlsplit

from factory import create_review_branch, inspect_repo, review_ref_matches, verify_proposal
from comparison import ComparisonConflict, compare_proposal, draft_digest
from head_check import check_head
from propose import propose
from live_release import LiveRelease, live_get, live_post, take_state_lock


UI = Path(__file__).resolve().parent / "ui"
UI_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".wasm": "application/wasm",
}
MAX_BODY = 1024 * 1024
LOGGER = logging.getLogger("morph")


class DeskHTTPServer(ThreadingHTTPServer):
    # Several fresh browser tabs can request their scripts and styles at once.
    # The five queued connections on Python 3.11 can drop part of the page.
    request_queue_size = 128

    def server_bind(self):
        # The public URL and Host checks use the bound numeric loopback address.
        # A reverse DNS lookup here blocked startup for 35 s on macOS runners.
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


def git_value(repo, *args):
    result = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=10, check=False,
    )
    if result.returncode:
        raise ValueError("Choose a Git working tree with at least one commit.")
    return result.stdout.strip()


def default_state_dir():
    if "LOCALAPPDATA" in os.environ:
        return Path(os.environ["LOCALAPPDATA"]) / "MorphFactory"
    return Path(os.getenv("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "morph-factory"


def checkout_key(repo):
    return hashlib.sha256(os.path.normcase(str(repo)).encode()).hexdigest()


def desk_identity(repo, state_dir):
    paths = [os.path.normcase(str(Path(path).resolve())) for path in (repo, state_dir)]
    return hashlib.sha256(os.fsencode("\0".join(paths))).hexdigest()


@contextmanager
def open_desk(repo, state_dir, command):
    """Hold ownership across draft loading, local writes and release-host restarts."""
    root = Path(git_value(repo, "--show-toplevel")).resolve()
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = state_dir / (checkout_key(root) + ".desk.lock")
    with take_state_lock(path, "This checkout already has a desk using that state directory. "
                         "Open the running desk or select a different --state-dir."):
        desk = Desk(root, state_dir, command)
        try:
            yield desk
        finally:
            desk.close()


def proposal_files(payload):
    if "files" in payload:
        if payload.get("file"):
            raise ValueError("Use either files or the older single file field.")
        paths = payload["files"]
    else:
        legacy = payload.get("file", "")
        paths = [] if isinstance(legacy, str) and not legacy.strip() else [legacy]
    if not isinstance(paths, list) or len(paths) > 4:
        raise ValueError("Attach up to four tracked file paths, one per line.")
    selected = []
    for path in paths:
        if not isinstance(path, str) or not path.strip() or len(path) > 500 or any(c in path for c in "\x00\r\n"):
            raise ValueError("Each attachment needs a repository-relative path of 1–500 characters.")
        path = path.strip().replace("\\", "/")
        if path.startswith("/") or PureWindowsPath(path).drive or ".." in Path(path).parts:
            raise ValueError("Select tracked files within this repository.")
        if path not in selected:
            selected.append(path)
    return selected


class Desk:
    def __init__(self, repo, state_dir, command):
        self.repo = str(Path(git_value(repo, "--show-toplevel")).resolve())
        self.launch_id = desk_identity(self.repo, state_dir)
        git_value(self.repo, "--verify", "HEAD")
        self.command = command
        self.check_key = hashlib.sha256(json.dumps(command).encode()).hexdigest() if command else None
        self.lock = threading.RLock()
        self.agent = {"status": "idle", "message": ""}
        repo_hash = checkout_key(self.repo)
        self.file = state_dir / f"{repo_hash}.json"
        self.live = LiveRelease(state_dir / "llp" / repo_hash)
        self.scan = None
        self.draft = None
        self.verifying = False
        self.draft_generation = 0
        self.history = []
        self.comparing = False
        self._handled_comparison = None
        self._notice_retry = None
        self._closed = False
        self.checking_head = False
        self.head_result = None
        if self.file.exists():
            saved = json.loads(self.file.read_text(encoding="utf-8"))
            if saved.get("version") != 1 or saved.get("repo") != self.repo:
                raise ValueError(f"Unexpected saved draft format in {self.file}")
            self.draft = saved.get("draft")
            self.history = saved.get("history", [])
            legacy = "draftGeneration" not in saved
            if legacy:
                # Older files cannot identify a pre-restart incarnation of the
                # same patch. Allocate a fresh generation once during upgrade.
                self.draft_generation = (1 << 48) + secrets.randbits(48)
            else:
                generation = saved["draftGeneration"]
                if type(generation) is not int or not 0 <= generation < 2**53:
                    raise ValueError(f"Invalid saved draft generation in {self.file}")
                self.draft_generation = generation
            if self.draft and saved.get("check") != self.command:
                self.draft.pop("comparison", None)
            self.recover_review()
            # Receipts are signed in memory by this instance of the verifier.
            if self.draft and not self.draft.get("review"):
                self.draft["verification"] = None
            if legacy:
                self.persist(self.draft)

    def close(self):
        with self.lock:
            self._closed = True
            if self._notice_retry:
                self._notice_retry.cancel()
                self._notice_retry = None
            self.live.close()

    def live_session(self):
        session = self.live.command("session")
        with self.lock:
            # After a restart the saved report may be newer than the host's
            # shared cache. Reconcile before a peer subscribes for its snapshot.
            if self._notice_retry is None:
                self._notify_comparison()
        return session

    def _notify_comparison(self, delay=1):
        # Caller holds the desk lock through the acknowledgement so a replaced
        # draft can never publish its previous run. The host guards its release.
        result = (self.draft or {}).get("comparison") or {}
        run = result.get("run")
        if self._closed or not run or run == self._handled_comparison:
            return
        try:
            self.live.comparison_saved(result)
        except Exception:
            if self._notice_retry is None:
                LOGGER.exception("Comparison saved. Retrying the live notification in %ss.", delay)

                def retry():
                    with self.lock:
                        if self._notice_retry is timer:
                            self._notice_retry = None
                            self._notify_comparison(min(delay * 2, 30))

                timer = threading.Timer(delay, retry)
                timer.daemon = True
                self._notice_retry = timer
                timer.start()
            return
        # A release mismatch is a final response too. Its version cannot recur.
        self._handled_comparison = run
        if self._notice_retry:
            self._notice_retry.cancel()
            self._notice_retry = None

    def _require_comparable_draft(self, payload):
        try:
            release = self.live.require_compare()
        except ValueError as exc:
            raise ComparisonConflict(str(exc)) from exc
        draft = self.draft
        if (not draft or payload.get("base") != draft["base"] or
                payload.get("digest") != draft_digest(draft["diff"]) or
                self.head()["head"] != draft["base"]):
            raise ComparisonConflict("The draft or checkout changed. Reopen the current draft before comparing.")
        return draft, release["version"]

    def compare(self, payload):
        with self.lock:
            draft, version = self._require_comparable_draft(payload)
            generation = self.draft_generation
            if self.comparing:
                raise ComparisonConflict("A comparison is already running for this desk.")
            self.comparing = True
        try:
            result = compare_proposal(self.repo, draft["base"], draft["diff"], self.command)
            with self.lock:
                current, active_version = self._require_comparable_draft(payload)
                if version != active_version or generation != self.draft_generation:
                    raise ComparisonConflict("The draft or live release changed during comparison. Run the current draft again.")
                result["releaseVersion"] = version
                result["run"] = secrets.token_hex(16)
                self.persist({**current, "comparison": result}, "Compared baseline and candidate")
                self._notify_comparison()
            return result
        finally:
            with self.lock:
                self.comparing = False

    def check_current(self, payload, *, watched=False):
        with self.lock:
            generation = self.draft_generation
            if watched and (not self.command or payload.get("checkKey") != self.check_key):
                return {"status": "command-changed"}
            if self.draft or self.agent["status"] == "running" or (watched and payload.get("generation") != generation):
                if watched:
                    return {"status": "occupied"}
                raise ComparisonConflict("Finish the current proposal before checking a new starting point.")
            base = self.head()["head"]
            if payload.get("base") != base:
                if watched:
                    return {"status": "moved"}
                raise ComparisonConflict("The selected commit changed. Rescan and check the current commit.")
            if self.checking_head:
                if watched:
                    return {"status": "running"}
                raise ComparisonConflict("A current-commit check is already running.")
            # A manual click always reruns. Watchers share the current evidence
            # and in-flight slot for this checkout's immutable configured command.
            if watched and self.head_result and self.head_result["base"] == base:
                return {"status": "ready", "state": self.state()}
            self.head_result = None
            self.checking_head = True
        try:
            result = check_head(self.repo, base, self.command)
            with self.lock:
                if generation != self.draft_generation or self.agent["status"] == "running":
                    if watched:
                        return {"status": "occupied"}
                    raise ComparisonConflict("The commit or proposal changed during the check. Run it again.")
                if base != self.head()["head"]:
                    raise ComparisonConflict("The commit changed during the check. Run it again.")
                self.head_result = result
                return {"status": "ready", "state": self.state()} if watched else self.state()
        except ComparisonConflict:
            if watched:
                return {"status": "moved"}
            raise
        finally:
            with self.lock:
                self.checking_head = False

    def require_check_source(self, source):
        result = self.head_result
        if (not isinstance(source, dict) or not result or source.get("run") != result["id"] or
                source.get("base") != result["base"] or result["base"] != self.head()["head"] or
                not any(c["id"] == source.get("case") and c["status"] == "failed" for c in result["cases"])):
            raise ComparisonConflict("This evidence belongs to a different check or commit. Run the current check again.")

    def start_agent(self, port, payload):
        with self.lock:
            if self.agent["status"] == "running":
                raise ValueError("A proposal is already running.")
            if self.draft:
                raise ValueError("Clear the current proposal before asking for another.")
            source = payload.get("checkSource")
            if "checkSource" in payload:
                self.require_check_source(source)
            idea = payload.get("idea")
            if not isinstance(idea, str) or not 1 <= len(idea.strip()) <= 2000:
                raise ValueError("Supply an idea of 1–2,000 characters.")
            files = proposal_files(payload)
            cli = shutil.which("codex")
            if not cli:
                raise ValueError("Install and sign in to the Codex CLI, then restart this desk.")
            self.agent = {"status": "running", "message": "Codex is preparing a patch in a clean checkout."}
            def work():
                try:
                    propose(port, idea, [cli], files, check_source=source)
                    state = {"status": "ready", "message": "Your draft is ready. Review the diff and run checks."}
                except (ValueError, OSError, subprocess.SubprocessError) as exc:
                    state = {"status": "failed", "message": str(exc)}
                except Exception:
                    LOGGER.exception("Proposal job failed")
                    state = {"status": "failed", "message": "The proposal stopped. See the desk log."}
                with self.lock:
                    self.agent = state
            threading.Thread(target=work, daemon=True, name="morph-proposal").start()
            return self.agent.copy()

    def agent_status(self):
        with self.lock:
            return {**self.agent, "available": bool(shutil.which("codex"))}

    def state(self):
        with self.lock:
            return {"repo": self.repo, "scan": self.scan, "draft": self.draft, "check": self.command,
                    "history": self.history, "headCheck": self.head_result, "checkKey": self.check_key,
                    "draftGeneration": self.draft_generation}

    def comparison_for_run(self, run):
        with self.lock:
            draft = self.draft
            result = draft.get("comparison") if draft else None
            if (not result or result.get("run") != run or result.get("base") != draft["base"]
                    or result.get("digest") != draft_digest(draft["diff"])):
                return None
            return {"draftGeneration": self.draft_generation, "comparison": result}

    def head(self):
        with self.lock:
            head = git_value(self.repo, "--verify", "HEAD")
            return {"head": head, "changed": bool(self.scan and self.scan["head"] != head),
                    "draftGeneration": self.draft_generation, "occupied": bool(self.draft or self.agent["status"] == "running"),
                    "checkKey": self.check_key, "checkRun": self.head_result["id"] if self.head_result else None}

    def persist(self, draft, outcome=None, *, replace_draft=False):
        self.file.parent.mkdir(parents=True, exist_ok=True)
        # JavaScript peers compare this number exactly. State and identity must
        # both commit before an observer can see either one.
        generation = (self.draft_generation + int(replace_draft)) % 2**53
        history = self.history
        previous = draft or self.draft
        if outcome and previous:
            event = {"at": datetime.now(timezone.utc).isoformat(), "title": previous["title"],
                     "base": previous["base"], "outcome": outcome}
            if previous.get("review"):
                event["branch"] = previous["review"]["branch"]
            history = [event, *history][:40]
        saved = {"version": 1, "repo": self.repo, "draft": draft, "check": self.command,
                 "history": history, "draftGeneration": generation}
        tmp_name = None
        try:
            with tempfile.NamedTemporaryFile(
                dir=self.file.parent, mode="w", encoding="utf-8", delete=False,
            ) as tmp:
                tmp_name = tmp.name
                json.dump(saved, tmp, ensure_ascii=False)
                tmp.flush()
                os.fsync(tmp.fileno())
            os.replace(tmp_name, self.file)
        finally:
            if tmp_name:
                Path(tmp_name).unlink(missing_ok=True)
        self.draft = draft
        self.history = history
        self.draft_generation = generation

    def make_draft(self, payload):
        if "checkSource" in payload:
            self.require_check_source(payload["checkSource"])
        if payload.get("ifEmpty") and self.draft:
            raise ValueError("A draft already exists. Discard it before creating a new one.")
        if "expectedDraft" in payload:
            current_draft = self.draft
            identity = None if current_draft is None else {
                "base": current_draft["base"], "title": current_draft["title"],
                "digest": hashlib.sha256(current_draft["diff"].encode("utf-8")).hexdigest(),
                "reviewCommit": (current_draft.get("review") or {}).get("commit"),
                "verified": (current_draft.get("verification") or {}).get("ok"),
            }
            if payload["expectedDraft"] != identity:
                raise ValueError("The current draft changed. Review it before replacing it.")
        if not self.scan:
            raise ValueError("Scan this repository before creating a proposal.")
        current = self.scan["head"]
        if self.head()["changed"] or payload.get("base", current) != current:
            raise ValueError("HEAD changed. Scan again and review the new base commit.")
        title = payload.get("title", "")
        diff = payload.get("diff", "")
        if not isinstance(title, str) or not isinstance(diff, str):
            raise ValueError("Title and patch must be text.")
        title = title.strip()
        if not title and not diff.strip():
            proposal = self.scan.get("proposal")
            if not proposal:
                raise ValueError("This scan has no automatic proposal. Supply a title and a unified diff.")
            title, diff = proposal["title"], proposal["diff"]
        if not title or len(title) > 200 or not diff.strip() or "\x00" in diff:
            raise ValueError("Supply a title of 1–200 characters and a nonempty text patch.")
        self.persist({"title": title, "base": current, "diff": diff, "verification": None, "review": None},
                     replace_draft=True)
        self.head_result = None

    def recover_review(self):
        if not self.draft or "pendingReview" not in self.draft:
            return
        draft = self.draft.copy()
        planned = draft.pop("pendingReview")
        if review_ref_matches(self.repo, draft["base"], draft["diff"], planned):
            self.persist({**draft, "review": planned}, "Review branch created")
        else:
            # The transaction never created this ref, or someone moved it afterwards.
            # Recovery only observes Git. A new ref still requires in-session verification.
            self.persist(draft)

    def act(self, action, payload):
        if action == "check-head":
            return self.check_current(payload)
        if action == "watch-check":
            return self.check_current(payload, watched=True)
        if action == "verify":
            return self.verify_current(payload)
        with self.lock:
            self.recover_review()
            if action == "scan":
                if payload.get("ifChanged") is True and self.scan and self.scan["head"] == self.head()["head"]:
                    return self.state()
                self.scan = inspect_repo(self.repo)
                if self.head_result and self.head_result["base"] != self.scan["head"]:
                    self.head_result = None
            elif action == "draft":
                self.make_draft(payload)
            elif action == "discard":
                self.check_expected_patch(payload)
                self.persist(None, "Cleared from desk", replace_draft=True)
            elif not self.draft:
                raise ValueError("Create a proposal first.")
            elif self.draft.get("review"):
                if action == "review" and payload.get("digest") == self.draft["review"]["digest"]:
                    return self.state()
                raise ValueError("This proposal already has a review branch.")
            elif self.head()["head"] != self.draft["base"]:
                raise ValueError("The draft targets an older commit. Scan again and prepare a new draft.")
            elif action == "review":
                receipt = self.draft.get("verification")
                if not receipt or not receipt.get("ok"):
                    raise ValueError("A passing verification is required for this patch.")
                if not payload.get("digest") or payload["digest"] != receipt["digest"]:
                    raise ValueError("The verified patch changed. Refresh and review it again.")
                draft = self.draft
                review = create_review_branch(self.repo, draft["base"], draft["diff"], draft["title"], receipt,
                                              before_create=lambda plan: self.persist({**draft, "pendingReview": plan}))
                self.persist({**draft, "review": review}, "Review branch created")
            return self.state()

    def check_expected_patch(self, payload):
        if "expectedPatch" not in payload:
            return
        identity = None if self.draft is None else {
            "base": self.draft["base"], "digest": hashlib.sha256(self.draft["diff"].encode()).hexdigest()}
        if payload["expectedPatch"] != identity:
            raise ValueError("The open draft has changed. Refresh the desk and try again.")

    def verify_current(self, payload):
        with self.lock:
            self.recover_review()
            self.check_expected_patch(payload)
            if self.verifying:
                raise ValueError("A verification is already running for this checkout.")
            if not self.draft or self.draft.get("review"):
                raise ValueError("Choose an open draft to verify.")
            if self.head()["head"] != self.draft["base"]:
                raise ValueError("The draft targets an older commit. Scan and prepare a new draft.")
            snapshot = {**self.draft, "verification": None}
            self.persist(snapshot)
            generation = self.draft_generation
            self.verifying = True
        try:
            # Keep the desk responsive to a live release or another tab while a project builds.
            receipt = verify_proposal(self.repo, snapshot["base"], snapshot["diff"], self.command)
            with self.lock:
                if self.draft_generation != generation:
                    raise ValueError("This draft changed during verification. Its results were discarded.")
                if self.head()["head"] != snapshot["base"]:
                    raise ValueError("The checkout changed during verification. Scan the new commit and prepare a fresh draft.")
                self.persist({**self.draft, "verification": receipt},
                             "Checks passed" if receipt["ok"] else "Checks failed")
                return self.state()
        finally:
            with self.lock:
                self.verifying = False


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "MorphFactory/1"

    def respond(self, status, data, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, value, status=200):
        self.respond(status, json.dumps(value, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def valid_host(self):
        port = self.server.server_port
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if port == 80:
            hosts.update(("localhost", "127.0.0.1"))
        if self.headers.get("Host") not in hosts:
            self.send_json({"error": "Use the local address printed by the server."}, 403)
            return False
        return True

    def do_GET(self):
        if not self.valid_host():
            return
        path = unquote(urlsplit(self.path).path)
        if live_get(self, path):
            return
        if path == "/api/agent/status":
            self.send_json(self.server.desk.agent_status())
            return
        if path == "/api/state":
            self.send_json(self.server.desk.state())
            return
        if path == "/api/desk-identity":
            desk = self.server.desk
            try:
                self.send_json({"deskId":desk.launch_id, "head":git_value(desk.repo, "--verify", "HEAD")})
            except (OSError, ValueError, subprocess.SubprocessError) as exc:
                self.send_json({"error":str(exc)}, 400)
            return
        match = re.fullmatch(r"/api/comparisons/([0-9a-f]{32})", path)
        if match:
            origin = self.headers.get("Origin")
            if origin is not None and origin != f"http://{self.headers['Host']}":
                self.send_json({"error": "Open the local desk to read a comparison."}, 403)
                return
            report = self.server.desk.comparison_for_run(match[1])
            if report is None:
                self.send_json({"error": "This run is no longer the current draft's comparison."}, 404)
            else:
                self.send_json(report)
            return
        if path == "/api/head":
            try:
                self.send_json(self.server.desk.head())
            except (OSError, ValueError, subprocess.SubprocessError) as exc:
                self.send_json({"error": str(exc)}, 400)
            return
        if path.startswith("/api/") or "\x00" in path or "\\" in path or ":" in path:
            self.send_json({"error": "Unknown resource."}, 404)
            return
        asset = (UI / (path.lstrip("/") or "index.html")).resolve()
        if not asset.is_relative_to(UI) or not asset.is_file():
            self.send_json({"error": "Unknown resource."}, 404)
            return
        # A Windows registry override can label JavaScript as text/plain. Browsers
        # require the correct MIME types to execute our scripts and styles.
        content_type = UI_CONTENT_TYPES.get(asset.suffix.lower()) or mimetypes.guess_type(asset)[0]
        self.respond(200, asset.read_bytes(), content_type or "application/octet-stream")

    def do_POST(self):
        if not self.valid_host():
            return
        if self.headers.get("Origin") != f"http://{self.headers['Host']}":
            self.send_json({"error": "Open the local desk to perform this action."}, 403)
            return
        route = urlsplit(self.path).path
        if route not in {"/api/scan", "/api/draft", "/api/verify", "/api/review", "/api/discard", "/api/agent",
                         "/api/compare", "/api/check-head", "/api/watch-check", "/api/live/approve", "/api/live/restore"}:
            self.send_json({"error": "Unknown action."}, 404)
            return
        if self.headers.get_content_type() != "application/json":
            self.send_json({"error": "Send a JSON object."}, 415)
            return
        try:
            size = int(self.headers.get("Content-Length", "-1"))
            if size < 0 or size > MAX_BODY or "Transfer-Encoding" in self.headers:
                self.send_json({"error": "Supply a JSON body of at most 1 MiB."}, 413)
                return
            payload = json.loads(self.rfile.read(size).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("Expected a JSON object.")
            if route.startswith("/api/live/"):
                live_post(self, route, payload)
                return
            if route == "/api/compare":
                self.send_json(self.server.desk.compare(payload))
                return
            if route == "/api/agent":
                self.send_json(self.server.desk.start_agent(self.server.server_port, payload), 202)
                return
            self.send_json(self.server.desk.act(route[5:], payload))
        except ComparisonConflict as exc:
            self.send_json({"error": str(exc)}, 409)
        except (ValueError, OSError, subprocess.SubprocessError) as exc:
            self.send_json({"error": str(exc)}, 400)
        except Exception:
            LOGGER.exception("Could not complete %s", route)
            self.send_json({"error": "The action failed. Check the server log for details."}, 500)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True, help="Git working tree to inspect")
    parser.add_argument("--port", type=int, default=8765, help="Local server port (default 8765)")
    parser.add_argument("--state-dir", type=Path, default=default_state_dir(), help="Directory for saved drafts")
    parser.add_argument("--check", nargs=argparse.REMAINDER, metavar="ARG", help="Final option: verification command and its arguments")
    args = parser.parse_args()
    if args.check == []:
        parser.error("--check requires a program, optionally followed by arguments.")
    if not 0 <= args.port <= 65535:
        parser.error("Port must be between 0 and 65535.")
    try:
        with open_desk(args.repo, args.state_dir, args.check) as desk:
            with DeskHTTPServer(("127.0.0.1", args.port), RequestHandler) as server:
                server.desk = desk
                print(f"Morph Factory at http://127.0.0.1:{server.server_port}/ reviewing {desk.repo}", flush=True)
                server.serve_forever()
    except KeyboardInterrupt:
        pass
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        parser.exit(1, f"Could not start Morph Factory: {exc}\n")


if __name__ == "__main__":
    main()
