// Exercise only a disposable VibeCheck desk. Keep the same two browser documents
// alive across releases, withdrawal and offline intervals. JSON lines go to stdout.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { launchBrowser, startDesk } from "./desk.mjs";

const duration = Number(process.env.MORPH_SOAK_MINUTES ?? 0);
const interval = Number(process.env.MORPH_SOAK_INTERVAL_SECONDS ?? 300);
if (!Number.isFinite(duration) || duration < 0 || !Number.isFinite(interval) || interval < 1) {
  throw Error("Supply a nonnegative duration in minutes and a positive interval in seconds.");
}
const log = (kind, data) => console.log(JSON.stringify({at:new Date().toISOString(), kind, ...data}));
const sha = text => createHash("sha256").update(text).digest("hex");
const desk = await startDesk();
let browser;
const started = Date.now();
let completed = 0;
try {
  browser = await launchBrowser();
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const errors = [];
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
    const [active, observer] = pages;
    const cycle = completed + 1;
    const began = performance.now();
    // Let a disconnected observer miss an offer and catch up to the latest release.
    if (cycle % 3 === 0) await contexts[1].setOffline(true);
    await active.locator("#rehearse-comparison").click();
    await active.waitForFunction(() => document.querySelector("#release-feedback").textContent.includes("Rehearsal passed"));
    await active.locator("#approve-comparison").click();
    await active.locator("#layer-compare:visible").waitFor({timeout:20000});
    if (cycle % 3 === 0) await contexts[1].setOffline(false);
    await observer.locator("#layer-compare:visible").waitFor({timeout:20000});
    assert.equal(await active.locator("#layer-checks").getAttribute("aria-pressed"), "true");
    assert.equal(await observer.locator("#layer-diff").getAttribute("aria-pressed"), "true");
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
    await active.locator("#restore-review").click();
    await Promise.all(pages.map(page => page.locator("#layer-compare").waitFor({state:"hidden",timeout:20000})));
    const final = (await (await active.request.get(new URL("/api/state", desk.url).href)).json()).draft;
    assert.equal(final.base, original.base);
    assert.equal(sha(final.diff), identity);
    assert.deepEqual(await Promise.all(pages.map(page => page.evaluate(() => performance.timeOrigin))), origins);
    assert.deepEqual(errors, []);
    completed++;
    log("cycle", {cycle, elapsedMs:Math.round(performance.now() - began), fixed:result.summary.fixed,
      regressed:result.summary.regressed, release:result.releaseVersion, documentsPreserved:pages.length,
      observerMissedOffer:cycle % 3 === 0});
    const left = started + duration * 60000 - Date.now();
    if (left <= 0) break;
    await delay(Math.min(interval * 1000, left));
  } while (Date.now() < started + duration * 60000);
  log("complete", {cycles:completed, elapsedSeconds:Math.round((Date.now()-started)/1000)});
} finally {
  await browser?.close();
  await desk.close();
}
