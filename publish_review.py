"""Preview or explicitly publish an existing local Morph review branch as a GitHub draft PR."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

from live_release import node_binary


COUNT_FIELDS = ("fixed", "regressed", "unchanged", "added", "removed", "inconclusive")
STATUSES = ("passed", "failed", "error", "skipped")
VERIFIER = Path(__file__).resolve().parent / "scripts" / "inspect-receipt.mjs"


def run(repo, *args):
    child = subprocess.run(args, cwd=repo, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=120,
                           env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GH_PROMPT_DISABLED": "1"})
    if child.returncode:
        raise ValueError((child.stderr or child.stdout).strip()[-2000:])
    return child.stdout.strip()


def github_repo(remote):
    pattern = r"(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)([\w.-]+/[\w.-]+)/?"
    match = re.fullmatch(pattern, remote, flags=re.ASCII)
    if not match:
        raise ValueError("origin must resolve to a single github.com SSH or HTTPS repository URL")
    name = match[1].removesuffix(".git")
    if any(part in {".", "..", ""} for part in name.split("/")):
        raise ValueError("Invalid GitHub owner/repository path.")
    return name


def receipt_evidence(repo, commit, receipt_path):
    raw = Path(receipt_path).expanduser().read_bytes()
    receipt = json.loads(raw)
    if not isinstance(receipt, dict):
        raise ValueError("Expected an exported Morph Factory experiment receipt.")
    comparison = receipt.get("comparison")
    proof = receipt.get("serverRehearsal")
    signed = receipt.get("signedRelease")
    if not all(isinstance(section, dict) for section in (comparison, proof, signed)):
        raise ValueError("The receipt needs a signed release, a server rehearsal and comparison evidence.")
    # The CLI verifies the exact bytes from which the PR text is derived. Replacing
    # the input file while signature verification is running cannot mix two receipts.
    with tempfile.TemporaryDirectory(prefix="morph-pr-receipt-") as tmp:
        snapshot = Path(tmp) / "receipt.json"
        snapshot.write_bytes(raw)
        result = subprocess.run([node_binary(), str(VERIFIER), str(snapshot)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        if result.returncode:
            raise ValueError("Receipt verification failed. Check the signed release, rehearsal and comparison version.")
    manifest = signed["manifest"]
    digest = proof.get("manifestDigest")
    if (manifest.get("x-morph-release") != "compare" or proof.get("release") != "compare"
            or not isinstance(digest, str) or not re.fullmatch("[0-9a-f]{64}", digest)):
        raise ValueError("The receipt must cover the signed Compare release and its passing server rehearsal.")
    checks = proof.get("checks")
    if not isinstance(checks, list) or not any(
        isinstance(check, dict) and check.get("operation") == "compare" and check.get("ok") is True
        and check.get("expected") == "allowed" and check.get("actual") == "allowed" for check in checks
    ):
        raise ValueError("The signed server rehearsal must have successfully authorized comparison.")
    tree, *parents = run(repo, "git", "--no-replace-objects", "show", "-s", "--format=%T %P", commit).split()
    if len(parents) != 1 or comparison.get("base") != parents[0] or comparison.get("candidateTree") != tree:
        raise ValueError("The comparison base and candidate tree must exactly match this review commit’s parent and tree.")
    original, candidate = comparison.get("original"), comparison.get("candidate")
    if original not in STATUSES or candidate not in STATUSES:
        raise ValueError("The receipt has an unknown comparison status.")
    counts = comparison.get("counts")
    if not isinstance(counts, dict) or any(type(counts.get(field)) is not int or
            not 0 <= counts[field] <= 2**53 - 1 for field in COUNT_FIELDS):
        raise ValueError("The comparison needs a nonnegative integer count for every outcome.")
    table = ("| Original | Candidate | Fixed | Regressed | Unchanged | Added | Removed | Inconclusive |\n"
             "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |\n")
    row = "| " + " | ".join([original, candidate, *(str(counts[field]) for field in COUNT_FIELDS)]) + " |"
    return ("## Comparison evidence\n\nLocal observations from running the product check on both revisions.\n\n"
            + table + row + f"\n\n- Base commit `{parents[0]}`\n- Candidate tree `{tree}`\n"
            f"- Release manifest SHA-256 `{digest}`\n\n"
            "The factory verified the release and server rehearsal signatures with the public key in the receipt.")


def publish(repo, branch, base=None, confirmed=False, receipt=None):
    repo = Path(repo).expanduser().resolve(strict=True)
    if not branch.startswith("morph/"):
        raise ValueError("Select an existing local morph/ review branch.")
    run(repo, "git", "check-ref-format", "--branch", branch)
    commit = run(repo, "git", "rev-parse", "--verify", f"refs/heads/{branch}^{{commit}}")
    evidence = receipt_evidence(repo, commit, receipt) if receipt is not None else ""
    title = run(repo, "git", "show", "-s", "--format=%s", commit)
    origin = github_repo(run(repo, "git", "remote", "get-url", "--all", "origin"))
    destination = github_repo(run(repo, "git", "remote", "get-url", "--push", "--all", "origin"))
    if destination.casefold() != origin.casefold():
        raise ValueError("origin must fetch from and push to the same GitHub repository.")
    if not base:
        try:
            local = run(repo, "git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
            base = local.removeprefix("origin/")
        except ValueError:
            if confirmed:
                base = run(repo, "gh", "repo", "view", "github.com/" + origin, "--json",
                           "defaultBranchRef", "--jq", ".defaultBranchRef.name")
    if base:
        run(repo, "git", "check-ref-format", "--branch", base)
    if base == branch:
        raise ValueError("The base and head branch must differ.")
    print(f"Destination: https://github.com/{destination}\nBase: {base or '(GitHub default)'}\n"
          f"Head: {branch} @ {commit}\nDraft title: {title}", flush=True)
    if evidence:
        print("\n" + evidence + "\n", flush=True)
    if not confirmed:
        print("Preview complete. Add --publish to push this commit and open a draft PR.")
        return
    slug = "github.com/" + origin
    # Read before pushing, and keep a retry after a partial failure safe.
    fields = "isCrossRepository,headRefOid,state,url" + (",body" if evidence else "")
    prs = json.loads(run(repo, "gh", "pr", "list", "-R", slug, "--state", "all", "--base",
                         base, "--head", branch, "--json", fields))
    for pr in prs:
        if pr["isCrossRepository"]:
            continue
        if pr["headRefOid"] == commit:
            if evidence and evidence not in (pr.get("body") or "").replace("\r\n", "\n"):
                raise ValueError("A PR for this commit already exists with a different body. "
                                 "Review its evidence at " + pr["url"])
            print(f"Existing {pr['state'].lower()} PR: {pr['url']}")
            return
        raise ValueError("A PR already uses this branch for another commit. Choose a new review branch.")
    ref = f"refs/heads/{branch}"
    existing = run(repo, "git", "ls-remote", "--refs", "origin", ref)
    if existing and existing.split()[0] != commit:
        raise ValueError("The destination branch already points to another commit.")
    if not existing:
        run(repo, "git", "-c", f"core.hooksPath={os.devnull}", "-c", "push.followTags=false",
            "-c", "remote.origin.mirror=false", "push", "--no-follow-tags", "origin", f"{commit}:{ref}")
    files = run(repo, "git", "diff-tree", "--no-commit-id", "--name-only", "-r", commit)
    message = f"{title}\n\nReview commit `{commit}`.\n\nChanged files\n\n"
    message += "\n".join(f"- `{name}`" for name in files.splitlines())
    if evidence:
        message += "\n\n" + evidence
    with tempfile.TemporaryDirectory(prefix="morph-pr-") as tmp:
        body = Path(tmp) / "proposal.md"
        body.write_text(message + "\n", encoding="utf-8")
        print(run(repo, "gh", "pr", "create", "--draft", "-R", slug,
                  "--base", base, "--head", branch, "--title", title, "--body-file", str(body)))


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--repo", required=True, type=Path)
    p.add_argument("--branch", required=True, help="An existing local morph/ branch")
    p.add_argument("--base", help="GitHub base branch (default origin/HEAD)")
    p.add_argument("--receipt", type=Path, help="Verify a downloaded factory receipt and include its matching comparison evidence")
    p.add_argument("--publish", action="store_true", help="Push and open the draft PR on GitHub")
    opts = p.parse_args()
    try:
        publish(opts.repo, opts.branch, opts.base, opts.publish, opts.receipt)
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        p.exit(1, str(error) + "\n")
