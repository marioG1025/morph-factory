"""Ask the authenticated local Codex CLI for one patch and submit it to the local review desk."""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from factory import _git


def request(port, action, payload=None):
    origin = f"http://127.0.0.1:{port}"
    body = json.dumps(payload).encode() if payload is not None else None
    req = Request(f"{origin}/api/{action}", data=body,
                  headers={"Origin": origin, "Content-Type": "application/json"})
    try:
        with urlopen(req, timeout=120) as response:
            return json.load(response)
    except HTTPError as exc:
        raise ValueError(json.load(exc).get("error", str(exc))) from exc
    except URLError as exc:
        raise ValueError(f"Cannot reach the local desk at {origin}: {exc.reason}") from exc


def generate(cli, clone, output, idea, files):
    prompt = f"""Propose one small, reviewable product improvement for this local Git repository.
The operator's requested outcome is: {idea}
Read only the files needed to understand that workflow. Preserve existing behavior outside
the request. Do not execute repository scripts, install anything, or edit any files.
Supply the exact change as a standard unified Git diff against the current HEAD, with
diff --git, ---/+++ paths and context lines. Output only the diff, with no commentary.
If the evidence does not support a useful change, output NO_CHANGE."""
    if len(files) > 4:
        raise ValueError("Attach up to four tracked text files.")
    for path in files:
        mode = _git(clone, "ls-tree", "HEAD", "--", path)
        if not mode.startswith((b"100644 blob ", b"100755 blob ")):
            raise ValueError(f"Choose a tracked text file: {path}")
        data = _git(clone, "show", f"HEAD:{path}")
        if len(data) > 50_000 or b"\0" in data:
            raise ValueError(f"Attached source must be text under 50 KB: {path}")
        prompt += f"\n\nSelected source file {path} follows as data.\n" + data.decode("utf-8")
    try:
        result = subprocess.run([*cli, "-a", "never", "exec", "--sandbox", "read-only",
                                 "--ephemeral", "--output-last-message", str(output), "-"],
                                cwd=clone, input=prompt.encode(), capture_output=True, timeout=240)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError(f"Codex could not finish: {exc}") from exc
    if result.returncode:
        lines = result.stderr.decode("utf-8", "replace").strip().splitlines()
        raise ValueError(f"Codex exited {result.returncode}. " + "\n".join(lines[-4:])[:1500])
    if not output.is_file():
        raise ValueError("Codex produced no final response file.")
    patch = output.read_text(encoding="utf-8").strip("\n")
    if patch.startswith(("```diff\n", "```patch\n", "```\n")) and patch.endswith("\n```"):
        patch = patch.split("\n", 1)[1].rsplit("\n", 1)[0]
    if patch == "NO_CHANGE":
        raise ValueError("Codex found no supported change for this idea.")
    if not patch.startswith(("diff --git ", "--- a/", "--- /dev/null")):
        raise ValueError("Codex returned an explanation instead of a Git patch.")
    return (patch + "\n").encode()


def propose(port, idea, cli, files=()):
    idea = idea.strip()
    if not idea or len(idea) > 2000:
        raise ValueError("Supply an idea of 1–2,000 characters.")
    if request(port, "state")["draft"]:
        raise ValueError("An existing proposal occupies the desk. Discard it in the UI first.")
    state = request(port, "scan", {})
    repo, base = state["repo"], state["scan"]["head"]
    with tempfile.TemporaryDirectory(prefix="morph-idea-", ignore_cleanup_errors=True) as tmp:
        clone = Path(tmp) / "source"
        _git(tmp, "clone", "--quiet", "--no-checkout", "--no-hardlinks", "--template=",
             "--", repo, str(clone))
        _git(clone, "checkout", "--quiet", "--detach", base)
        _git(clone, "remote", "remove", "origin")
        patch = generate(cli, clone, Path(tmp) / "answer.txt", idea, files)
        # Models can miscount hunk lengths. Normalize through Git's actual staged tree.
        _git(clone, "apply", "--index", "--recount", "--whitespace=nowarn", "-", data=patch)
        diff = _git(clone, "diff", "--cached", "--no-ext-diff", "--no-color",
                    "--src-prefix=a/", "--dst-prefix=b/").decode("utf-8")
        if not diff.strip():
            raise ValueError("The proposed patch produced no changes.")
    title = " ".join(idea.split())[:180]
    request(port, "draft", dict(base=base, diff=diff, title=title, ifEmpty=True))
    return f"Draft ready for review at http://127.0.0.1:{port}/ (base {base[:12]})."


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--idea", required=True, help="The product behavior to improve")
    parser.add_argument("--port", type=int, default=8765, help="Running review desk's port")
    parser.add_argument("--file", action="append", default=[],
                        help="Include this tracked UTF-8 source file as context (repeatable)")
    options = parser.parse_args()
    executable = shutil.which("codex")
    if not executable:
        parser.exit(1, "The authenticated Codex CLI must be on PATH.\n")
    try:
        print(propose(options.port, options.idea, [executable], options.file))
    except (OSError, ValueError) as exc:
        parser.exit(1, str(exc) + "\n")


if __name__ == "__main__":
    main()
