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
