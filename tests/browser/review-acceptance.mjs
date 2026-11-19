import {test} from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {release} from "node:os";
import {launchBrowser, startDesk} from "./desk.mjs";

test("approve Compare results in a live VibeCheck draft, then restore", {timeout:180000}, async t => {
  const desk = await startDesk();
  t.after(() => desk.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  t.diagnostic("Browser runtime " + browser.browserType().name() + " " + browser.version() +
    " on " + process.platform + " " + process.arch + " " + release());

  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();
  const sharedFrames = [];
  const comparisonPosts = [];
  let peerReads = 0;
  second.on("request", request => {if (new URL(request.url()).pathname === "/api/state") peerReads++;});
  second.on("websocket", ws => ws.on("framereceived", message => {
    const frame = JSON.parse(message.payload.toString());
    if (frame.t === "shared" && frame.set?.length) sharedFrames.push(frame);
  }));
  const pageErrors = [];
  for (const p of [first,second]) {
    p.on("pageerror", e => pageErrors.push(e.message));
    p.on("request", request => {
      if (new URL(request.url()).pathname === "/api/compare" && request.method() === "POST") comparisonPosts.push(p);
    });
    await p.goto(desk.url);
    await p.locator("#approve-comparison:enabled").waitFor({timeout:45000});
  }
  const initial = await first.evaluate(async () => {
    window.documentSession = crypto.randomUUID();
    const {draft} = await (await fetch("/api/state")).json();
    return {session:window.documentSession, diff:draft.diff, base:draft.base};
  });
  await second.setViewportSize({width:390, height:844});
  await second.locator("#release-record summary").click();
  await second.waitForFunction(() => document.getElementById("live-adoption").textContent.startsWith("2 of 2"));
  const diff = second.locator('#review-layer pre[aria-label="Unified diff"]');
  const selected = await diff.evaluate(el => {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el.querySelector(".diff-line"));
    const selection = getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    el.scrollTop = 45; el.scrollLeft = 20;
    return {text:selection.toString(), top:el.scrollTop, left:el.scrollLeft};
  });
  assert.ok(selected.text.length);
  await first.locator("#layer-checks").click();
  await first.locator('#layer-checks[aria-pressed="true"]').waitFor();
  await first.route("**/api/live/candidate", async route => {
    const response = await route.fetch();
    const candidate = await response.json();
    candidate.serverRehearsal.elapsedMs += 1;
    await route.fulfill({response, json:candidate});
  });
  await first.locator("#approve-comparison").click();
  await first.getByText("The server rehearsal did not supply a passing signed receipt for this release.").waitFor();
  assert.equal(await first.locator("#layer-compare").count(), 0);
  await first.unroute("**/api/live/candidate");
  await first.locator("#rehearse-comparison").click();
  await first.getByText("Rehearsal passed. The signed update keeps this draft and its selected pane.").waitFor();
  assert.equal(await first.locator("#layer-compare").count(), 0);
  await first.locator("#approve-comparison").click();
  for (const page of [first,second]) await page.locator("#layer-compare:enabled").waitFor();
  assert.equal(await first.locator("#layer-checks").getAttribute("aria-pressed"), "true");
  assert.equal(await second.locator("#release-record").evaluate(el => el.open), true);
  assert.equal(await diff.evaluate(el => document.activeElement === el), true);
  assert.deepEqual(await diff.evaluate(el => ({text:getSelection().toString(), top:el.scrollTop, left:el.scrollLeft})), selected);
  for (const page of [first,second]) {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Desk fits the viewport");
  }
  const after = await first.evaluate(async () => {
    const {draft} = await (await fetch("/api/state")).json();
    return {session:window.documentSession, diff:draft.diff, base:draft.base};
  });
  assert.deepEqual(after, initial);
  const beforeReads = peerReads;
  const observerDocument = await second.evaluate(() => performance.timeOrigin);
  await first.locator("#layer-compare").click();
  for (const page of [first,second]) {
    await page.locator(".comparison-conclusion").waitFor({timeout:90000});
    assert.equal(await page.locator('.comparison-cases [data-kind="fixed"]').count(), 4);
    assert.equal(await page.locator('.comparison-cases [data-kind="unchanged"]').count(), 2);
  }
  const run = await first.locator("[data-comparison-run]").getAttribute("data-comparison-run");
  assert.match(run, /^[0-9a-f]{32}$/);
  assert.equal(await second.locator("[data-comparison-run]").getAttribute("data-comparison-run"), run);
  assert.equal(peerReads - beforeReads, 1);
  assert.equal(comparisonPosts.length, 1);
  assert.equal(comparisonPosts[0], first);
  assert.equal(sharedFrames.length, 1);
  const [[key, encoded]] = sharedFrames[0].set;
  assert.equal(key, "shared/review/comparison");
  assert.deepEqual(sharedFrames[0], {t:"shared", set:[[key,encoded]], del:[]});
  assert.deepEqual(JSON.parse(encoded), {run, base:initial.base,
    digest:createHash("sha256").update(initial.diff).digest("hex"), releaseVersion:2});
  assert.equal(await second.evaluate(() => performance.timeOrigin), observerDocument);
  assert.equal(await diff.evaluate(el => document.activeElement === el), true);
  assert.deepEqual(await diff.evaluate(el => ({text:getSelection().toString(), top:el.scrollTop, left:el.scrollLeft})), selected);
  await first.locator("#restore-review").click();
  for (const page of [first,second]) await page.locator("#layer-compare").waitFor({state:"detached"});
  assert.equal(await first.locator("#layer-checks").getAttribute("aria-pressed"), "true");
  await first.locator("#layer-verify").click();
  await first.locator("#layer-save:enabled").waitFor({timeout:50000});
  await first.locator("#layer-save").click();
  await first.locator("#review-layer .publish-hint").waitFor();
  const kept = await first.evaluate(async () => (await (await fetch("/api/state")).json()));
  const git = (...args) => execFileSync("git", ["-C", kept.repo, ...args], {encoding:"utf8"}).trim();
  assert.equal(kept.draft.verification.ok, true);
  assert.equal(git("rev-parse", "refs/heads/" + kept.draft.review.branch), kept.draft.review.commit);
  assert.equal(git("rev-parse", "HEAD"), initial.base);
  assert.equal(git("status", "--porcelain"), "");
  await first.locator("#layer-discard").click();
  await first.locator("#empty-draft:visible").waitFor();
  assert.equal(git("rev-parse", "refs/heads/" + kept.draft.review.branch), kept.draft.review.commit);
  assert.deepEqual(pageErrors, []);
});
