// Exercise the normal factory browser flow on a pinned snapshot of its own source.
import assert from "node:assert/strict";
import {execFileSync, spawn} from "node:child_process";
import {appendFile, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createInterface} from "node:readline";
import {launchBrowser, root} from "../tests/browser/desk.mjs";

const revision = "ba00706ee729490e870057c1db29a1e37fd315df";
const scratch = await mkdtemp(join(tmpdir(), "morph-self-host-"));
const product = join(scratch, "factory product");
const python = process.env.MORPH_PYTHON || (process.platform === "win32" ? "python" : "python3");
const command = [python, "-B", join(root, "scripts/check-unittest.py")];

function git(...args) {
  return execFileSync("git", ["-C", product, ...args], {encoding:"utf8"}).trimEnd();
}

async function pendingWork() {
  return {head:git("rev-parse", "HEAD"), branch:git("branch", "--show-current"), index:git("write-tree"),
    status:git("status", "--porcelain"), readme:await readFile(join(product, "README.md"), "utf8")};
}

// Windows may buffer stdout when launched as a pipe. server.py explicitly
// flushes this URL after binding the loopback port.
function deskAddress(child) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({input:child.stdout});
    const timer = setTimeout(() => done(Error("Timed out starting the local review desk.")), 30000);
    const fail = value => done(Error("Local review desk stopped: " + value));
    function done(error, url) {
      clearTimeout(timer);
      lines.close();
      child.off("error", fail);
      child.off("exit", fail);
      if (error) reject(error); else resolve(url);
    }
    child.once("error", fail);
    child.once("exit", fail);
    lines.on("line", line => {
      const match = line.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) done(null, match[0]);
    });
  });
}

let browser, server, stopped;
try {
  execFileSync("git", ["clone", "-q", "--no-local", "--no-checkout", "--", root, product]);
  git("config", "core.autocrlf", "false");
  git("checkout", "-qb", "operator", revision);
  git("remote", "remove", "origin");
  git("config", "user.name", "Factory self-host experiment");
  git("config", "user.email", "self-host@example.invalid");
  await appendFile(join(product, "README.md"), "\nUnfinished operator note.\n");
  await writeFile(join(product, "pending.txt"), "Staged work\n");
  git("add", "--", "pending.txt");
  const before = await pendingWork();

  const marker = (await readFile(join(root, "tests/__init__.py"), "utf8")).replace(/\r\n/g, "\n");
  const added = marker.trimEnd().split("\n");
  const patch = ["diff --git a/tests/__init__.py b/tests/__init__.py", "new file mode 100644", "--- /dev/null",
    "+++ b/tests/__init__.py", "@@ -0,0 +1," + added.length + " @@", ...added.map(line => "+" + line), ""].join("\n");
  const env = {...process.env};
  delete env.MORPH_VIBECHECK_REPO; // The target is Factory. External VibeCheck tests are opt-in.
  server = spawn(python, ["-B", "-u", "server.py", "--repo", product, "--port", "0",
    "--state-dir", join(scratch, "state"), "--check", ...command], {
      cwd:root, env, stdio:["ignore", "pipe", "pipe"], windowsHide:true});
  stopped = new Promise(resolve => {server.once("error", resolve); server.once("close", resolve);});
  let errors = "";
  server.stderr.on("data", chunk => { errors = (errors + chunk).slice(-6000); });
  const address = await deskAddress(server).catch(error => {throw Error(error.message + "\n" + errors);});
  browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(145000);
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(address);
  await page.getByRole("button", {name:"Scan only"}).click();
  await page.getByRole("button", {name:"Add your patch"}).click();
  await page.getByLabel("Change title").fill("Discover Factory tests from the repository root");
  await page.getByRole("textbox", {name:"Unified diff", exact:true}).fill(patch);
  await page.getByRole("button", {name:"Create draft"}).click();
  await page.locator("#layer-checks").click();
  const documentId = await page.evaluate(() => window.selfHostSession = crypto.randomUUID());
  await page.locator("#approve-comparison").click();
  await page.locator("#layer-compare").click();
  await page.locator(".comparison-conclusion").waitFor();
  const state = () => page.evaluate(async () => (await (await fetch("/api/state")).json()).draft);
  const compared = (await state()).comparison;
  assert.equal(compared.base, revision);
  assert.deepEqual(compared.command, command);
  assert.equal(compared.baseline.status, "failed", compared.baseline.output);
  assert.equal(compared.candidate.status, "passed", compared.candidate.output);
  assert.equal(compared.changes.find(c => c.id === "unittest.discovery").classification, "fixed");
  assert.match(compared.baseline.output, /Ran 0 tests/);
  const run = compared.candidate.output.match(/Ran (\d+) tests/);
  assert.ok(run && Number(run[1]) > 0, compared.candidate.output);
  assert.equal(await page.locator("#layer-checks").getAttribute("aria-pressed"), "true");
  assert.equal(await page.evaluate(() => window.selfHostSession), documentId);
  const skipped = compared.candidate.cases.filter(row => row.status === "skipped").length;
  console.log("PASS  Same open draft: baseline discovered 0 tests; candidate discovered " +
    run[1] + " (" + skipped + " skipped).");
  console.log("      Comparison: " + JSON.stringify(compared.summary));

  await page.locator("#layer-verify").click();
  await page.locator("#layer-save").click();
  await page.locator("#review-layer .review-result strong").waitFor();
  const {verification, review} = await state();
  assert.equal(verification.ok, true, verification.output);
  assert.equal(verification.tree, compared.candidateTree);
  assert.equal(git("rev-parse", review.branch), review.commit);
  assert.equal(git("rev-parse", review.commit + "^"), revision);
  assert.equal(git("rev-parse", review.commit + "^{tree}"), compared.candidateTree);
  assert.equal(git("diff", "--name-only", revision, review.commit), "tests/__init__.py");
  assert.deepEqual(await pendingWork(), before);
  assert.deepEqual(pageErrors, []);
  console.log("PASS  Verified and saved " + review.branch + "; commit parent and tree match.");
  console.log("      Base " + revision + "; candidate tree " + compared.candidateTree + ".");
  console.log("      Operator branch, index, modified README, and working status stayed intact.");
} finally {
  if (browser) await browser.close();
  if (server) {server.kill(); await stopped;}
  await rm(scratch, {recursive:true, force:true, maxRetries:5, retryDelay:200});
}
