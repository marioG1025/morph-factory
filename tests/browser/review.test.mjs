import {test} from "node:test";
import assert from "node:assert/strict";
import {launchBrowser, startDesk} from "./desk.mjs";

test("approve Compare results in a live VibeCheck draft, then restore", {timeout:180000}, async t => {
  const desk = await startDesk();
  t.after(() => desk.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();
  const pageErrors = [];
  for (const p of [first,second]) {
    p.on("pageerror", e => pageErrors.push(e.message));
    await p.goto(desk.url);
    await p.locator("#approve-comparison:enabled").waitFor({timeout:45000});
  }
  const initial = await first.evaluate(async () => {
    window.documentSession = crypto.randomUUID();
    const {draft} = await (await fetch("/api/state")).json();
    return {session:window.documentSession, diff:draft.diff, base:draft.base};
  });
  await first.locator("#layer-checks").click();
  await first.locator('#layer-checks[aria-pressed="true"]').waitFor();
  await first.locator("#rehearse-comparison").click();
  await first.getByText("Rehearsal passed. The signed update keeps this draft and its selected pane.").waitFor();
  assert.equal(await first.locator("#layer-compare").count(), 0);
  await first.locator("#approve-comparison").click();
  for (const page of [first,second]) await page.locator("#layer-compare:enabled").waitFor();
  assert.equal(await first.locator("#layer-checks").getAttribute("aria-pressed"), "true");
  const after = await first.evaluate(async () => {
    const {draft} = await (await fetch("/api/state")).json();
    return {session:window.documentSession, diff:draft.diff, base:draft.base};
  });
  assert.deepEqual(after, initial);
  await first.locator("#layer-compare").click();
  await first.locator(".comparison-conclusion").waitFor({timeout:90000});
  assert.equal(await first.locator('.comparison-cases [data-kind="fixed"]').count(), 4);
  assert.equal(await first.locator('.comparison-cases [data-kind="unchanged"]').count(), 2);
  await first.locator("#restore-review").click();
  for (const page of [first,second]) await page.locator("#layer-compare").waitFor({state:"detached"});
  assert.equal(await first.locator("#layer-checks").getAttribute("aria-pressed"), "true");
  assert.deepEqual(pageErrors, []);
});
