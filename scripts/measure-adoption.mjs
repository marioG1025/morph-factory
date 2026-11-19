// Time real approvals in disposable VibeCheck desks. Browser observers capture the
// timestamps in each document; Playwright polling is outside the measured interval.
import assert from "node:assert/strict";
import {cpus, freemem, release, totalmem} from "node:os";
import {parseArgs} from "node:util";
import {launchBrowser, startDesk} from "../tests/browser/desk.mjs";

const {values} = parseArgs({options:{
  tabs:{type:"string", default:"1,2,4"}, trials:{type:"string", default:"3"},
  modes:{type:"string", default:"implicit,rehearsed"},
}});
const tabs = values.tabs.split(",").map(Number);
const trials = Number(values.trials);
const modes = values.modes.split(",");
if (!tabs.length || !tabs.every(n => Number.isSafeInteger(n) && n > 0) ||
    !Number.isSafeInteger(trials) || trials < 1 || !modes.every(m => ["implicit","rehearsed"].includes(m))) {
  throw Error("Use --tabs 1,2,4 --trials 3 --modes implicit,rehearsed.");
}
const log = (kind, values) => console.log(JSON.stringify({kind, ...values}));
const gib = bytes => Number((bytes / 2 ** 30).toFixed(2));

async function draftState(page) {
  return page.evaluate(async () => {
    const {draft} = window.morphDesk.snapshot().state;
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(draft.diff));
    const selected = document.querySelector('#review-layer [aria-pressed="true"]')?.id;
    const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    return {document:performance.timeOrigin, selected, base:draft.base, digest};
  });
}

async function arm(page, operator) {
  await page.evaluate(operator => {
    const clock = () => performance.timeOrigin + performance.now();
    const times = window.adoptionTimes = {};
    if (operator) document.querySelector("#approve-comparison").addEventListener("click", event => {
      if (event.isTrusted) times.click = clock();
    }, {capture:true, once:true});
    const observer = new MutationObserver(() => {
      const button = document.querySelector("#layer-compare:enabled");
      if (!button || !button.getClientRects().length || getComputedStyle(button).visibility !== "visible") return;
      times.ready = clock();
      observer.disconnect();
    });
    observer.observe(document.querySelector("#change-panel"), {subtree:true, childList:true, attributes:true});
  }, operator);
}

async function waitForReviewAcks(page, count) {
  await page.waitForFunction(async n => {
    const status = await (await fetch("/api/live/status")).json();
    return status.release === "review" && status.connected === n && status.acknowledged === n;
  }, count);
}

async function compareAcrossTabs(pages, actor) {
  const posts = pages.map(() => 0), reads = pages.map(() => 0);
  for (const [index,page] of pages.entries()) {
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path === "/api/compare") posts[index]++;
      if (request.method() === "GET" && /^\/api\/comparisons\/[0-9a-f]{32}$/.test(path)) reads[index]++;
    });
  }
  const response = actor.waitForResponse(r => r.url().endsWith("/api/compare") && r.request().method() === "POST");
  const started = performance.now();
  await actor.locator("#layer-compare").click();
  const report = await (await response).json();
  assert.equal(report.summary.fixed, 4);
  assert.equal(report.summary.unchanged, 2);
  const pane = '[data-comparison-run="' + report.run + '"]';
  await Promise.all(pages.map(page => page.locator(pane + " .comparison-conclusion").waitFor()));
  const allVisibleMs = Math.round(performance.now() - started);
  for (const [index,page] of pages.entries()) {
    assert.equal(posts[index], Number(page === actor));
    assert.equal(reads[index], Number(page !== actor));
    assert.equal(await page.locator(pane + ' [data-kind="fixed"]').count(), 4);
  }
  return {fixed:report.summary.fixed, unchanged:report.summary.unchanged, allVisibleMs, posts, reads};
}

async function measureGroup(size, mode) {
  let desk, browser;
  let trial = 0;
  try {
    desk = await startDesk();
    browser = await launchBrowser();
    const context = await browser.newContext();
    const pages = [];
    const errors = [];
    for (let i = 0; i < size; i++) {
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      pages.push(page);
      await page.goto(desk.url);
      await page.locator("#approve-comparison:enabled").waitFor({timeout:45000});
      await page.locator(i % 2 ? "#layer-diff" : "#layer-checks").click();
      await page.locator(i % 2 ? '#layer-diff[aria-pressed="true"]' : '#layer-checks[aria-pressed="true"]').waitFor();
    }
    const original = await Promise.all(pages.map(draftState));
    assert.equal(new Set(original.map(state => state.document)).size, size, "Each tab has its own document");
    const operator = pages[0];
    await waitForReviewAcks(operator, size);
    const browserFamily = await operator.evaluate(() => navigator.userAgent.includes("Edg/") ? "Edge" : "Chromium");
    log("group", {tabs:size, mode, browserFamily, browser:browser.version(), freeGiB:gib(freemem())});
    for (trial = 1; trial <= trials; trial++) {
      if (mode === "rehearsed") {
        await operator.locator("#rehearse-comparison").click();
        await operator.waitForFunction(() => document.querySelector("#release-feedback").textContent.startsWith("Rehearsal passed."));
      }
      await Promise.all(pages.map((page, i) => arm(page, i === 0)));
      await operator.locator("#approve-comparison:enabled").click();
      await Promise.all(pages.map(page => page.waitForFunction(() => Number.isFinite(window.adoptionTimes?.ready),
        undefined, {timeout:35000})));
      const times = await Promise.all(pages.map(page => page.evaluate(() => window.adoptionTimes)));
      const offsets = times.map(t => Math.round(t.ready - times[0].click));
      assert.ok(offsets.every(n => Number.isFinite(n) && n >= 0), "Observer clocks must follow the trusted click");
      assert.deepEqual(await Promise.all(pages.map(draftState)), original);
      assert.deepEqual(errors, []);
      const status = await (await operator.request.get(new URL("/api/live/status", desk.url).href)).json();
      assert.equal(status.release, "compare");
      const lastMs = Math.max(...offsets);
      log("trial", {tabs:size, mode, trial, temperature:trial === 1 ? "first-offer" : "repeat",
        lastMs, perTabMs:offsets, release:status.version, continuity:true, freeGiB:gib(freemem())});
      if (trial === trials) {
        const slowest = pages[offsets.indexOf(lastMs)];
        const result = await compareAcrossTabs(pages, slowest);
        assert.deepEqual(await Promise.all(pages.map(draftState)), original);
        assert.deepEqual(errors, []);
        log("comparison", {tabs:size, mode, ...result});
      } else {
        await operator.locator("#restore-review:enabled").click();
        await Promise.all(pages.map(page => page.locator("#layer-compare").waitFor({state:"detached"})));
        await waitForReviewAcks(operator, size);
      }
    }
  } catch (error) {
    log("failure", {tabs:size, mode, trial, error:error.message, freeGiB:gib(freemem())});
    process.exitCode = 1;
  } finally {
    await browser?.close();
    await desk?.close();
  }
}

log("machine", {os:process.platform, kernel:release(), cpu:cpus()[0]?.model, logicalCpus:cpus().length,
  ramGiB:gib(totalmem()), freeGiB:gib(freemem()), node:process.version});
for (const size of tabs) for (const mode of modes) await measureGroup(size, mode);
