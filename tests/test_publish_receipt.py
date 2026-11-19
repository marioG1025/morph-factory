"""Exercise exact evidence binding and publication retries without a network or GitHub account."""
from contextlib import redirect_stdout
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import publish_review


class PublishReceipt(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name)
        self.receipt_path = self.repo / "my receipt.json"
        self.branch = "morph/local-review"
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "commit.gpgSign", "false")
        self.git("remote", "add", "origin", "https://github.com/example/product.git")
        self.git("commit", "-qm", "Base", "--allow-empty")
        self.base = self.git("rev-parse", "HEAD")
        self.git("checkout", "-qb", self.branch)
        (self.repo / "feature.txt").write_text("hello\n")
        self.git("add", "feature.txt")
        self.git("commit", "-qm", "Review the change")
        self.commit = self.git("rev-parse", "HEAD")
        self.tree = self.git("rev-parse", "HEAD^{tree}")
        sample = Path(__file__).resolve().parents[1] / "docs/experiments/receipts/vibecheck-calendar.json"
        self.receipt = json.loads(sample.read_text(encoding="utf-8"))
        # The product comparison is a local observation. The checked-in release
        # envelope and server rehearsal retain their original real signatures.
        self.receipt["comparison"].update(base=self.base, candidateTree=self.tree)
        self.receipt["comparison"]["extraPrivateLog"] = "PRIVATE-TEST-SENTINEL"
        self.receipt["extraSession"] = {"token":"PRIVATE-TEST-SENTINEL"}

    def git(self, *args):
        return publish_review.run(self.repo, "git", *args)

    def store(self, value):
        self.receipt_path.write_text(json.dumps(value), encoding="utf-8")

    def preview(self, value):
        self.store(value)
        output = io.StringIO()
        with redirect_stdout(output):
            publish_review.publish(self.repo, self.branch, "main", receipt=self.receipt_path)
        return output.getvalue()

    def test_preview_exports_only_allowlisted_values(self):
        output = self.preview(self.receipt)
        self.assertIn("Local observations", output)
        self.assertIn("| failed | passed | 4 | 0 | 2 | 0 | 0 | 0 |", output)
        self.assertIn(self.base, output)
        self.assertIn(self.tree, output)
        self.assertIn(self.receipt["serverRehearsal"]["manifestDigest"], output)
        for private in ["PRIVATE-TEST-SENTINEL", self.receipt["signedRelease"]["publicKey"]["x"],
                        self.receipt["signedRelease"]["sig"], self.receipt["comparison"]["patchDigest"]]:
            self.assertNotIn(private, output)
        with redirect_stdout(io.StringIO()) as plain:
            publish_review.publish(self.repo, self.branch, "main")
        self.assertNotIn("Comparison evidence", plain.getvalue())

    def test_mismatched_parent_and_candidate_tree(self):
        for key in ["base", "candidateTree"]:
            receipt = copy.deepcopy(self.receipt)
            receipt["comparison"][key] = "0" * 40
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "parent and tree"):
                self.preview(receipt)

    def test_tampered_signed_fields_and_wrong_release_version(self):
        for section in ["manifest", "serverRehearsal", "comparison"]:
            value = copy.deepcopy(self.receipt)
            if section == "manifest":
                value["signedRelease"]["manifest"]["overlap"] = 0
            elif section == "serverRehearsal":
                value[section]["elapsedMs"] += 1
            else:
                value[section]["releaseVersion"] += 1
            with self.subTest(section=section), self.assertRaisesRegex(ValueError, "verification failed"):
                self.preview(value)

    def test_invalid_receipt_stops_confirmed_path_before_remote_access(self):
        value = copy.deepcopy(self.receipt)
        value["comparison"]["candidateTree"] = self.base
        self.store(value)
        with patch.object(publish_review, "run", wraps=publish_review.run) as calls:
            with self.assertRaisesRegex(ValueError, "parent and tree"):
                publish_review.publish(self.repo, self.branch, confirmed=True, receipt=self.receipt_path)
        for call in calls.call_args_list:
            self.assertNotIn("gh", call.args)
            self.assertNotIn("push", call.args)
            self.assertNotIn("ls-remote", call.args)

    def test_missing_sections_status_and_invalid_counts(self):
        for missing in ["signedRelease", "serverRehearsal", "comparison"]:
            value = copy.deepcopy(self.receipt)
            del value[missing]
            with self.subTest(missing=missing), self.assertRaisesRegex(ValueError, "needs a signed"):
                self.preview(value)
        for invalid in [True, -1, 1.5, "4", 2**53, None]:
            value = copy.deepcopy(self.receipt)
            if invalid is None:
                del value["comparison"]["counts"]["fixed"]
            else:
                value["comparison"]["counts"]["fixed"] = invalid
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "integer count"):
                self.preview(value)
        value = copy.deepcopy(self.receipt)
        value["comparison"]["original"] = "private text\n## extra"
        with self.assertRaisesRegex(ValueError, "unknown comparison status"):
            self.preview(value)

    def test_retry_reuses_pushed_commit_and_previews_exact_evidence(self):
        original_run = publish_review.run
        preview = self.preview(self.receipt)
        section = preview[preview.index("## Comparison evidence"):].split("\n\nPreview complete", 1)[0]
        pushes, bodies, prs = [], [], []

        def offline(repo, *args):
            if args[:3] == ("gh", "pr", "list"):
                return json.dumps(prs)
            if args[:3] == ("gh", "pr", "create"):
                body = Path(args[args.index("--body-file") + 1]).read_text(encoding="utf-8")
                bodies.append(body)
                if len(bodies) == 1:
                    raise ValueError("Simulated PR creation interruption")
                prs.append({"isCrossRepository":False, "headRefOid":self.commit, "body":body.replace("\n", "\r\n"),
                            "state":"OPEN", "url":"https://github.com/example/product/pull/1"})
                return prs[0]["url"]
            if args[:2] == ("git", "ls-remote"):
                return self.commit + "\trefs/heads/" + self.branch if pushes else ""
            if args[0] == "git" and "push" in args:
                pushes.append(args)
                return ""
            return original_run(repo, *args)

        def confirm():
            publish_review.publish(self.repo, self.branch, "main", confirmed=True, receipt=self.receipt_path)

        with patch.object(publish_review, "run", side_effect=offline), redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, "interruption"):
                confirm()
            confirm()
            confirm()
            self.assertEqual(len(pushes), 1)
            self.assertEqual(len(bodies), 2)
            self.assertEqual(bodies[0], bodies[1])
            self.assertEqual(bodies[0].split("## Comparison evidence", 1)[1], section.removeprefix("## Comparison evidence") + "\n")
            self.assertNotIn("PRIVATE-TEST-SENTINEL", bodies[0])
            prs[0]["body"] = "An existing independently edited PR"
            with self.assertRaisesRegex(ValueError, "different body"):
                confirm()
