"""Run a Python project's unittest suite and report named outcomes to Morph Factory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import unittest


class CaseResult(unittest.TextTestResult):
    """Include successes as well as failures, skips and class-fixture errors."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.started = []

    def startTest(self, test):
        super().startTest(test)
        self.started.append(test)

    def case_rows(self):
        outcomes = {test.id(): ("passed", "") for test in self.started}
        # Group subtests under their parent. Rank later entries more severely so
        # a skipped sibling cannot hide a failed assertion in the same method.
        for status, observations in (
            ("skipped", [(test, "Expected failure") for test, _ in self.expectedFailures]),
            ("skipped", self.skipped),
            ("failed", [(test, "Unexpected success") for test in self.unexpectedSuccesses]),
            ("failed", self.failures),
            ("error", self.errors),
        ):
            for test, detail in observations:
                parent = getattr(test, "test_case", test)
                outcomes[parent.id()] = (status, detail.strip()[-360:])
        for name, (status, detail) in outcomes.items():
            key = name if len(name) < 240 else hashlib.sha256(name.encode()).hexdigest()
            yield {"id": "unittest:" + key, "name": name[:256], "status": status, "detail": detail}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start-dir", default=".", help="Directory to discover from (default: current directory)")
    parser.add_argument("--pattern", default="test*.py", help="Test filename pattern")
    args = parser.parse_args()
    # The adapter can live outside the product. Product imports resolve as they
    # would for 'python -m unittest discover' launched from its checkout.
    sys.path.insert(0, str(Path.cwd()))
    suite = unittest.TestLoader().discover(args.start_dir, pattern=args.pattern)
    count = suite.countTestCases()
    result = unittest.TextTestRunner(stream=sys.stdout, resultclass=CaseResult).run(suite)
    discovery = {"id": "unittest.discovery", "name": "unittest discovers at least one test",
                 "status": "passed" if count else "failed", "detail": f"Discovered {count} test(s)."}
    if not count:
        print("No tests discovered. Check --start-dir, --pattern and test package markers.")
    report = os.getenv("MORPH_CASE_REPORT")
    if report:
        rows = [discovery, *result.case_rows()]
        data = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows).encode("utf-8")
        if len(rows) > 1000 or len(data) > 1024 * 1024:
            # The desk bounds the case report. Preserve the overall outcome of
            # large suites and retain unittest's failure details in stdout.
            status = "error" if result.errors else "passed" if result.wasSuccessful() else "failed"
            summary = {"id": "unittest.suite", "name": "Combined test suite", "status": status,
                       "detail": f"Ran {result.testsRun} test(s); full case list exceeds the desk limit."}
            data = (json.dumps(discovery) + "\n" + json.dumps(summary) + "\n").encode("utf-8")
        Path(report).write_bytes(data)
    return 0 if count and result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
