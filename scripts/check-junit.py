"""Run a trusted project command and turn its fresh JUnit XML report into named Morph cases."""
import argparse
from collections import Counter
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET


@contextmanager
def fresh_report(path):
    # A committed report, even one with a recent timestamp, cannot serve as evidence
    # for this execution. Restore the original if the reporter produces no replacement.
    if not path.exists():
        yield
        return
    if not path.is_file():
        raise ValueError("The JUnit report path must name a file.")
    with tempfile.TemporaryDirectory(prefix=".morph-junit-", dir=path.parent) as directory:
        previous = Path(directory) / "previous"
        path.replace(previous)
        try:
            yield
        finally:
            if not path.exists():
                previous.replace(path)


def case_rows(path):
    root = ET.parse(path).getroot()
    prefix = Path.cwd().resolve().as_posix().rstrip("/") + "/"

    def label(value):
        text = (value or "").strip()
        path_text = text.replace("\\", "/") if os.name == "nt" else text
        return path_text[len(prefix):] if os.path.normcase(path_text).startswith(os.path.normcase(prefix)) else text

    def tag(el):
        return el.tag.rsplit("}", 1)[-1]

    if tag(root) not in ("testsuite", "testsuites"):
        raise ValueError("Expected a JUnit testsuite or testsuites root element.")
    rows, occurrences = [], Counter()

    def visit(el, suites):
        if tag(el) == "testcase":
            name = label(el.get("name"))
            if not name:
                raise ValueError("A JUnit testcase is missing its name.")
            classname = label(el.get("classname"))
            filename = label(el.get("file")).replace("\\", "/")
            identity = (suites, classname, filename, name)
            occurrences[identity] += 1
            ordinal = occurrences[identity]
            key = hashlib.sha256(json.dumps([identity, ordinal], ensure_ascii=False).encode()).hexdigest()
            group = suites + ((classname,) if classname and classname not in suites[-1:] else ())
            if filename and filename not in group:
                group = (filename, *group)
            suffix = f" [#{ordinal}]" if ordinal > 1 else ""
            display = " / ".join((*group, name))[:256-len(suffix)] + suffix
            status = {"failure":"failed", "failed":"failed", "error":"error", "notrun":"skipped",
                      "skipped":"skipped", "disabled":"skipped"}.get(el.get("status", "").lower(), "passed")
            detail = ""
            children = {tag(child):child for child in el}
            for kind, outcome in (("error", "error"), ("failure", "failed"), ("skipped", "skipped")):
                if kind in children:
                    node = children[kind]
                    status = outcome
                    detail = (node.get("message") or "".join(node.itertext()) or node.get("type") or "").strip()[:600]
                    break
            rows.append({"id":"junit:" + key, "name":display, "status":status, "detail":detail})
            return
        suite = label(el.get("name"))
        nested = suites + ((suite,) if suite else ())
        first = len(rows)
        for child in el:
            if tag(child) in ("testcase", "testsuite", "testsuites"):
                visit(child, nested)
        counts = Counter(row["status"] for row in rows[first:])
        for field, status in (("failures","failed"), ("errors","error")):
            if int(el.get(field, "0")) > counts[status]:
                raise ValueError(f"Suite {suite or '(root)'} reports {field} without matching testcase outcomes.")

    visit(root, ())
    if not rows:
        raise ValueError("The JUnit report contains no testcases.")
    return rows


def emit(rows, destination):
    encoded = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows).encode()
    if len(rows) > 1000 or len(encoded) > 1024*1024:
        counts = Counter(row["status"] for row in rows)
        status = next(kind for kind in ("error","failed","passed","skipped") if counts[kind])
        summary = {"id":"junit:suite", "name":"JUnit suite totals", "status":status,
                   "detail":f"{len(rows)} rows exceeded the desk’s named-case limit. " + str(dict(counts))}
        encoded = (json.dumps(summary) + "\n").encode()
    if destination:
        Path(destination).write_bytes(encoded)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True, type=Path, help="JUnit XML written inside the project checkout")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("Supply the project command after --.")
    destination = os.environ.get("MORPH_CASE_REPORT")
    exit_code = 0
    try:
        path = args.report.resolve()
        if not path.is_relative_to(Path.cwd().resolve()) or args.report.is_symlink():
            raise ValueError("Select a JUnit report file inside the current project checkout.")
        env = os.environ.copy()
        env.pop("MORPH_CASE_REPORT", None)
        with fresh_report(path):
            exit_code = subprocess.run(command, env=env).returncode
            if not path.is_file():
                raise ValueError("The project command did not create a fresh JUnit XML report.")
            rows = case_rows(path)
        if exit_code and all(row["status"] not in ("failed", "error") for row in rows):
            rows.append({"id":"junit:command", "name":"JUnit command completion", "status":"error",
                         "detail":f"The command exited {exit_code} without a matching JUnit failure."})
    except (OSError, ValueError, ET.ParseError, RecursionError) as exc:
        rows = [{"id":"junit:report", "name":"JUnit report collection", "status":"error", "detail":str(exc)[:600]}]
    for row in rows:
        if row["status"] in ("error", "failed"):
            print(row["name"] + ": " + row["detail"], file=sys.stderr)
    emit(rows, destination)
    if exit_code:
        return exit_code if exit_code > 0 else 128 - exit_code
    return int(any(row["status"] in ("failed", "error") for row in rows))


if __name__ == "__main__":
    sys.exit(main())
