import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {join} from "node:path";
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
  await first.locator("#layer-compare").click();
  await first.locator(".comparison-conclusion").waitFor({timeout:90000});
  assert.equal(await first.locator('.comparison-cases [data-kind="fixed"]').count(), 4);
  assert.equal(await first.locator('.comparison-cases [data-kind="unchanged"]').count(), 2);
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

test("an open desk survives expired credentials and a restarted LLP host", {timeout:140000}, async t => {
  const desk = await startDesk({observeSidecar: true, env: {MORPH_SESSION_TTL_MS: "1600"}});
  t.after(() => desk.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const context = await browser.newContext();
  // Track real native sockets in the test without exposing a debug control in the app.
  await context.addInitScript(() => {
    const BrowserSocket = window.WebSocket;
    window.WebSocket = class extends BrowserSocket {
      constructor(...args) { super(...args); window.testSocket = this; }
    };
  });
  const page = await context.newPage();
  let bootstraps = 0, denied = 0;
  page.on("response", res => {if (new URL(res.url()).pathname === "/api/live/session" && res.ok()) bootstraps++;});
  page.on("websocket", ws => ws.on("framereceived", frame => {
    try { if (JSON.parse(frame.payload).code === "unauthorized") denied++; } catch {}
  }));
  await page.goto(desk.url);
  await page.locator("#approve-comparison:enabled").waitFor({timeout:45000});
  await page.locator("#layer-checks").click();
  const documentId = await page.evaluate(() => window.documentSession = crypto.randomUUID());
  const address = await page.evaluate(() => window.testSocket.url);
  let delayNextBootstrap = true;
  await page.route("**/api/live/session", async route => {
    const response = await route.fetch();
    if (delayNextBootstrap) {
      delayNextBootstrap = false;
      // A slow connection hands the browser a genuinely signed, already expired
      // token. The next bootstrap must recover after the server rejects hello.
      await new Promise(done => setTimeout(done, 1850));
    }
    await route.fulfill({response});
  });

  const expired = await page.evaluate(async () => {
    // Wait for the actual signed hello token to expire on the server.
    await new Promise(done => setTimeout(done, 1700));
    window.testSocket.close();
    return true;
  });
  assert.ok(expired);
  await until(() => denied >= 1 && bootstraps >= 3);
  await page.locator("#approve-comparison:enabled").waitFor();
  assert.equal(await page.locator("#layer-checks").getAttribute("aria-pressed"), "true");

  await page.locator("#approve-comparison").click();
  await page.locator("#layer-compare:enabled").waitFor();
  // This PID was written after the test launcher spawned this instance. No shared
  // workstation service or repository is modified by this failure scenario.
  const child = Number(await readFile(join(desk.directory, "sidecar.pid"), "utf8"));
  assert.ok(Number.isInteger(child) && child > 0);
  process.kill(child);
  await page.waitForFunction(old => window.testSocket?.url !== old && window.testSocket.readyState === 1,
    address, {timeout:25000});
  assert.equal(await page.evaluate(() => window.documentSession), documentId);
  assert.equal(await page.locator("#layer-checks").getAttribute("aria-pressed"), "true");
  await page.locator("#layer-compare").click();
  await page.locator(".comparison-conclusion").waitFor({timeout:60000});
  assert.equal(await page.locator('.comparison-cases [data-kind="fixed"]').count(), 4);
  t.diagnostic("New same-origin bootstraps: " + (bootstraps - 1) + ". Expired hello rejections observed: " + denied + ".");
});

async function until(check, timeout = 18000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw Error("Timed out waiting for the browser scenario.");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

test("a superseded remote grant cannot consume a new comparison request", {timeout:90000}, async t => {
  const desk = await startDesk();
  t.after(() => desk.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const actor = await browser.newPage();
  const observer = await browser.newPage();
  const replies = [];
  let posted = 0;
  observer.on("request", request => {if (new URL(request.url()).pathname === "/api/compare") posted++;});
  await observer.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    server.onMessage(data => {
      const frame = JSON.parse(data.toString());
      if (frame.t === "reply") replies.push(() => socket.send(data));
      else socket.send(data);
    });
  });
  for (const page of [actor, observer]) {
    await page.goto(desk.url);
    await page.locator("#approve-comparison:enabled").waitFor();
  }
  await actor.locator("#approve-comparison").click();
  await observer.locator("#layer-compare").click();
  await until(() => replies.length === 1);
  await actor.locator("#restore-review").click();
  await observer.locator("#layer-compare").waitFor({state:"detached"});
  await actor.locator("#approve-comparison").click();
  await observer.locator("#layer-compare:enabled").waitFor({timeout:8000});
  await observer.locator("#layer-compare").click();
  await until(() => replies.length === 2);
  replies[0]();
  // Let the browser dispatch the delayed response while the active one is still held.
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(posted, 0);
  replies[1]();
  await observer.locator(".comparison-conclusion").waitFor({timeout:50000});
  assert.equal(posted, 1);
  assert.equal(await observer.locator('.comparison-cases [data-kind="fixed"]').count(), 4);
});
