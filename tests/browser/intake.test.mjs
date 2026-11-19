import {test} from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {launchBrowser, startDesk} from "./desk.mjs";

const python = process.env.MORPH_PYTHON || (process.platform === "win32" ? "python" : "python3");

async function inspectFailure(t, desk, expectName, expectedFailures, removePrepared = false) {
  t.after(() => desk.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const context = await browser.newContext({permissions:["clipboard-read", "clipboard-write"]});
  const page = await context.newPage();
  await page.setViewportSize({width:390, height:844});
  const calls = [];
  page.on("request", request => {
    if (request.method() === "POST") calls.push(new URL(request.url()).pathname);
  });
  // Exercise the optional-CLI UI without making a model call in this test.
  await page.route("**/api/agent/status", route => route.fulfill({json:{status:"idle", available:false}}));
  await page.goto(desk.url);
  if (removePrepared) {
    await page.locator("#layer-discard").click();
    await page.locator("#layer-discard").click();
  }
  await page.getByRole("button", {name:"Check current commit"}).click();
  await page.locator("#head-cases summary").first().waitFor({timeout:140000});
  const state = await page.evaluate(async () => (await (await fetch("/api/state")).json()));
  assert.equal(state.draft, null);
  assert.equal(state.headCheck.failed, expectedFailures, state.headCheck.output);
  assert.match(await page.locator("#head-cases summary").first().textContent(), expectName);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole("button", {name:"Prepare proposal"}).first().click();
  const idea = page.getByRole("textbox", {name:"What should improve?"});
  const attachments = page.getByRole("textbox", {name:"Tracked files for context (optional)"});
  await attachments.fill("one.py\ntwo.py\nthree.py\nfour.py\nfive.py");
  assert.equal(await attachments.evaluate(el => el.validity.valid), false);
  await attachments.fill("one.py\ntwo.py");
  assert.equal(await attachments.evaluate(el => el.validity.valid), true);
  const original = await idea.inputValue();
  assert.match(original, expectName);
  assert.ok(original.includes(state.headCheck.base));
  await idea.fill(original + "\nPreserve existing behavior.");
  await page.getByRole("button", {name:"Copy proposal text"}).click();
  await page.getByText("Proposal text copied.").waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copied.replaceAll("\r\n", "\n"), await idea.inputValue());
  assert.equal(await page.getByRole("button", {name:"Generate patch"}).isDisabled(), true);
  assert.equal(calls.includes("/api/agent"), false);
  assert.equal(calls.includes("/api/review"), false);
  t.diagnostic(state.headCheck.failed + " named failure(s), first: " + state.headCheck.cases[0].name);
}

test("ordinary Python product turns a native unittest failure into editable evidence", {timeout:90000}, async t => {
  const repo = await mkdtemp(join(tmpdir(), "morph-intake-product-"));
  t.after(() => rm(repo, {recursive:true, force:true, maxRetries:5}));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args]);
  git("init", "-q", "-b", "main");
  await writeFile(join(repo, "pricing.py"), "def total(subtotal, delivery_fee):\n    return subtotal\n");
  await writeFile(join(repo, "test_price.py"), [
    "import unittest", "from pricing import total", "class Price(unittest.TestCase):",
    "    def test_total(self): self.assertEqual(total(8, 1), 9)", "",
  ].join("\n"));
  git("add", "test_price.py", "pricing.py");
  git("-c", "user.name=Product test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Price test");
  const desk = await startDesk({repo, command:[python, "-B", "-m", "unittest", "discover"]});
  await inspectFailure(t, desk, /test_total/, 1);
});

test("VibeCheck whole-commit check finds calendar and build failures from an empty desk",
  {timeout:180000, skip:!process.env.MORPH_VIBECHECK_REPO}, async t => {
    const desk = await startDesk();
    await inspectFailure(t, desk, /EventsPage/, 5, true);
  });
