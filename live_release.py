"""Bridge the local Python review desk to the signed LLP server host over stdio."""
import atexit
import base64
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import threading


RUNTIME = Path(__file__).resolve().parent / "runtime"
BROWSER_MODULES = {"llp-core.js", "fleet.js", "remote-client.mjs"}
SETUP_TIMEOUT = 90
HOST_TIMEOUT = 20
_install_lock = threading.Lock()


def node_binary():
    override = os.environ.get("MORPH_NODE")
    bundle = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
    candidates = [override] if override else [shutil.which("node"), bundle / ("node.exe" if os.name == "nt" else "node")]
    for path in candidates:
        if not path or not Path(path).is_file():
            continue
        output = subprocess.run([str(path), "--version"], capture_output=True, text=True, timeout=5)
        match = re.match(r"v(\d+)\.", output.stdout)
        if output.returncode == 0 and match and int(match[1]) >= 22:
            return str(path)
    raise ValueError("The live review layer requires Node.js 22+. Install Node or set MORPH_NODE to its executable.")


def ensure_dependencies():
    # The desk uses a checked-in lockfile. No repository or model-generated packages are installed here.
    with _install_lock:
        required = json.loads((RUNTIME / "package.json").read_text(encoding="utf-8"))["dependencies"]["ws"]
        manifest = RUNTIME / "node_modules/ws/package.json"
        if manifest.is_file() and json.loads(manifest.read_text(encoding="utf-8"))["version"] == required:
            return
        npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
        hint = "Run npm ci --prefix runtime --omit=dev --ignore-scripts from the Morph Factory folder."
        if not npm:
            raise ValueError("The live review host needs its locked WebSocket dependency. " + hint)
        result = subprocess.run([npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
                                cwd=RUNTIME, capture_output=True, timeout=SETUP_TIMEOUT)
        if result.returncode:
            raise ValueError("Could not install the locked WebSocket dependency. " + hint)


def take_state_lock(path, busy_message):
    # An OS-held lock is released automatically when the Python process exits.
    file = path.open("a+b")
    try:
        if os.name == "nt":
            import msvcrt
            if not path.stat().st_size:
                file.write(b"0")
                file.flush()
            file.seek(0)
            msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return file
    except OSError as exc:
        file.close()
        raise ValueError(busy_message) from exc


class LiveRelease:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.lock = threading.RLock()
        self.process = None
        self.ownership = None
        self.responses = None
        self.registered = False

    def _start(self):
        node = node_binary()
        ensure_dependencies()
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.ownership = take_state_lock(self.directory / "host.lock",
            "Another desk owns this live state. Open that desk or choose a different --state-dir.")
        try:
            process = subprocess.Popen([node, str(RUNTIME / "review-host.mjs"), str(self.directory)],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       encoding="utf-8", text=True, bufsize=1)
        except OSError:
            self.ownership.close()
            self.ownership = None
            raise
        answers = queue.Queue()
        def read_messages():
            try:
                for line in process.stdout:
                    answers.put(line)
            finally:
                answers.put(None)
        threading.Thread(target=read_messages, daemon=True, name="morph-live-host").start()
        self.process, self.responses = process, answers
        if not self.registered:
            atexit.register(self.close)
            self.registered = True

    def close(self):
        with self.lock:
            process, self.process = self.process, None
            if process is not None:
                try:
                    process.stdin.close()
                except OSError:
                    pass
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                process.stdout.close()
            if self.ownership is not None:
                self.ownership.close()
                self.ownership = None

    def command(self, op, **fields):
        with self.lock:
            if self.process is None or self.process.poll() is not None:
                self.close()
                self._start()
            try:
                self.process.stdin.write(json.dumps({**fields, "op": op}, ensure_ascii=True) + "\n")
                self.process.stdin.flush()
                line = self.responses.get(timeout=HOST_TIMEOUT)
                if line is None:
                    raise OSError("The LLP server host exited unexpectedly. See the desk log.")
                reply = json.loads(line)
            except (OSError, queue.Empty, json.JSONDecodeError) as exc:
                self.close()
                raise ValueError("The LLP server host is unavailable. Retry to restore its signed release.") from exc
            if not reply.get("ok"):
                if reply.get("restart"):
                    self.close()
                raise ValueError(reply.get("error") or "The LLP server refused the operation.")
            return reply["result"]

    def require_compare(self):
        return self.command("requireCompare")


def live_get(handler, path):
    if path.startswith("/vendor/llp/"):
        name = path.removeprefix("/vendor/llp/")
        if name in BROWSER_MODULES:
            handler.respond(200, (RUNTIME / "vendor/llp" / name).read_bytes(), "text/javascript; charset=utf-8")
        else:
            handler.send_json({"error": "Unknown module."}, 404)
        return True
    if not path.startswith("/api/live/"):
        return False
    resource = path.removeprefix("/api/live/")
    try:
        if resource in {"session", "status", "candidate", "evidence"}:
            handler.send_json(handler.server.desk.live.command(resource))
        elif re.fullmatch(r"blob/[a-f0-9]{64}", resource):
            data = handler.server.desk.live.command("blob", hash=resource.split("/")[1])
            handler.respond(200, base64.b64decode(data["data"], validate=True), "application/wasm")
        else:
            handler.send_json({"error": "Unknown live-host resource."}, 404)
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        handler.send_json({"error": str(exc)}, 503)
    return True


def live_post(handler, route, data):
    op = route.rsplit("/", 1)[-1]
    if op not in {"approve", "restore"}:
        raise ValueError("Unknown release operation.")
    if type(data.get("expectedVersion")) is not int:
        raise ValueError("Choose the current release before approving this change.")
    params = {"expectedVersion": data["expectedVersion"]}
    if op == "approve":
        digest = data.get("expectedDigest")
        if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("Rehearse the candidate to approve its exact signed manifest.")
        params["expectedDigest"] = digest
    handler.send_json(handler.server.desk.live.command(op, **params))
