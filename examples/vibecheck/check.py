"""Exercise the VibeCheck screens affected by a proposed change in a disposable checkout."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


FRONT = Path("Music_Show_Helper/Frontend")
DATE_PAGES = {f"{FRONT.as_posix()}/src/pages/{name}"
              for name in ("EventsPage.tsx", "EventDetailPage.tsx")}
HERE = Path(__file__).resolve().parent


def report(key, name, status, detail):
    if where := os.environ.get("MORPH_CASE_REPORT"):
        with Path(where).open("a", encoding="utf-8") as stream:
            print(json.dumps(dict(id=key, name=name, status=status, detail=detail)), file=stream)


def install_frontend():
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm:
        raise RuntimeError("Install npm to prepare the VibeCheck frontend.")
    command = [npm]
    # Windows' npm.cmd can select a different architecture of Node from PATH.
    # Use the same interpreter for npm's native package selection and its scripts.
    if os.name == "nt":
        cli = Path(npm).parent / "node_modules/npm/bin/npm-cli.js"
        node = shutil.which("node")
        if node and cli.is_file():
            command = [node, str(cli)]
    # The pinned public example lacks a lockfile. Make its two installs identical
    # when the requested dependency set still matches the recorded fixture.
    if not (FRONT / "package-lock.json").exists():
        lock = HERE / "frontend.package-lock.json"
        root = json.loads(lock.read_text(encoding="utf-8"))["packages"][""]
        package = json.loads((FRONT / "package.json").read_text(encoding="utf-8"))
        fields = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
        if all(package.get(field) == root.get(field) for field in fields):
            shutil.copyfile(lock, FRONT / "package-lock.json")
    install = "ci" if (FRONT / "package-lock.json").exists() else "install"
    if subprocess.run([*command, install, "--ignore-scripts", "--no-audit", "--no-fund"], cwd=FRONT).returncode:
        raise RuntimeError("Frontend dependencies could not be installed. Inspect the npm output.")
    return command


def frontend_build():
    name = "VibeCheck frontend production build"
    def record(status, message):
        print(message, flush=True)
        report("frontend:build", name, status, message)
        return 0 if status == "passed" else 1
    try:
        command = install_frontend()
    except (RuntimeError, OSError) as exc:
        return record("error", str(exc))
    built = subprocess.run([*command, "run", "build"], cwd=FRONT, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, encoding="utf-8", errors="replace")
    print(built.stdout, flush=True)
    if built.returncode:
        first_error = next((line for line in built.stdout.splitlines() if "error TS" in line), "")
        return record("failed", first_error.strip() or f"Production build exited with code {built.returncode}.")
    return record("passed", "TypeScript and Vite completed the production build.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser-dates", action="store_true", help="Check rendered React dates in four time zones")
    if parser.parse_args().browser_dates:
        try:
            install_frontend()
            node = os.environ.get("MORPH_NODE") or "node"
            return subprocess.run([node, str(HERE / "browser-dates.mjs")]).returncode
        except (RuntimeError, OSError) as exc:
            report("browser:setup", "VibeCheck product browser setup", "error", str(exc))
            print(exc, file=sys.stderr)
            return 1
    hints = os.environ.get("MORPH_CHANGED_PATHS")
    whole_commit = os.environ.get("MORPH_CHECK_SCOPE") == "head"
    if whole_commit:
        paths = set()
    elif hints is not None:
        paths = set(json.loads(hints))
    else:
        staged = subprocess.check_output(["git", "diff", "--cached", "--name-only", "-z"])
        paths = set(staged.decode("utf-8").rstrip("\0").split("\0")) if staged else set()
    date_check = whole_commit or bool(paths & DATE_PAGES)
    build_check = whole_commit or any(p.startswith(f"{FRONT.as_posix()}/") and p not in DATE_PAGES for p in paths)
    status = 0
    if date_check:
        status = subprocess.run(["node", str(HERE / "check-dates.cjs")]).returncode
    if build_check:
        status = max(status, frontend_build())
    if not date_check and not build_check:
        message = "No VibeCheck frontend checks apply to these paths."
        print(message)
        report("frontend:applicability", "VibeCheck frontend coverage", "skipped", message)
    return status


if __name__ == "__main__":
    sys.exit(main())
