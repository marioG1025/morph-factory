// Run this same external check against both Git trees in a factory comparison.
import {writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {resolve} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {pathToFileURL} from "node:url";

// The target checkout supplies the actual Python desk, browser client and LLP hosts.
// The operator installs Playwright once alongside this external check.
const requireBrowser = createRequire(new URL("../../tests/browser/package.json", import.meta.url));
process.env.MORPH_PLAYWRIGHT ||= requireBrowser.resolve("playwright");
const target = pathToFileURL(resolve("tests/browser/desk.mjs"));
const {startDesk, launchBrowser} = await import(target.href);
const tabCount = 8;
const desk = await startDesk();
let browser;
try {
  browser = await launchBrowser();
  const contexts = await Promise.all(Array.from({length:tabCount}, () => browser.newContext()));
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const failures = [];
  for (const page of pages) {
    page.on("pageerror", error => failures.push(error.message));
    page.on("requestfailed", request => failures.push(new URL(request.url()).pathname + " " + request.failure().errorText));
  }
  const start = performance.now();
  const opens = await Promise.allSettled(pages.map(async page => {
    await page.goto(desk.url, {waitUntil:"domcontentloaded", timeout:20000});
    await page.locator("#layer-diff:visible").waitFor({timeout:15000});
    return Math.round(performance.now() - start);
  }));
  const ready = opens.filter(result => result.status === "fulfilled").map(result => result.value);
  const statusUrl = new URL("/api/live/status", desk.url);
  let status = await (await fetch(statusUrl)).json();
  for (let i = 0; ready.length === tabCount && status.acknowledged < tabCount && i < 15; i++) {
    await delay(200);
    status = await (await fetch(statusUrl)).json();
  }
  const {draft} = await (await fetch(new URL("/api/state", desk.url))).json();
  const base = "6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24";
  const cases = [
    ["draft", "The desk opens the pinned VibeCheck patch", draft?.base === base, draft?.base || "Missing draft"],
    ["tabs", "Eight simultaneous tabs render and acknowledge the live review",
      ready.length === tabCount && status.acknowledged === tabCount,
      `${ready.length}/${tabCount} rendered; ${status.acknowledged}/${tabCount} acknowledged`],
    ["assets", "All review assets load without browser errors", failures.length === 0,
      failures.length ? failures.slice(0, 3).join(", ") : "No failed requests or page errors"],
  ].map(([id,name,passed,detail]) => ({id:"cold-open." + id, name, status:passed ? "passed" : "failed", detail}));
  console.log(JSON.stringify({browser:browser.version(), readyMs:ready, totalErrors:failures.length, cases}));
  if (process.env.MORPH_CASE_REPORT) {
    await writeFile(process.env.MORPH_CASE_REPORT, cases.map(row => JSON.stringify(row)).join("\n") + "\n");
  }
  if (cases.some(row => row.status !== "passed")) process.exitCode = 1;
} finally {
  await browser?.close();
  await desk.close();
}
