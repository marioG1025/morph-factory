import {spawn, execFileSync} from "node:child_process";
import {mkdtemp, mkdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

const require = createRequire(import.meta.url);
export const root = fileURLToPath(new URL("../../", import.meta.url));

export async function launchBrowser() {
  const {chromium} = require(process.env.MORPH_PLAYWRIGHT || "playwright");
  return chromium.launch({headless: true, executablePath: process.env.MORPH_BROWSER_EXECUTABLE || undefined});
}

export async function startDesk({repo = process.env.MORPH_VIBECHECK_REPO, stateDir, env = {}, port = 0} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "morph-browser-"));
  const args = ["-B", "-u", "vibecheck.py", "--no-open", "--port", String(port),
                "--state-dir", stateDir || join(directory, "state")];
  if (repo) {
    const target = join(directory, "VibeCheck");
    execFileSync("git", ["clone", "-q", "--no-local", resolve(repo), target]);
    execFileSync("git", ["-C", target, "checkout", "--quiet", "--detach", "6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24"]);
    args.push("--repo", target);
  }
  await mkdir(stateDir || join(directory, "state"), {recursive: true});
  const python = process.env.MORPH_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const server = spawn(python, args, {cwd: root, env: {...process.env, ...env}, windowsHide:true, stdio:["ignore","pipe","pipe"]});
  let output = "", errors = "";
  const exited = new Promise(resolveExit => {
    server.once("error", resolveExit); server.once("close", resolveExit);
  });
  server.stderr.on("data", data => { errors = (errors + data).slice(-12000); });
  async function close() {
    server.kill(); await exited;
    await rm(directory, {recursive: true, force:true, maxRetries:6, retryDelay:150});
  }
  try {
    const url = await new Promise((resolveUrl, reject) => {
      const timeout = setTimeout(() => reject(Error("Desk startup timed out: " + errors)), 90000);
      function fail(reason) { clearTimeout(timeout); reject(Error(String(reason) + " " + errors)); }
      server.once("error", fail); server.once("exit", fail);
      server.stdout.on("data", data => {
        output += data;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
        if (match) {clearTimeout(timeout); server.off("exit", fail); server.off("error", fail); resolveUrl(match[0]);}
      });
    });
    return {url, server, directory, close};
  } catch (err) { await close(); throw err; }
}
