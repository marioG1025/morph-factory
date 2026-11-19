import {test} from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {launchBrowser, root, startDesk} from "./desk.mjs";

const python = process.env.MORPH_PYTHON || (process.platform === "win32" ? "python" : "python3");
const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], {encoding:"utf8"}).trim();
const state = desk => fetch(desk.url + "api/state").then(response => response.json());
const pin = "6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24";

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), "morph-watch-product-"));
  t.after(() => rm(dir, {recursive:true, force:true, maxRetries:6, retryDelay:150}));
  return dir;
}

async function priceProject(t) {
  const repo = await scratch(t);
  git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "prices.py"), "def total(items, fee):\n    return items + fee\n");
  await writeFile(join(repo, "test_price.py"), "import unittest\nfrom prices import total\n" +
    "class Price(unittest.TestCase):\n    def test_total(self): self.assertEqual(total(8, 1), 9)\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Local fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Passing product");
  return repo;
}

async function waitText(page, id, text) {
  await page.waitForFunction(([id,text]) => document.getElementById(id).textContent.includes(text),
    [id,text], {timeout:45000});
}

async function watchScenario(t, vibe) {
  const dir = await scratch(t);
  const repo = vibe ? process.env.MORPH_VIBECHECK_REPO : await priceProject(t);
  const log = join(dir, "runs.txt");
  const runner = join(dir, "count-check.py");
  await writeFile(log, "");
  // Keep the invocation log outside the disposable product checkout. Run the
  // actual configured suite and keep its normal structured case report.
  await writeFile(runner, [
    "import pathlib, subprocess, sys, time",
    "sha = subprocess.check_output(['git','rev-parse','HEAD'], text=True).strip()",
    "with pathlib.Path(sys.argv[1]).open('a', encoding='utf-8') as log: print(sha, file=log)",
    "time.sleep(1)",
    "raise SystemExit(subprocess.run(sys.argv[2:]).returncode)", "",
  ].join("\n"));
  const suite = vibe ? [process.execPath, join(root, "examples/vibecheck/check-dates.cjs")] :
    [python, "-B", join(root, "scripts/check-unittest.py")];
  const desk = await startDesk({repo, command:[python, "-B", runner, log, ...suite]});
  t.after(() => desk.close());
  const product = join(desk.directory, "product");
  git(product, "remote", "remove", "origin");
  git(product, "config", "user.name", "Local watch experiment");
  git(product, "config", "user.email", "watch@example.invalid");
  if (vibe) {
    git(product, "checkout", "-qb", "calendar-watch-fixture", pin);
    git(product, "apply", "--index", join(root, "docs/experiments/patches/vibecheck-agent-calendar.patch"));
    git(product, "commit", "-qm", "Correct date-only displays for watch fixture");
  }
  const passingBase = git(product, "rev-parse", "HEAD");
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const pages = [await browser.newPage(), await browser.newPage()];
  const posts = [];
  for (const page of pages) {
    page.on("request", req => {if (req.method() === "POST") posts.push(new URL(req.url()).pathname);});
    await page.goto(desk.url);
    assert.equal(await page.locator("#watch").isChecked(), false);
    await page.getByLabel("Watch for new commits").check();
    assert.equal(await page.locator("#watch-checks").isChecked(), false);
    await waitText(page, "watch-status", passingBase.slice(0,10));
  }
  git(product, "commit", "--allow-empty", "-qm", "New scan-only revision");
  const scanOnly = git(product, "rev-parse", "HEAD");
  for (const page of pages) {
    await waitText(page, "watch-status", scanOnly.slice(0,10));
    await page.getByLabel("Run project check on new commits").check();
    await waitText(page, "watch-status", "Watching from " + scanOnly.slice(0,10));
  }
  assert.equal(await readFile(log, "utf8"), "");

  if (vibe) {
    git(product, "revert", "--no-edit", passingBase);
  } else {
    await writeFile(join(product, "prices.py"), "def total(items, fee):\n    return items\n");
    git(product, "commit", "-qam", "Drop delivery fee");
  }
  const broken = git(product, "rev-parse", "HEAD");
  for (const page of pages) await waitText(page, "head-status", vibe ? "4 named failures" : "1 named failure");
  const finding = (await state(desk)).headCheck;
  assert.equal(finding.base, broken);
  const selected = pages[0];
  await selected.getByRole("button", {name:"Prepare proposal"}).first().click();
  assert.ok((await selected.locator("#agent-idea").inputValue()).includes(finding.cases[0].name));
  await selected.locator("#agent-close").click();
  git(product, "revert", "--no-edit", broken);
  const fixed = git(product, "rev-parse", "HEAD");
  for (const page of pages) await waitText(page, "head-status", fixed.slice(0,10));
  const passed = (await state(desk)).headCheck;
  assert.equal(passed.status, "passed");
  assert.equal(passed.failed, 0);
  assert.deepEqual((await readFile(log, "utf8")).trim().split(/\r?\n/), [broken, fixed]);
  assert.equal(posts.includes("/api/agent"), false);
  assert.equal(posts.includes("/api/draft"), false);
  assert.equal(posts.includes("/api/review"), false);
  assert.equal(git(product, "status", "--porcelain"), "");
  t.diagnostic("Two watchers, zero scan-only runs, two project commands. " +
    finding.failed + " named failure(s) at " + broken.slice(0,10) + "; passing at " + fixed.slice(0,10) + ".");
}

test("two empty desks run one Python project check for each new commit", {timeout:145000}, async t => watchScenario(t, false));
test("two VibeCheck watchers observe the real date regression and repair", {
  timeout:145000, skip:!process.env.MORPH_VIBECHECK_REPO}, async t => watchScenario(t, true));

test("watch stays scan-only when there is no project command", {timeout:50000}, async t => {
  const desk = await startDesk({repo:await priceProject(t), command:[]});
  t.after(() => desk.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(desk.url);
  await page.getByLabel("Watch for new commits").check();
  assert.equal(await page.getByLabel("Run project check on new commits").isDisabled(), true);
  await waitText(page, "watch-status", "Configure a trusted --check command");
});

test("a missing project runner pauses check execution and leaves scanning on", {timeout:50000}, async t => {
  const desk = await startDesk({repo:await priceProject(t), command:["morph-watch-missing-command-071"]});
  t.after(() => desk.close());
  const repo = join(desk.directory, "product");
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(desk.url);
  await page.getByLabel("Watch for new commits").check();
  await page.getByLabel("Run project check on new commits").check();
  await waitText(page, "watch-status", "Watching from " + git(repo, "rev-parse", "HEAD").slice(0,10));
  git(repo, "-c", "user.name=Local fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "--allow-empty", "-qm", "Trigger the unavailable runner");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await waitText(page, "watch-status", "Watched checks paused");
  assert.equal(await page.locator("#watch").isChecked(), true);
  assert.equal(await page.locator("#watch-checks").isChecked(), false);
  assert.equal((await state(desk)).headCheck.status, "error");
});

test("visibility, open drafts and connection failures pause watched checks", {timeout:90000}, async t => {
  const desk = await startDesk({repo:await priceProject(t), command:[python, "-B", "-m", "unittest", "discover"]});
  t.after(() => desk.close());
  const repo = join(desk.directory, "product");
  const commit = name => git(repo, "-c", "user.name=Local fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--allow-empty", "-qm", name);
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage();
  let checks = 0;
  page.on("request", req => {if (new URL(req.url()).pathname === "/api/watch-check") checks++;});
  const visibility = hidden => page.evaluate(value => {
    Object.defineProperty(document, "hidden", {configurable:true, value});
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
  await page.goto(desk.url);
  await page.getByLabel("Watch for new commits").check();
  await page.getByLabel("Run project check on new commits").check();
  await waitText(page, "watch-status", "Watching from " + git(repo, "rev-parse", "HEAD").slice(0,10));
  await visibility(true);
  commit("Hidden change");
  commit("Latest visible commit");
  const newest = git(repo, "rev-parse", "HEAD");
  await new Promise(done => setTimeout(done, 10500));
  assert.equal(checks, 0);
  await visibility(false);
  await waitText(page, "head-status", newest.slice(0,10));
  assert.equal(checks, 1);

  await page.getByRole("button", {name:"Add your patch"}).click();
  await page.getByLabel("Change title").fill("Keep my draft");
  const diff = "--- a/prices.py\n+++ b/prices.py\n@@ -2 +2 @@\n-    return items + fee\n+    return fee + items\n";
  await page.getByRole("textbox", {name:"Unified diff", exact:true}).fill(diff);
  await page.getByRole("button", {name:"Create draft"}).click();
  await waitText(page, "watch-status", "paused while a draft is open");
  commit("New HEAD during active draft");
  await visibility(false);
  await waitText(page, "commit", git(repo, "rev-parse", "HEAD").slice(0,10));
  assert.equal(checks, 1);
  assert.equal((await state(desk)).draft.diff, diff);

  await page.route("**/api/head", route => route.abort("failed"));
  await visibility(false);
  await waitText(page, "notice", "Commit watch paused.");
  assert.equal(await page.locator("#watch").isChecked(), false);
  assert.equal(await page.locator("#watch-checks").isChecked(), false);
});
