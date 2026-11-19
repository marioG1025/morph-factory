"""Exercise the VibeCheck screens affected by a proposed change in a disposable checkout."""
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


def frontend_build():
    name = "VibeCheck frontend production build"
    def record(status, message):
        print(message, flush=True)
        report("frontend:build", name, status, message)
        return 0 if status == "passed" else 1
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm:
        return record("error", "Install npm to run the production build.")
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
    if subprocess.run([npm, install, "--ignore-scripts", "--no-audit", "--no-fund"], cwd=FRONT).returncode:
        return record("error", "Frontend dependencies could not be installed. Inspect the npm output.")
    built = subprocess.run([npm, "run", "build"], cwd=FRONT, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, encoding="utf-8", errors="replace")
    print(built.stdout, flush=True)
    if built.returncode:
        first_error = next((line for line in built.stdout.splitlines() if "error TS" in line), "")
        return record("failed", first_error.strip() or f"Production build exited with code {built.returncode}.")
    return record("passed", "TypeScript and Vite completed the production build.")


def main():
    hints = os.environ.get("MORPH_CHANGED_PATHS")
    if hints is not None:
        paths = set(json.loads(hints))
    else:
        staged = subprocess.check_output(["git", "diff", "--cached", "--name-only", "-z"])
        paths = set(staged.decode("utf-8").rstrip("\0").split("\0")) if staged else set()
    date_check = bool(paths & DATE_PAGES)
    build_check = any(p.startswith(f"{FRONT.as_posix()}/") and p not in DATE_PAGES for p in paths)
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
