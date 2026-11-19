// Opt-in wall-clock experiment. Requires Chromium and the same setup as tests/browser.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { launchBrowser, startDesk } from "../tests/browser/desk.mjs";

const smoke = process.argv[2] === "--smoke";
if (process.argv.length !== (smoke ? 3 : 2)) throw Error("Usage: node scripts/suspended-review.mjs [--smoke]");
if (process.env.MORPH_BROWSER_ENGINE && process.env.MORPH_BROWSER_ENGINE !== "chromium") {
  throw Error("The suspended-review experiment needs Chromium's debugger. Set MORPH_BROWSER_ENGINE=chromium.");
}
const ttl = smoke ? 15000 : 3600000;
const desk = await startDesk({env: {MORPH_SESSION_TTL_MS: String(ttl)}});
const log = (kind, facts) => console.log(JSON.stringify({kind, at: new Date().toISOString(), ...facts}));
const sha = text => createHash("sha256").update(text).digest("hex");
let browser;
try {
  browser = await launchBrowser();
  const actor = await browser.newPage();
  const observer = await browser.newPage();
  const hellos = [], rejected = [], signals = [];
  let bootstraps = 0, actorPosts = 0, observerPosts = 0, observerDocuments = 0;
  observer.on("request", request => {
    if (request.resourceType() === "document") observerDocuments++;
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/compare") observerPosts++;
  });
  actor.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/compare") actorPosts++;
  });
  observer.on("response", response => {
    if (response.ok() && new URL(response.url()).pathname === "/api/live/session") bootstraps++;
  });
  observer.on("websocket", socket => {
    let expiry;
    socket.on("framesent", ({payload}) => {
      const message = JSON.parse(payload.toString());
      if (message.t !== "hello") return;
      // Retain only the signed expiry timestamp from the native hello, never a credential.
      expiry = JSON.parse(Buffer.from(message.token.split(".")[0], "base64url").toString()).e;
      hellos.push({at: Date.now(), expiry});
    });
    socket.on("framereceived", ({payload}) => {
      const message = JSON.parse(payload.toString());
      if (message.t === "error" && message.code === "unauthorized") rejected.push({at: Date.now(), expiry});
      if (message.t !== "shared") return;
      for (const [key, value] of message.set || []) {
        if (key === "shared/review/comparison") signals.push({full: message.full === true, ...JSON.parse(value)});
      }
    });
  });
  await observer.addInitScript(() => {
    window.reviewTicks = 0;
    setInterval(() => window.reviewTicks++, 1000);
    const NativeSocket = WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) { super(...args); window.reviewTestSocket = this; }
    };
  });
  for (const [i, page] of [actor, observer].entries()) {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.bringToFront();
    await page.goto(desk.url);
    try { await page.locator("#approve-comparison:enabled").waitFor({timeout: 45000}); }
    catch (error) {
      const states = await page.locator("#release-feedback,#live-connection").allTextContents();
      throw Error(`Could not open ${i ? 'reviewer' : 'operator'} view (${[...states, ...errors].join(' / ')})`, {cause: error});
    }
  }
  const session = await observer.context().newCDPSession(observer);
  await actor.waitForFunction(async () => (await (await fetch("/api/live/status")).json()).acknowledged === 2,
    null, {polling: 250, timeout: 30000});
  await observer.locator("#layer-checks").click();
  const origin = await observer.evaluate(() => performance.timeOrigin);
  const original = (await (await actor.request.get(new URL("/api/state", desk.url).href)).json()).draft;
  const initial = hellos[0];
  assert.ok(initial && initial.expiry - initial.at <= ttl && initial.expiry - initial.at > ttl - 10000);
  await actor.bringToFront();
  await session.send("Debugger.enable", {maxScriptsCacheSize: 0});
  const ticksBefore = await observer.evaluate(() => window.reviewTicks);
  const disconnected = Date.now();
  await observer.context().setOffline(true);
  await observer.evaluate(() => window.reviewTestSocket.close());
  // A Chromium debugger pause suspends this document's JavaScript timers even when
  // headless mode keeps hidden pages active. The independent desk and operator keep running.
  const paused = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("The reviewer did not enter the paused state.")), 10000);
    session.once("Debugger.paused", () => { clearTimeout(timer); resolve(); });
  });
  await session.send("Debugger.pause");
  await paused;
  await actor.waitForFunction(async () => (await (await fetch("/api/live/status")).json()).connected === 1,
    null, {polling: 250, timeout: 30000});
  log("suspended", {smoke, browser: browser.version(), ttlSeconds: ttl / 1000, release: 1, connected: 1, runtimePaused: true});

  await actor.locator("#approve-comparison").click();
  await actor.locator("#layer-compare:enabled").waitFor({timeout: 30000});
  const finished = actor.waitForResponse(r => r.url().endsWith("/api/compare") && r.request().method() === "POST", {timeout: 90000});
  await actor.locator("#layer-compare").click();
  const response = await finished;
  assert.equal(response.status(), 200);
  const report = await response.json();
  assert.equal(report.base, original.base);
  assert.equal(report.digest, sha(original.diff));
  assert.equal(report.summary.fixed, 4);
  assert.equal(report.summary.regressed, 0);
  assert.equal(report.releaseVersion, 2);
  assert.equal(actorPosts, 1);
  log("compared", {release: report.releaseVersion, run: report.run, fixed: report.summary.fixed, observerPosts});

  const resumeAfter = Math.max(disconnected + ttl + (smoke ? 1500 : 60000), initial.expiry + 1000);
  while (Date.now() < resumeAfter) await delay(Math.min(60000, resumeAfter - Date.now()));
  assert.equal((await (await actor.request.get(new URL("/api/live/status", desk.url).href)).json()).connected, 1);
  assert.equal(signals.length, 0);
  const resumed = Date.now(), bootstrapsBeforeResume = bootstraps;
  await observer.context().setOffline(false);
  await session.send("Debugger.resume");
  await session.send("Debugger.disable");
  const ticksWhileAway = await observer.evaluate(() => window.reviewTicks) - ticksBefore;
  await observer.locator('[data-comparison-run="' + report.run + '"] .comparison-conclusion').waitFor({timeout: 60000});
  assert.equal(await observer.locator('.comparison-cases [data-kind="fixed"]').count(), 4);
  assert.equal(await observer.locator("#layer-checks").getAttribute("aria-pressed"), "true");
  assert.equal(await observer.evaluate(() => performance.timeOrigin), origin);
  assert.equal(observerDocuments, 1);
  assert.equal(observerPosts, 0);
  assert.equal(actorPosts, 1);
  assert.ok(signals.some(s => s.full && s.run === report.run && s.base === report.base &&
    s.digest === report.digest && s.releaseVersion === report.releaseVersion));
  assert.ok(ticksWhileAway <= 2, "the suspended document's one-second timer stayed paused");
  const originalRejected = rejected.some(attempt => attempt.at >= resumed && attempt.expiry === initial.expiry);
  assert.ok(hellos.some(hello => hello.at >= resumed && hello.expiry > resumed));
  assert.ok(bootstraps > bootstrapsBeforeResume);
  log("complete", {smoke, disconnectedSeconds: Math.round((resumed - disconnected) / 1000),
    originalExpiredForSeconds: Math.floor((resumed - initial.expiry) / 1000),
    recoveryMs: Date.now() - resumed, originalHandshakeRejected: originalRejected,
    renewedBootstraps: bootstraps - bootstrapsBeforeResume, fullSnapshot: true,
    sameDocument: true, sameRun: true, selectedPane: "checks", actorPosts, observerPosts,
    runtimePaused: true, ticksWhileAway});
} finally {
  await browser?.close();
  await desk.close();
}
