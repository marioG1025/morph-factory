"""Run the checks affected by the proposed VibeCheck change in its disposable checkout."""
import shutil
import subprocess
import sys
from pathlib import Path

front = Path("Music_Show_Helper/Frontend")
paths = subprocess.check_output(["git", "diff", "--cached", "--name-only"], text=True).splitlines()
date_pages = {"EventsPage.tsx", "EventDetailPage.tsx"}
if any(Path(p).name in date_pages for p in paths):
    subprocess.run(["node", str(Path(__file__).with_name("check-dates.cjs"))], check=True)
if any(p.startswith(f"{front.as_posix()}/") and Path(p).name not in date_pages for p in paths):
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm:
        sys.exit("Install npm to run VibeCheck's frontend build.")
    subprocess.run([npm, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"],
                   cwd=front, check=True)
    subprocess.run([npm, "run", "build"], cwd=front, check=True)
elif not any(Path(p).name in date_pages for p in paths):
    print("No VibeCheck frontend probes apply to the changed paths. See Git and repository-specific checks above.")
