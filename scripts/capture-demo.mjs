// Run after installing tests/browser dependencies. Capture the live VibeCheck flow
// in a fresh, disposable desk. The frames include the review panel only.
import assert from "node:assert/strict";
import {mkdir} from "node:fs/promises";
import {join, resolve} from "node:path";
import {launchBrowser, startDesk} from "../tests/browser/desk.mjs";

const destination = process.argv[2];
if (!destination) throw Error("Supply a directory for the captures and example receipt.");
const dir = resolve(destination);
await mkdir(dir, {recursive:true});
const desk = await startDesk();
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage({viewport:{width:1400,height:1000}, deviceScaleFactor:1});
  await page.goto(desk.url);
  await page.locator("#layer-checks").click();
  await page.waitForFunction(() => document.querySelector("#layer-checks")?.getAttribute("aria-pressed") === "true");
  const documentTime = await page.evaluate(() => performance.timeOrigin);
  const panel = page.locator("#change-panel");
  const capture = (name, region = panel) => region.screenshot({path:join(dir,name + ".png"), animations:"disabled"});
  await capture("01-open-review");
  await page.locator("#rehearse-comparison").click();
  await page.waitForFunction(() => document.querySelector("#release-feedback").textContent.includes("Rehearsal passed"));
  await capture("02-rehearsed");
  await page.locator("#approve-comparison").click();
  await page.locator("#layer-compare:enabled").waitFor();
  await capture("03-approved");
  await page.locator("#layer-compare").click();
  await page.locator(".comparison-conclusion").waitFor({timeout:90000});
  assert.equal(await page.locator('.comparison-cases [data-kind="fixed"]').count(), 4);
  assert.equal(await page.evaluate(() => performance.timeOrigin), documentTime);
  await capture("04-results", page.locator(".comparison-panel"));
  await page.locator("#release-record summary").click();
  const download = page.waitForEvent("download");
  await page.locator("#export-receipt").click();
  await (await download).saveAs(join(dir, "vibecheck-review.json"));
  console.log("Captured a working signed release, four fixed date cases, and an exportable receipt.");
} finally {
  await browser?.close();
  await desk.close();
}
