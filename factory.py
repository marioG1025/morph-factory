"""Inspect a Git revision, verify a proposed patch, and create a local review branch."""

import argparse
import ast
import difflib
import hashlib
import hmac
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import subprocess
import sys
import tempfile
import tomllib


_receipt_key = secrets.token_bytes(32)
_git_options = ["-c", f"core.hooksPath={os.devnull}", "-c", "core.autocrlf=false",
                "-c", "core.fsmonitor=false", "-c", "gc.auto=0"]


def _run(args, cwd, data=None, env=None, timeout=120):
    try:
        run = subprocess.run(args, cwd=cwd, input=data, capture_output=True, env=env,
                             timeout=timeout, shell=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError(str(exc)) from exc
    if run.returncode:
        # Test runners often print the failing cases to stdout and a wrapper error
        # to stderr. Keep both so the reviewer can see which behavior failed.
        detail = b"\n".join(part for part in (run.stdout, run.stderr) if part).decode("utf-8", "replace").strip()
        raise ValueError(detail[-4000:] or f"{args[0]} exited {run.returncode}")
    return run.stdout


def _git(repo, *args, data=None, index=None):
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("GIT_")}
    env.update(GIT_TERMINAL_PROMPT="0", GIT_NO_REPLACE_OBJECTS="1",
               GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", GIT_OPTIONAL_LOCKS="0")
    if index is not None:
        env["GIT_INDEX_FILE"] = str(index)
    return _run(["git", *_git_options, *args], repo, data, env)


def _root(repo):
    path = Path(repo).expanduser().resolve(strict=True)
    return Path(_git(path, "rev-parse", "--show-toplevel").decode().rstrip())


def _head(repo):
    return _git(repo, "rev-parse", "--verify", "HEAD^{commit}").decode().strip()


def _check_base(repo, base):
    if base != _head(repo):
        raise ValueError("The checkout's HEAD changed. Rescan and verify the patch against the new commit.")


def _paths(repo, base):
    rows = _git(repo, "ls-tree", "-r", "-z", base).decode("utf-8", "surrogateescape")
    return {row.split("\t", 1)[1] for row in rows.rstrip("\0").split("\0")
            if row.startswith(("100644 blob ", "100755 blob "))}


def _read(repo, spec):
    return _git(repo, "show", spec).decode("utf-8", "replace")


def _markdown_paths(files):
    return sorted(p for p in files if "/" not in p and
                  p.lower() in {"readme.md", "quickstart.md", "getting_started.md", "setup.md"})


def _inspect_rules(repo, base):
    files = _paths(repo, base)
    directories = {str(parent) for path in files for parent in PurePosixPath(path).parents}
    findings, changes, checks = [], [], []
    for doc in _markdown_paths(files):
        original = _read(repo, f"{base}:{doc}")
        lines = original.splitlines(keepends=True)
        for i, line in enumerate(lines):
            match = re.fullmatch(r"cd ([\w.-]+)[ \t]*(?:\r?\n)?", line)
            if match and match[1] not in directories:
                candidates = sorted(d for d in directories if PurePosixPath(d).name == match[1])
                if len(candidates) == 1 and re.fullmatch(r"[\w./-]+", candidates[0]):
                    dest = candidates[0]
                    findings.append(dict(id=f"setup:{doc}:{i+1}", kind="Setup path",
                        title=f"Correct the setup path for {match[1]}", path=doc, line=i+1,
                        evidence=f"From the repository root, '{line.strip()}' fails. The tracked directory is {dest}."))
                    lines[i] = line.replace(match[1], dest, 1)
                    checks.append(("directory", doc, i+1, dest))
            match = re.match(r"^\| `(test/[\w./-]+\.mjs)` \| (\d+) (?:tests|checks)\b", line)
            if not match or match[1] not in files:
                continue
            path, count = match.groups()
            labels = re.findall(r'^check\("[A-Z]+(\d+)\s', _read(repo, f"{base}:{path}"), re.M)
            n = len(labels)
            confirmed = re.search(r"`node " + re.escape(path) + r"` \(" + str(n) + r" checks\b", original)
            if n and list(map(int, labels)) == list(range(1, n+1)) and int(count) != n and confirmed:
                findings.append(dict(id=f"count:{doc}:{i+1}", kind="Documentation drift",
                    title=f"Update the test count for {path}", path=doc, line=i+1,
                    evidence=f"The table lists {count}. {path} has {n} numbered checks, matching the detailed test instructions."))
                lines[i] = line[:match.start(2)] + str(n) + line[match.end(2):]
                checks.append(("count", doc, i+1, path))
        changes.extend(difflib.unified_diff(original.splitlines(True), lines,
                                            fromfile=f"a/{doc}", tofile=f"b/{doc}"))
    return findings, "".join(changes), checks


def inspect_repo(repo):
    repo = _root(repo)
    base = _head(repo)
    findings, diff, _ = _inspect_rules(repo, base)
    # Use Git's tracked snapshot; local edits and untracked files never enter the evidence.
    try:
        rows = _git(repo, "grep", "-n", "-I", "-E", "-m", "2", "TODO[:( ]|FIXME[:( ]",
                    base, "--", "*.ts", "*.js", "*.py", "*.go", "*.rs").decode("utf-8", "replace")
    except ValueError as exc:
        if not str(exc).endswith("exited 1"):
            raise
        rows = ""
    for row in rows.splitlines()[:12]:
        hit = re.match(re.escape(base) + r":(.+?):(\d+):(.*)", row)
        if hit:
            path, line, snippet = hit.groups()
            findings.append(dict(id=f"note:{path}:{line}", kind="Source note", path=path,
                line=int(line), title="Review a maintainer's source note", evidence=snippet.strip()[:300]))
    proposal = None
    if diff:
        kinds = {f["kind"] for f in findings if f["kind"] != "Source note"}
        title = ("Correct setup paths in project documentation" if kinds == {"Setup path"} else
                 "Correct documented test counts" if kinds == {"Documentation drift"} else
                 "Correct project setup and test documentation")
        proposal = dict(title=title, base=base, diff=diff)
    return dict(repo=str(repo), head=base,
                branch=_git(repo, "branch", "--show-current").decode().strip() or "(detached)",
                dirty=bool(_git(repo, "status", "--porcelain", "--ignore-submodules=all")),
                findings=findings, proposal=proposal)


def _fingerprint(base, diff):
    if not isinstance(diff, str) or not diff.strip():
        raise ValueError("Supply a nonempty unified Git diff.")
    data = diff.encode("utf-8")
    if len(data) > 2_000_000:
        raise ValueError("Patch exceeds the 2 MB local review limit.")
    return hashlib.sha256(base.encode() + b"\0" + data).hexdigest()


def _validate_files(clone, files):
    checked = []
    for name in files:
        suffix = PurePosixPath(name).suffix.lower()
        if suffix not in {".json", ".py", ".toml"}:
            continue
        # Read the staged Git blob instead of following working-tree symlinks.
        mode = _git(clone, "ls-files", "--stage", "--", name)
        if not mode.startswith((b"100644 ", b"100755 ")):
            continue
        content = _read(clone, f":{name}")
        if suffix == ".json":
            json.loads(content)
        elif suffix == ".toml":
            tomllib.loads(content)
        else:
            ast.parse(content, filename=name)
        checked.append(f"Parsed {name}")
    return checked


def _seal(repo, record):
    payload = [str(repo.resolve()), {k: v for k, v in record.items() if k != "receipt"}]
    return hmac.digest(_receipt_key, json.dumps(payload, sort_keys=True).encode(), "sha256").hex()


def verify_proposal(repo, base, diff, command=None):
    repo = _root(repo)
    _check_base(repo, base)
    digest = _fingerprint(base, diff)
    if command is not None and (not isinstance(command, list) or not command or
                                not all(isinstance(arg, str) and arg for arg in command)):
        raise ValueError("A trusted verification command must be a nonempty argument list.")
    result = dict(ok=False, base=base, digest=digest, files=[], verification="", output="")
    with tempfile.TemporaryDirectory(prefix="morph-verify-", ignore_cleanup_errors=True) as tmp:
        clone = Path(tmp) / "candidate"
        try:
            _git(tmp, "clone", "--quiet", "--no-checkout", "--no-hardlinks", "--template=",
                 "--", str(repo), str(clone))
            _git(clone, "checkout", "--quiet", "--detach", base)
            patch = diff.encode()
            _git(clone, "apply", "--check", "--index", "--whitespace=nowarn", "-", data=patch)
            _git(clone, "apply", "--index", "--whitespace=nowarn", "-", data=patch)
            raw = _git(clone, "diff", "--cached", "--name-only", "--no-renames", "-z")
            result["files"] = raw.decode("utf-8", "replace").rstrip("\0").split("\0") if raw else []
            if not result["files"]:
                raise ValueError("The patch produced no changes.")
            _git(clone, "diff", "--cached", "--check")
            notes = ["Patch applies to pinned HEAD. Git whitespace check passed."]
            notes.extend(_validate_files(clone, result["files"]))
            _, generated, checks = _inspect_rules(repo, base)
            if diff == generated:
                for kind, doc, number, target in checks:
                    line = _read(clone, f":{doc}").splitlines()[number - 1]
                    if kind == "directory":
                        if line.strip() != f"cd {target}" or not (clone / target).is_dir():
                            raise ValueError(f"{doc}:{number}: setup directory check failed")
                        notes.append(f"{doc}:{number} — {line.strip()} resolves from checkout root.")
                    else:
                        n = len(re.findall(r'^check\("[A-Z]+\d+\s', _read(clone, f":{target}"), re.M))
                        if not re.search(r"\| " + str(n) + r" (tests|checks)\b", line):
                            raise ValueError(f"{doc}:{number}: test inventory check failed")
                        notes.append(f"{doc}:{number} — table matches {n} numbered checks in {target}.")
            result["tree"] = _git(clone, "write-tree").decode().strip()
            if command:
                # This is a disposable checkout, not an OS sandbox. The caller supplies trusted argv.
                env = {k: v for k, v in os.environ.items() if not k.upper().startswith("GIT_")}
                env.pop("MORPH_CASE_REPORT", None)
                env.update(PYTHONIOENCODING="utf-8", MORPH_CHECK_SCOPE="patch",
                           MORPH_CHANGED_PATHS=json.dumps(result["files"], ensure_ascii=True))
                result["output"] = _run(command, clone, env=env).decode("utf-8", "replace")[-6000:]
                notes.append("Trusted verification command passed: " + subprocess.list2cmdline(command))
            else:
                notes.append("No project test command was requested.")
            _check_base(repo, base)
            result.update(ok=True, verification="\n".join(notes))
            result["receipt"] = _seal(repo, result)
        except (ValueError, SyntaxError, OSError) as exc:
            result.update(ok=False, verification="Verification failed.", output=str(exc))
    return result


def review_ref_matches(repo, base, diff, review):
    """Look up only the exact branch/commit in an interrupted desk save."""
    digest = _fingerprint(base, diff)
    if (not isinstance(review, dict) or review.get("base") != base or review.get("digest") != digest or
            not re.fullmatch(r"morph/[a-z0-9-]+-" + digest[:8] + r"-[a-f0-9]{16}", str(review.get("branch"))) or
            not re.fullmatch(r"(?:[a-f0-9]{40}|[a-f0-9]{64})", str(review.get("commit")))):
        raise ValueError("The pending review record does not match this draft.")
    ref = "refs/heads/" + review["branch"]
    rows = _git(repo, "for-each-ref", "--format=%(refname) %(objectname)", ref).decode().splitlines()
    return f"{ref} {review['commit']}" in rows


def create_review_branch(repo, base, diff, title, verification, *, before_create=None):
    repo = _root(repo)
    _check_base(repo, base)
    digest = _fingerprint(base, diff)
    if (not isinstance(verification, dict) or not verification.get("ok") or
            verification.get("digest") != digest or verification.get("base") != base or
            not hmac.compare_digest(str(verification.get("receipt", "")), _seal(repo, verification))):
        raise ValueError("Verify these exact patch bytes in this session before creating a branch.")
    title = " ".join(str(title).split())[:150]
    if not title:
        raise ValueError("A review branch needs a title.")
    with tempfile.TemporaryDirectory(prefix="morph-index-") as tmp:
        index = Path(tmp) / "review-index"
        _git(repo, "read-tree", base, index=index)
        _git(repo, "apply", "--cached", "--whitespace=nowarn", "-", data=diff.encode(), index=index)
        tree = _git(repo, "write-tree", index=index).decode().strip()
        if tree != verification["tree"]:
            raise ValueError("Candidate tree no longer matches the verified tree.")
        commit = _git(repo, "-c", "user.name=Morph Factory", "-c", "user.email=morph@localhost",
                      "-c", "commit.gpgSign=false", "commit-tree", tree, "-p", base, "-F", "-",
                      data=(title + "\n").encode()).decode().strip()
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:44] or "change"
    suffix = secrets.token_hex(8 if before_create else 2)
    branch = f"morph/{slug}-{digest[:8]}-{suffix}"
    review = dict(branch=branch, commit=commit, base=base, digest=digest)
    if before_create is not None:
        before_create(review)
    # Both predicates are checked while Git holds the ref locks. The main index is never touched.
    transaction = f"start\nverify HEAD {base}\ncreate refs/heads/{branch} {commit}\nprepare\ncommit\n"
    _git(repo, "update-ref", "--stdin", data=transaction.encode())
    return review


def _cli():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("action", choices=["inspect", "verify", "branch"])
    cli.add_argument("repo")
    cli.add_argument("--patch", type=Path, help="Use a UTF-8 unified diff instead of the suggested patch.")
    cli.add_argument("--base", help="Expected full HEAD hash for a supplied diff.")
    cli.add_argument("--title", default="Review proposed change")
    cli.add_argument("--check", nargs=argparse.REMAINDER, help="Trusted command and arguments to run in the temporary checkout.")
    args = cli.parse_args()
    info = inspect_repo(args.repo)
    if args.action == "inspect":
        return info
    if args.patch:
        if not args.base:
            raise ValueError("--patch requires --base to pin the intended revision.")
        proposal = dict(base=args.base, diff=args.patch.read_bytes().decode("utf-8"), title=args.title)
    else:
        proposal = info["proposal"]
        if not proposal:
            raise ValueError("No automatic patch. Supply --patch and --base.")
    result = verify_proposal(args.repo, proposal["base"], proposal["diff"], args.check)
    if args.action == "branch" and result["ok"]:
        result["review"] = create_review_branch(args.repo, **proposal, verification=result)
    return result


if __name__ == "__main__":
    try:
        outcome = _cli()
        print(json.dumps(outcome, indent=2))
        sys.exit(0 if outcome.get("ok", True) else 1)
    except (ValueError, OSError) as error:
        sys.exit(str(error))
