"""Exercise the standalone unittest adapter as an ordinary product command."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


RUNNER = Path(__file__).resolve().parents[1] / "scripts" / "check-unittest.py"


class UnittestCheck(unittest.TestCase):
    def run_suite(self, folder, *args):
        report = folder / "report.jsonl"
        result = subprocess.run([sys.executable, "-B", str(RUNNER), *args], cwd=folder,
                                env={**os.environ, "MORPH_CASE_REPORT": str(report)},
                                capture_output=True, text=True)
        cases = {row["id"]: row for row in map(json.loads, report.read_text(encoding="utf-8").splitlines())}
        return result, cases

    def test_undiscovered_suite_fails_instead_of_approving_zero_tests(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "tests").mkdir()
            (root / "library.py").write_text("title = 'Example'\n", encoding="utf-8")
            (root / "tests/test_product.py").write_text(
                "import unittest, library\n"
                "class Product(unittest.TestCase):\n"
                "    def test_title(self): self.assertEqual(library.title, 'Example')\n", encoding="utf-8")
            before, rows = self.run_suite(root)
            self.assertNotEqual(before.returncode, 0)
            self.assertEqual(rows["unittest.discovery"]["status"], "failed")
            after, rows = self.run_suite(root, "--start-dir", "tests")
            self.assertEqual(after.returncode, 0, after.stdout + after.stderr)
            self.assertEqual(rows["unittest.discovery"]["status"], "passed")
            self.assertEqual(rows["unittest:test_product.Product.test_title"]["status"], "passed")

    def test_maps_subtest_failures_skips_and_fixture_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "test_product.py").write_text("""
import unittest

class Product(unittest.TestCase):
    def test_checks(self):
        with self.subTest(value=1): self.fail("wrong day")
        with self.subTest(value=2): self.skipTest("unavailable")
    @unittest.skip("offline")
    def test_live(self): pass

class ClassFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls): raise RuntimeError("fixture failed")
    def test_unused(self): pass
""", encoding="utf-8")
            run, rows = self.run_suite(root)
            self.assertNotEqual(run.returncode, 0)
            self.assertIn("wrong day", rows["unittest:test_product.Product.test_checks"]["detail"])
            self.assertEqual(rows["unittest:test_product.Product.test_checks"]["status"], "failed")
            self.assertEqual(rows["unittest:test_product.Product.test_live"]["status"], "skipped")
            self.assertEqual(rows["unittest:setUpClass (test_product.ClassFixture)"]["status"], "error")
            self.assertNotIn("unittest:test_product.ClassFixture.test_unused", rows)
