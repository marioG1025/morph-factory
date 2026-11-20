"""Exercise real JUnit reporters and prevent stale, missing or inconsistent XML from passing."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from comparison import compare_proposal
from head_check import check_head
from live_release import node_binary


RUNNER = Path(__file__).resolve().parents[1] / "scripts/check-junit.py"
COMMAND = [sys.executable, "-B", str(RUNNER), "--report", "junit.xml", "--"]


class JUnitCheck(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name)

    def collect(self, xml=None, exit_code=0):
        script = "import sys; from pathlib import Path; "
        if xml is not None:
            script += "Path('junit.xml').write_text(sys.argv[1],encoding='utf-8'); "
        script += "sys.exit(int(sys.argv[2]))"
        cases = self.folder / "result.jsonl"
        result = subprocess.run([*COMMAND, sys.executable, "-c", script, xml or "", str(exit_code)], cwd=self.folder,
                                env={**os.environ, "MORPH_CASE_REPORT":str(cases)}, capture_output=True, text=True)
        return result.returncode, [json.loads(line) for line in cases.read_text(encoding="utf-8").splitlines()]

    def test_namespaced_nested_duplicates_and_original_exit_status(self):
        xml = """<testsuites xmlns="urn:junit"><testsuite name="outer"><testsuite name="inner">
            <testcase classname="Price" name="total"><skipped message="offline"/></testcase>
            <testcase classname="Price" name="total"><failure message="wrong price">stack</failure></testcase>
            <testcase classname="Price" name="fixture"><error message="setup failed"/></testcase>
            </testsuite></testsuite></testsuites>"""
        code, rows = self.collect(xml, 7)
        self.assertEqual(code, 7)
        self.assertEqual([r["status"] for r in rows], ["skipped","failed","error"])
        self.assertEqual(len({r["id"] for r in rows}), 3)
        self.assertEqual(rows[1]["name"], "outer / inner / Price / total [#2]")
        self.assertEqual(rows[1]["detail"], "wrong price")
        # Changing outcomes and durations keeps each same-name occurrence distinguishable.
        code, passing = self.collect(xml.replace('<failure message="wrong price">stack</failure>', ''))
        self.assertEqual(code, 1, "A tool can exit zero while reporting a fixture error")
        self.assertEqual([r["id"] for r in passing], [r["id"] for r in rows])

    def test_missing_stale_empty_malformed_and_unreported_command_failure(self):
        xml = '<testsuite><testcase name="ok"/></testsuite>'
        code, rows = self.collect()
        self.assertNotEqual(code, 0)
        self.assertIn("fresh", rows[0]["detail"])
        (self.folder / "junit.xml").write_text(xml)
        code, rows = self.collect()
        self.assertNotEqual(code, 0)
        self.assertEqual(rows[0]["status"], "error")
        self.assertEqual((self.folder / "junit.xml").read_text(), xml)
        for bad in ("", "<testsuite>", "<testsuite/>", '<testsuite failures="1"><testcase name="ok"/></testsuite>'):
            with self.subTest(xml=bad):
                code, rows = self.collect(bad)
                self.assertNotEqual(code, 0)
                self.assertEqual(rows[0]["id"], "junit:report")
                self.assertEqual(rows[0]["status"], "error")
        code, rows = self.collect(xml, 9)
        self.assertEqual(code, 9)
        self.assertEqual(rows[-1]["id"], "junit:command")
        self.assertEqual(rows[-1]["status"], "error")
        code, rows = self.collect('<testsuite><testcase name="case"><failure>bad</failure></testcase></testsuite>')
        self.assertEqual(code, 1)
        self.assertEqual(rows[0]["status"], "failed")

    def test_node_builtin_junit_names_survive_real_head_and_candidate_checkouts(self):
        try:
            node = node_binary()
        except ValueError as err:
            self.skipTest(str(err))
        def git(*args):
            return subprocess.check_output(["git", "-C", str(self.folder), *args], text=True).strip()
        git("init", "-q")
        product = self.folder / "price.cjs"
        product.write_text("module.exports = fee => 8;\n", encoding="utf-8")
        (self.folder / "price.test.cjs").write_text("""
const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const total = require('./price.cjs');
describe('Pricing', () => {
  it('charges the fee', () => assert.equal(total(1), 9));
  it('keeps the base price', () => assert.equal(total(0), 8));
});
""", encoding="utf-8")
        git("add", ".")
        git("-c","user.name=Test","-c","user.email=test@example.invalid","commit","-qm","Product fixture")
        base = git("rev-parse", "HEAD")
        command = [*COMMAND,node,"--test","--test-reporter=junit","--test-reporter-destination=junit.xml","price.test.cjs"]
        head = check_head(self.folder, base, command)
        self.assertEqual(head["status"], "failed", head["output"])
        finding, = head["cases"]
        self.assertIn("charges the fee", finding["name"])
        product.write_text("module.exports = fee => 8 + fee;\n", encoding="utf-8")
        diff = git("diff", "--", "price.cjs") + "\n"
        git("restore", "price.cjs")
        report = compare_proposal(self.folder, base, diff, command)
        self.assertEqual(report["baseline"]["status"], "failed", report["baseline"]["output"])
        self.assertEqual(report["candidate"]["status"], "passed", report["candidate"]["output"])
        self.assertEqual([r["id"] for r in report["baseline"]["cases"]], [r["id"] for r in report["candidate"]["cases"]])
        repaired, = [r for r in report["changes"] if r["classification"] == "fixed"]
        self.assertEqual(repaired["id"], finding["id"])
        self.assertEqual(report["summary"]["unchanged"], 1)
        self.assertEqual(git("status","--porcelain"), "")

    def test_large_report_keeps_its_failure_instead_of_passing_truncated_cases(self):
        xml = '<testsuite>' + '<testcase name="ok"/>' * 1000 + '<testcase name="last"><failure/></testcase></testsuite>'
        code, rows = self.collect(xml)
        self.assertEqual(code, 1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], "junit:suite")
        self.assertEqual(rows[0]["status"], "failed")
        self.assertIn("1001", rows[0]["detail"])
