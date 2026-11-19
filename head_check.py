"""Observe a configured project check on one committed tree before a patch exists."""
from datetime import datetime, timezone
from pathlib import Path
import re
import tempfile
import uuid

from comparison import ComparisonConflict, _checkout, _run_check
from factory import _check_base, _root


def _unittest_output(command, output):
    """Recognize stdlib unittest's text output for plain CLI users."""
    binary = Path(command[0]).stem.lower()
    if not re.fullmatch(r"python(?:\d+(?:\.\d+)*)?|py", binary):
        return None
    if not any(command[i:i + 2] == ["-m", "unittest"] for i in range(1, len(command) - 1)):
        return None
    output = output.replace("\r\n", "\n")
    total = re.search(r"^Ran (\d+) tests? in ", output, flags=re.MULTILINE)
    if not total:
        return None
    cases = []
    for match in re.finditer(r"^(FAIL|ERROR): ([^\n]+)\n(?:[^\n]*\n)?-{5,}\n(.*?)(?=\n(?:={5,}|-{5,})\n|\Z)",
                             output, flags=re.MULTILINE | re.DOTALL):
        kind, title, detail = match.groups()
        cases.append({"id": "unittest:" + str(len(cases)), "name": title[:256],
                      "status": "failed" if kind == "FAIL" else "error", "detail": detail.strip()[-600:]})
    return int(total[1]), cases


def check_head(repo, base, command, *, timeout=120):
    if not command:
        raise ValueError("Start the desk with --check followed by your trusted project command.")
    repo = _root(repo)
    def check_commit():
        try:
            _check_base(repo, base)
        except ValueError as exc:
            raise ComparisonConflict("The checked commit changed. Check the current commit again.") from exc
    check_commit()
    with tempfile.TemporaryDirectory(prefix="morph-head-", ignore_cleanup_errors=True) as tmp:
        root = Path(tmp)
        checkout = root / "head"
        _checkout(repo, base, checkout)
        report = root / "cases.jsonl"
        result = _run_check(command, checkout, None, report, timeout)
        report_size = report.stat().st_size if report.exists() else None
    check_commit()
    cases = result["cases"]
    # A disposable directory vanishes after the run. Repository-relative paths
    # are more useful in a copied proposal and omit the operator's temp path.
    result["output"] = result["output"].replace(str(checkout), ".")
    for case in cases:
        case["detail"] = case["detail"].replace(str(checkout), ".")
    unstructured = report_size in (None, 0) and len(cases) == 1 and cases[0]["id"] == "command"
    status = result["status"]
    label = {"passed": "Project check passed.", "failed": "Project check failed.",
             "error": "The check could not complete.", "skipped": "No applicable tests ran."}[status]
    if unstructured:
        parsed = _unittest_output(command, result["output"]) if status in ("passed", "failed") else None
        if parsed is not None:
            count, named = parsed
            if count == 0 and not named:
                status, label = "empty", "unittest discovered zero tests. Check the discovery directory or pattern."
            elif count and re.search(r"^OK \(skipped=" + str(count) + r"\)\s*$", result["output"], re.MULTILINE):
                status, label = "skipped", "All discovered tests were skipped."
            if named:
                cases = named
                unstructured = False
                if result["exitCode"] != 0 and all(case["status"] == "error" for case in cases):
                    status, label = "error", "The test run reported an error."
        if unstructured and status == "failed":
            status, label = "unclassified", "The command exited unsuccessfully. Inspect its output for the cause."
        elif unstructured and status == "passed":
            label = "Configured command completed successfully."
            if report_size == 0:
                status, label = "empty", "The command returned an empty case report."
    elif any(case["id"] == "unittest.discovery" and case["status"] == "failed" for case in cases):
        status, label = "empty", "unittest discovered zero tests. Check the discovery directory or pattern."
    elif any(case["id"] == "unittest.discovery" for case in cases):
        tests = [case for case in cases if case["id"] != "unittest.discovery"]
        if tests and all(case["status"] == "skipped" for case in tests):
            status, label = "skipped", "All discovered tests were skipped."
    failing = [case for case in cases if case["status"] == "failed" and case["name"] != "Check completion"
               ] if status not in ("empty", "unclassified") else []
    errors = [case for case in cases if case["status"] == "error"]
    # Only named failures can prefill a proposal. Keep diagnostics and evidence
    # local, bounded and explicitly tied to the run the operator inspected.
    evidence = [{**case, "detail": case["detail"][-600:]} for case in (failing + errors)[:12]]
    return {"id": uuid.uuid4().hex, "base": base, "at": datetime.now(timezone.utc).isoformat(),
            "status": status, "label": label, "failed": len(failing), "errors": len(errors),
            "cases": evidence, "output": result["output"][-2400:], "durationMs": result["durationMs"],
            "exitCode": result["exitCode"]}
