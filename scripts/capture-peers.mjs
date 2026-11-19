// Capture two real Change review panels throughout one measured comparison.
import assert from "node:assert/strict";
import {mkdir, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {launchBrowser, startDesk} from "../tests/browser/desk.mjs";

if (!process.argv[2]) throw Error("Supply a scratch directory for the paired browser frames.");
const destination = resolve(process.argv[2]);
await mkdir(destination, {recursive:true});
const desk = await startDesk();
let browser, recorder;
const frames = [];
let recording = true, caption = 0, camera = "overview";

async function capture(page, side, number, focus) {
  const box = await page.evaluate(focus => {
    const panel = document.querySelector("#change-panel").getBoundingClientRect();
    let target = panel;
    if (focus !== "overview") {
      const selector = focus === "results" ? ".comparison-conclusion" : ".comparison-panel";
      target = document.querySelector(selector)?.getBoundingClientRect() || panel;
    }
    // The crop always stays inside the live panel, including when the content is short.
    const y = Math.max(panel.top, target.top - 12);
    return {x:Math.ceil(panel.left + scrollX), y:Math.ceil(y + scrollY),
      width:Math.floor(panel.width) - 1, height:Math.min(500, Math.floor(panel.bottom - y) - 1)};
  }, focus);
  const file = side + "-" + String(number).padStart(3,"0") + ".png";
  await page.screenshot({path:join(destination,file), fullPage:true, clip:box, animations:"allow"});
  return file;
}

try {
  browser = await launchBrowser();
  const context = await browser.newContext({viewport:{width:960,height:900},deviceScaleFactor:1});
  const operator = await context.newPage(), peer = await context.newPage();
  let operatorPosts = 0, peerPosts = 0;
  for (const page of [operator,peer]) {
    page.on("request", req => {
      if (req.method() === "POST" && new URL(req.url()).pathname === "/api/compare") {
        if (page === operator) operatorPosts++;
        else peerPosts++;
      }
    });
    await page.goto(desk.url);
    await page.locator("#approve-comparison:enabled").waitFor();
  }
  await operator.locator("#layer-checks").click();
  await peer.locator("#layer-diff").click();
  await peer.locator('.live-document[aria-label="Unified diff"]').evaluate(el => {
    const added = el.querySelector(".diff-line.add");
    if (added) el.scrollTop = added.getBoundingClientRect().top - el.getBoundingClientRect().top;
    el.focus();
  });
  const documents = await Promise.all([operator,peer].map(page => page.evaluate(() => performance.timeOrigin)));
  const started = performance.now();
  recorder = (async () => {
    while (recording) {
      const at = Math.round(performance.now() - started);
      const index = frames.length, current = caption, focus = camera;
      const [left,right] = await Promise.all([capture(operator,"operator",index,focus), capture(peer,"peer",index,focus)]);
      frames.push({at, caption:current, left, right});
      await delay(Math.max(0, 240 - (performance.now() - started - at)));
    }
  })();
  await delay(3300);
  caption = 1;
  await operator.locator("#approve-comparison").hover();
  await delay(1000);
  await operator.locator("#approve-comparison").click();
  await Promise.all([operator,peer].map(page => page.locator("#layer-compare:enabled").waitFor()));
  await delay(1550);
  caption = 2; camera = "compare";
  await delay(3000);
  caption = 3;
  await operator.locator("#layer-compare").hover();
  await delay(950);
  const measured = operator.waitForResponse(r => r.url().endsWith("/api/compare") && r.request().method() === "POST");
  await operator.locator("#layer-compare").click();
  const result = await (await measured).json();
  for (const page of [operator,peer]) {
    await page.locator('[data-comparison-run="' + result.run + '"] .comparison-conclusion').waitFor();
    assert.equal(await page.locator('.comparison-cases [data-kind="fixed"]').count(), 4);
    assert.equal(await page.locator('.comparison-cases [data-kind="unchanged"]').count(), 2);
  }
  assert.equal(operatorPosts, 1); assert.equal(peerPosts, 0);
  await delay(900);
  caption = 4; camera = "results";
  await delay(5400);
  caption = 5; camera = "overview";
  await operator.locator("#restore-review").hover();
  await delay(1350);
  await operator.locator("#restore-review").click();
  await Promise.all([operator,peer].map(page => page.locator("#layer-compare").waitFor({state:"detached"})));
  await delay(900);
  caption = 6;
  assert.equal(await operator.locator("#layer-checks").getAttribute("aria-pressed"), "true");
  assert.equal(await peer.locator("#layer-diff").getAttribute("aria-pressed"), "true");
  assert.deepEqual(await Promise.all([operator,peer].map(page => page.evaluate(() => performance.timeOrigin))), documents);
  await delay(3000);
  recording = false;
  await recorder;
  await writeFile(join(destination,"frames.json"), JSON.stringify({duration:Math.round(performance.now() - started),
    frames, operatorPosts, peerPosts, fixed:result.summary.fixed, unchanged:result.summary.unchanged}));
  console.log("Recorded " + frames.length + " real panel pairs, one comparison, and its matching peer result.");
} finally {
  recording = false;
  try { await recorder; } finally {await browser?.close(); await desk.close();}
}
