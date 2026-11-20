// Exercise only a disposable VibeCheck desk. Keep the same two browser documents
// alive across releases, withdrawal and offline intervals. JSON lines go to stdout.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { launchBrowser, startDesk } from "./desk.mjs";
import { startCoverage } from "../../runtime/tools/soak-coverage.mjs";

const duration = Number(process.env.MORPH_SOAK_MINUTES ?? 0);
const interval = Number(process.env.MORPH_SOAK_INTERVAL_SECONDS ?? 300);
const offlineEvery = Number(process.env.MORPH_SOAK_OFFLINE_EVERY ?? 3);
if (!Number.isFinite(duration) || duration < 0 || !Number.isFinite(interval) || interval < 1 ||
    !Number.isSafeInteger(offlineEvery) || offlineEvery < 1) {
  throw Error("Supply a nonnegative duration in minutes, a positive interval in seconds and a positive offline cycle frequency.");
}
const log = (kind, data) => console.log(JSON.stringify({at:new Date().toISOString(), kind, ...data}));
const sha = text => createHash("sha256").update(text).digest("hex");
const desk = await startDesk();
let browser, pages = [], phase = "open drafts", lastRehearsal;
const started = performance.now(), coverage = startCoverage();
let completed = 0;
try {
  browser = await launchBrowser();
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  let holdObserver = false;
  await contexts[1].routeWebSocket(/.*/, socket => {
    if (holdObserver) socket.close({code:1000, reason:"Observer offline during soak"});
    else socket.connectToServer();
  });
  await contexts[1].addInitScript(() => {
    const NativeSocket = WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) { super(...args); window.soakObserverSocket = this; }
    };
  });
  pages = await Promise.all(contexts.map(context => context.newPage()));
  pages[0].on("response", async response => {
    if (new URL(response.url()).pathname !== "/api/live/candidate") return;
    const body = await response.json().catch(() => null);
    const proof = body?.serverRehearsal;
    lastRehearsal = {http:response.status(), version:proof?.version, passed:proof?.ok, reason:proof?.error || body?.error};
  });
  const errors = [];
  let peerPosts = 0, reportReads = 0, stateReads = 0, signals = [];
  pages[1].on("request", req => {
    const path = new URL(req.url()).pathname;
    if (path === "/api/compare" && req.method() === "POST") peerPosts++;
    if (/^\/api\/comparisons\/[0-9a-f]{32}$/.test(path)) reportReads++;
    if (path === "/api/state") stateReads++;
  });
  pages[1].on("websocket", socket => socket.on("framereceived", frame => {
    const message = JSON.parse(frame.payload.toString());
    for (const [key, value] of message.t === "shared" ? message.set || [] : []) {
      if (key === "shared/review/comparison") signals.push({run:JSON.parse(value).run, full:message.full === true});
    }
  }));
  await Promise.all(pages.map(async page => {
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(desk.url, {waitUntil:"domcontentloaded"});
    await page.locator("#layer-diff:visible").waitFor();
  }));
  const origins = await Promise.all(pages.map(page => page.evaluate(() => performance.timeOrigin)));
  const original = (await (await pages[0].request.get(new URL("/api/state", desk.url).href)).json()).draft;
  const identity = sha(original.diff);
  await pages[0].locator("#layer-checks").click();
  await pages[1].locator("#layer-diff").click();
  do {
    coverage.check();
    const [active, observer] = pages;
    const cycle = completed + 1;
    const began = performance.now();
    const priorReports = reportReads, priorStates = stateReads;
    signals = [];
    phase = "disconnect observer";
    const missed = cycle % offlineEvery === 0;
    if (missed) {
      // Close the observer's real, test-owned socket. Network emulation alone can
      // leave a WebSocket connected. Prevent retries from rejoining until catch-up.
      holdObserver = true;
      await observer.evaluate(() => window.soakObserverSocket.close());
      await contexts[1].setOffline(true);
      await active.waitForFunction(async () => (await (await fetch("/api/live/status")).json()).connected === 1);
    }
    phase = "rehearse";
    lastRehearsal = undefined;
    await active.locator("#rehearse-comparison").click();
    await active.waitForFunction(() => {
      const feedback = document.querySelector("#release-feedback");
      return feedback.dataset.error === "true" || feedback.textContent.includes("Rehearsal passed");
    });
    const feedback = await active.locator("#release-feedback").textContent();
    assert.match(feedback, /Rehearsal passed/, `Cycle ${cycle} rehearsal: ${feedback}`);
    phase = "approve";
    await active.locator("#approve-comparison").click();
    await active.locator("#layer-compare:visible").waitFor({timeout:20000});
    assert.equal(await active.locator("#layer-checks").getAttribute("aria-pressed"), "true");
    phase = "compare";
    const whenCompared = active.waitForResponse(r => r.url().endsWith("/api/compare") && r.request().method() === "POST", {timeout:90000});
    await active.locator("#layer-compare").click();
    const response = await whenCompared;
    assert.equal(response.status(), 200);
    const result = await response.json();
    assert.equal(result.base, original.base);
    assert.equal(result.digest, identity);
    assert.equal(result.summary.fixed, 4);
    assert.equal(result.summary.regressed, 0);
    assert.equal(result.candidate.status, "passed");
    assert.match(result.run, /^[0-9a-f]{32}$/);
    phase = "receive saved report";
    if (missed) {
      assert.equal((await (await active.request.get(new URL("/api/live/status", desk.url).href)).json()).connected, 1);
      assert.equal(await observer.locator("#layer-compare").count(), 0);
      holdObserver = false;
      await contexts[1].setOffline(false);
    }
    await observer.locator('[data-comparison-run="' + result.run + '"] .comparison-conclusion').waitFor({timeout:35000});
    assert.equal(await observer.locator('.comparison-cases [data-kind="fixed"]').count(), 4);
    assert.equal(await observer.locator("#layer-diff").getAttribute("aria-pressed"), "true");
    assert.equal(peerPosts, 0);
    assert.equal(reportReads - priorReports, 1);
    assert.equal(stateReads - priorStates, 0);
    assert.ok(signals.some(signal => signal.run === result.run && signal.full === missed), "Observer received matching LLP marker");
    phase = "restore";
    await active.locator("#restore-review").click();
    await Promise.all(pages.map(page => page.locator("#layer-compare").waitFor({state:"hidden",timeout:20000})));
    const final = (await (await active.request.get(new URL("/api/state", desk.url).href)).json()).draft;
    assert.equal(final.base, original.base);
    assert.equal(sha(final.diff), identity);
    assert.deepEqual(await Promise.all(pages.map(page => page.evaluate(() => performance.timeOrigin))), origins);
    assert.deepEqual(errors, []);
    coverage.check();
    completed++;
    log("cycle", {cycle, elapsedMs:Math.round(performance.now() - began), fixed:result.summary.fixed,
      regressed:result.summary.regressed, release:result.releaseVersion, documentsPreserved:pages.length,
      observerMissedOffer:missed, peerRun:result.run, peerReceived:missed ? "full" : "delta",
      reportReads:reportReads - priorReports, stateReads:stateReads - priorStates, peerPosts});
    const left = started + duration * 60000 - performance.now();
    if (left <= 0) break;
    await delay(Math.min(interval * 1000, left));
  } while (performance.now() < started + duration * 60000);
  phase = "verify observed interval";
  const observed = coverage.check();
  log("complete", {cycles:completed, elapsedSeconds:Math.round((performance.now()-started)/1000), coverage:observed});
} catch (error) {
  const observed = coverage.report();
  const documents = await Promise.all(pages.map(page => page.evaluate(() => ({
    release:document.querySelector("#live-connection")?.textContent,
    feedback:document.querySelector("#release-feedback")?.textContent,
    events:[...document.querySelectorAll("#release-log li")].slice(0, 3).map(row => row.textContent)
  })).catch(() => null)));
  log("failure", {cycle:completed+1, phase, lastRehearsal, documents, coverage:observed, error:error.message.slice(0, 500)});
  throw error;
} finally {
  coverage.stop();
  await browser?.close();
  await desk.close();
}
