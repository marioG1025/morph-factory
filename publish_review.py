"""Preview or explicitly publish an existing local Morph review branch as a GitHub draft PR."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


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


def publish(repo, branch, base=None, confirmed=False):
    repo = Path(repo).expanduser().resolve(strict=True)
    if not branch.startswith("morph/"):
        raise ValueError("Select an existing local morph/ review branch.")
    run(repo, "git", "check-ref-format", "--branch", branch)
    commit = run(repo, "git", "rev-parse", "--verify", f"refs/heads/{branch}^{{commit}}")
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
    if not confirmed:
        print("Preview complete. Add --publish to push this commit and open a draft PR.")
        return
    slug = "github.com/" + origin
    # Read before pushing, and keep a retry after a partial failure safe.
    prs = json.loads(run(repo, "gh", "pr", "list", "-R", slug, "--state", "all", "--base",
                         base, "--head", branch, "--json", "isCrossRepository,headRefOid,state,url"))
    for pr in prs:
        if pr["isCrossRepository"]:
            continue
        if pr["headRefOid"] == commit:
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
    p.add_argument("--publish", action="store_true", help="Push and open the draft PR on GitHub")
    opts = p.parse_args()
    try:
        publish(opts.repo, opts.branch, opts.base, opts.publish)
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        p.exit(1, str(error) + "\n")
