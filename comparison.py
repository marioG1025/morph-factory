"""Run one operator-selected check on a pinned base and its exact proposed tree."""

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

from factory import _check_base, _fingerprint, _git, _root


class ComparisonConflict(ValueError):
    """The release, checkout or open draft no longer matches the request."""


def draft_digest(diff):
    return hashlib.sha256(diff.encode("utf-8")).hexdigest()


def _checkout(source, base, directory):
    _git(directory.parent, "clone", "--quiet", "--no-checkout", "--no-hardlinks",
         "--template=", "--", str(source), str(directory))
    _git(directory, "checkout", "--quiet", "--detach", base)


def _read_cases(report):
    if not report.exists():
        return []
    if report.stat().st_size > 1024 * 1024:
        raise ValueError("Case report exceeds 1 MiB.")
    seen, cases = set(), []
    for line in report.read_text(encoding="utf-8").splitlines():
        entry = json.loads(line)
        if not isinstance(entry, dict):
            raise ValueError("Each report line must be a JSON object.")
        key, name, status = (entry.get(field) for field in ("id", "name", "status"))
        if (not isinstance(key, str) or not 0 < len(key) <= 256 or key in seen or
                not isinstance(name, str) or not 0 < len(name) <= 256 or
                status not in ("passed", "failed", "error", "skipped")):
            raise ValueError("Case ids must be unique and each case needs a name and valid status.")
        detail = entry.get("detail", "")
        if not isinstance(detail, str) or len(cases) >= 1000:
            raise ValueError("Invalid case detail or too many cases (maximum 1,000).")
        seen.add(key)
        cases.append({"id": key, "name": name, "status": status, "detail": detail[:1200]})
    return cases


def _run_check(command, cwd, files, report, timeout):
    started = time.monotonic()
    # Repository selection must come from cwd; an inherited GIT_INDEX_FILE or
    # GIT_WORK_TREE would make a check observe the caller's working copy.
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("GIT_")}
    env.update(MORPH_CASE_REPORT=str(report), PYTHONIOENCODING="utf-8",
               MORPH_CHECK_SCOPE="head" if files is None else "patch")
    if files is None:
        env.pop("MORPH_CHANGED_PATHS", None)
    else:
        env["MORPH_CHANGED_PATHS"] = json.dumps(files, ensure_ascii=True)
    kwargs = {"start_new_session": True} if os.name != "nt" else {
        "creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW}
    problem, exit_code = None, None
    with tempfile.TemporaryFile() as log:
        try:
            with subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                  stdout=log, stderr=subprocess.STDOUT, **kwargs) as proc:
                try:
                    exit_code = proc.wait(timeout)
                except subprocess.TimeoutExpired:
                    if os.name == "nt":
                        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                                       capture_output=True, check=False)
                    else:
                        os.killpg(proc.pid, signal.SIGKILL)
                    if proc.poll() is None:
                        proc.kill()
                    proc.wait()
                    problem = f"Check timed out after {timeout:g} seconds."
        except OSError as exc:
            problem = f"Could not run the configured check: {exc}"
        size = log.seek(0, os.SEEK_END)
        log.seek(max(0, size - 12_000))
        output = log.read().decode("utf-8", errors="replace")
        if size > 12_000:
            output = "… earlier output omitted …\n" + output
    try:
        cases = _read_cases(report)
    except (UnicodeError, ValueError, OSError) as exc:
        cases, problem = [], f"The check produced an unreadable case report: {exc}"
    statuses = {item["status"] for item in cases}
    if problem or "error" in statuses:
        status = "error"
    elif exit_code != 0 or "failed" in statuses:
        status = "failed"
    elif statuses == {"skipped"}:
        status = "skipped"
    else:
        status = "passed"
    if problem:
        output = (output + "\n" + problem).strip()
    if not cases:
        cases = [{"id": "command", "name": "Configured project check", "status": status,
                  "detail": problem or f"Process exited with code {exit_code}."}]
    elif status in ("error", "failed") and status not in statuses:
        # E.g. a runner crashes after emitting its first few passing records.
        run_id = "command"
        while any(case["id"] == run_id for case in cases):
            run_id += "-exit"
        cases.append({"id": run_id, "name": "Check completion", "status": status,
                      "detail": problem or f"Process exited with code {exit_code}."})
    return {"status": status, "exitCode": exit_code, "output": output,
            "durationMs": round((time.monotonic() - started) * 1000), "cases": cases,
            "passed": sum(c["status"] == "passed" for c in cases),
            "failed": sum(c["status"] == "failed" for c in cases)}


def _changes(baseline, candidate):
    before = {case["id"]: case for case in baseline["cases"]}
    after = {case["id"]: case for case in candidate["cases"]}
    summary = dict(fixed=0, regressed=0, unchanged=0, added=0, removed=0, inconclusive=0)
    changes = []
    for key in dict.fromkeys([*before, *after]):
        old = before.get(key, {}).get("status")
        new = after.get(key, {}).get("status")
        if "error" in (old, new) or "skipped" in (old, new):
            classification = "inconclusive"
        elif old is None:
            classification = "added"
        elif new is None:
            classification = "removed"
        elif old == new:
            classification = "unchanged"
        else:
            classification = "fixed" if new == "passed" else "regressed"
        changes.append({"id": key, "name": (after.get(key) or before[key])["name"], "before": old,
                        "after": new, "classification": classification})
        summary[classification] += 1
    return changes, summary


def compare_proposal(repo, base, diff, command, *, timeout=120):
    """Compare observed check outcomes; leave the caller's ref, index and files alone."""
    repo = _root(repo)
    _check_base(repo, base)
    _fingerprint(base, diff)  # Same patch-size and validity rules as the verifier.
    if not command or not isinstance(command, list) or not all(isinstance(v, str) and v for v in command):
        raise ValueError("Configure a trusted project check with --check to compare two revisions.")
    with tempfile.TemporaryDirectory(prefix="morph-compare-", ignore_cleanup_errors=True) as tmp:
        root = Path(tmp)
        original, patched = root / "baseline", root / "candidate"
        _checkout(repo, base, original)
        _checkout(repo, base, patched)
        _git(patched, "apply", "--index", "--whitespace=nowarn", "-", data=diff.encode("utf-8"))
        paths = _git(patched, "diff", "--cached", "--name-only", "--no-renames", "-z")
        files = paths.decode("utf-8", "surrogateescape").rstrip("\0").split("\0") if paths else []
        if not files:
            raise ValueError("The proposed patch did not change any tracked files.")
        tree = _git(patched, "write-tree").decode().strip()
        baseline = _run_check(command, original, files, root / "baseline.jsonl", timeout)
        candidate = _run_check(command, patched, files, root / "candidate.jsonl", timeout)
    _check_base(repo, base)
    changes, summary = _changes(baseline, candidate)
    if {baseline["status"], candidate["status"]} & {"error", "skipped"}:
        conclusion = "Inconclusive. Inspect the check output on each side."
    elif candidate["status"] == "failed":
        conclusion = "The proposed change still has a failing check."
    elif summary["fixed"]:
        conclusion = f"{summary['fixed']} previously failing check(s) now pass."
    elif baseline["status"] == "passed":
        conclusion = "Both revisions pass the configured check."
    else:
        conclusion = "The candidate passes. Review the case differences before attributing the change."
    return {"base": base, "digest": draft_digest(diff), "candidateTree": tree,
            "at": datetime.now(timezone.utc).isoformat(), "files": files, "command": list(command),
            "baseline": baseline, "candidate": candidate, "changes": changes,
            "summary": summary, "conclusion": conclusion}
