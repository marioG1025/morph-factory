import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {launchBrowser, startDesk} from "./desk.mjs";

import "./review-acceptance.mjs";

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

test("duplicate mirror frames and a late document cannot replace a recreated VibeCheck draft", {timeout:110000}, async t => {
  const desk = await startDesk();
  t.after(() => desk.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const actor = await browser.newPage();
  const observer = await browser.newPage();
  let duplicates = 0;
  await observer.routeWebSocket(/.*/, client => {
    const server = client.connectToServer();
    server.onMessage(data => {
      client.send(data);
      const frame = JSON.parse(data.toString());
      if (frame.t === "shared" && frame.set?.some(([key]) => key === "shared/review/comparison")) {
        client.send(data); duplicates++;
      }
    });
  });
  for (const page of [actor,observer]) {
    await page.goto(desk.url);
    await page.locator("#approve-comparison:enabled").waitFor();
  }
  const {draft: original, draftGeneration: originalGeneration} = await (await actor.request.get(new URL("/api/state", desk.url).href)).json();
  await actor.locator("#approve-comparison").click();
  await observer.locator("#layer-compare:enabled").waitFor();
  let held = 0, release, delivered;
  const hold = new Promise(resolve => {release = resolve;});
  const done = new Promise(resolve => {delivered = resolve;});
  t.after(release);
  await observer.route("**/api/comparisons/*", async route => {
    const response = await route.fetch();
    const document = await response.json();
    if (document.draftGeneration === originalGeneration && document.comparison) {
      held++;
      await hold;
      await route.fulfill({response});
      delivered();
    } else await route.fulfill({response});
  });
  await actor.locator("#layer-compare").click();
  await actor.locator(".comparison-conclusion").waitFor();
  await until(() => held === 1 && duplicates === 1);
  const old = await actor.locator("[data-comparison-run]").getAttribute("data-comparison-run");
  await observer.getByRole("button", {name:"Discard draft", exact:true}).click();
  await observer.getByRole("button", {name:"Confirm discard", exact:true}).click();
  await observer.locator("#manual").click();
  await observer.locator("#patch-title").fill("Recreated calendar draft");
  await observer.locator("#patch-diff").fill(original.diff);
  await observer.locator("#save-draft").click();
  await observer.locator("#review-layer").getByText("Recreated calendar draft", {exact:true}).waitFor();
  release();
  await done;
  await observer.locator("#layer-checks").click();
  await observer.locator('#layer-checks[aria-pressed="true"]').waitFor();
  assert.equal(held, 1, "Duplicated run notifications issue a single document read");
  assert.equal(await observer.locator(".comparison-conclusion").count(), 0, "Late evidence cannot enter the replacement");
  const checkedOtherDraft = actor.waitForResponse(response => new URL(response.url()).pathname.startsWith("/api/comparisons/"));
  await observer.locator("#layer-compare").click();
  await observer.locator(".comparison-conclusion").waitFor();
  const fresh = await (await checkedOtherDraft).json();
  assert.notEqual(fresh.draftGeneration, originalGeneration);
  assert.equal(fresh.comparison.run, await observer.locator("[data-comparison-run]").getAttribute("data-comparison-run"));
  assert.notEqual(fresh.comparison.run, old);
  await actor.locator("#layer-checks").click();
  await actor.locator('#layer-checks[aria-pressed="true"]').waitFor();
  assert.equal(await actor.locator("[data-comparison-run]").getAttribute("data-comparison-run"), old);
});

test("a peer stops reading a superseded run and retries temporary failures on its successor", {timeout:90000}, async t => {
  const desk = await startDesk();
  t.after(() => desk.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const operator = await browser.newPage(), peer = await browser.newPage();
  let oldRun, releaseRead, sendNewFrame;
  const holdRead = new Promise(resolve => {releaseRead = resolve;});
  t.after(releaseRead);
  const reads = new Map();
  await peer.routeWebSocket(/.*/, client => {
    const server = client.connectToServer();
    server.onMessage(data => {
      const frame = JSON.parse(data.toString());
      const encoded = frame.t === "shared" && frame.set.find(([key]) => key === "shared/review/comparison")?.[1];
      if (encoded && oldRun && JSON.parse(encoded).run !== oldRun) sendNewFrame = () => client.send(data);
      else client.send(data);
    });
  });
  await peer.route("**/api/comparisons/*", async route => {
    const run = new URL(route.request().url()).pathname.split("/").pop();
    oldRun ??= run;
    const attempt = (reads.get(run) || 0) + 1;
    reads.set(run, attempt);
    if (run === oldRun) {
      await holdRead;
      await route.continue(); // The real Python endpoint now returns 404 for the superseded run.
    } else if (attempt === 1) await route.abort("connectionreset");
    else if (attempt === 2) await route.fulfill({status:503, body:"Try again"});
    else await route.continue();
  });
  for (const page of [operator,peer]) {
    await page.goto(desk.url);
    await page.locator("#approve-comparison:enabled").waitFor();
  }
  await operator.locator("#approve-comparison").click();
  const measure = async () => {
    const reply = operator.waitForResponse(res => new URL(res.url()).pathname === "/api/compare");
    await operator.locator("#layer-compare:enabled").click();
    return (await (await reply).json()).run;
  };
  const first = await measure();
  await until(() => reads.get(first) === 1);
  const next = await measure();
  await until(() => Boolean(sendNewFrame));
  const missing = peer.waitForResponse(res => new URL(res.url()).pathname === "/api/comparisons/" + first);
  releaseRead();
  assert.equal((await missing).status(), 404);
  // Keep the first marker current for more than two of the browser's 3 s retry ticks.
  await new Promise(resolve => setTimeout(resolve, 6600));
  assert.equal(reads.get(first), 1);
  assert.equal(await peer.locator("[data-comparison-run]").count(), 0);
  sendNewFrame();
  await peer.locator('[data-comparison-run="' + next + '"]').waitFor({timeout:23000});
  assert.equal(reads.get(next), 3);
  assert.equal(await peer.locator('[data-kind="fixed"]').count(), 4);
});
