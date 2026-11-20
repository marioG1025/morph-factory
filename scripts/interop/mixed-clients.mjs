// Run from the factory root. The LLP checkout supplies the original client.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {launchBrowser, startDesk} from "../../tests/browser/desk.mjs";

if (process.argv.length !== 3) throw Error("Supply the path to a Live Layer Protocol clone containing the original d14ebf9 client.");
const upstream = resolve(process.argv[2]);
const inventory = JSON.parse(await readFile(new URL("../../docs/upstream/inventory.json",import.meta.url), "utf8"));
const commits = ["d14ebf9f8d17a45a3619231d4a9c63c00845bf96", inventory.commit];
const originalCore = execFileSync("git", ["-C", upstream, "show", commits[0] + ":host/llp-core.js"]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const expected = [hash(originalCore), inventory.files.find(f => f.local === "runtime/vendor/llp/llp-core.js").sha256];
assert.notEqual(expected[0], expected[1]);
const route = "/vendor/llp/llp-core.js";
const desk = await startDesk();
let browser;
try {
  browser = await launchBrowser();
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  // Only this tab keeps the host core from the original version. Both receive
  // the shipping connection adapter, review Wasm and live server responses.
  await contexts[0].route("**" + route, request => request.fulfill({contentType:"text/javascript", body:originalCore}));
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const counts = pages.map(() => ({posts:0, reads:0}));
  const pageErrors = [];
  const loaded = await Promise.all(pages.map(async (page, index) => {
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("request", req => {
      const path = new URL(req.url()).pathname;
      if (path === "/api/compare" && req.method() === "POST") counts[index].posts++;
      if (path.startsWith("/api/comparisons/")) counts[index].reads++;
    });
    const core = page.waitForResponse(r => new URL(r.url()).pathname === route);
    await page.goto(desk.url);
    await page.locator("#layer-diff:enabled").waitFor();
    // The local source tree can have CRLF even though the upstream object uses LF.
    return hash(Buffer.from((await (await core).body()).toString("utf8").replaceAll("\r\n", "\n")));
  }));
  assert.deepEqual(loaded, expected, "Each tab must execute the selected upstream host");
  await pages[0].locator("#layer-diff").click();
  await pages[1].locator("#layer-checks").click();
  const origins = await Promise.all(pages.map(page => page.evaluate(() => performance.timeOrigin)));
  const observations = [];
  for (const active of [0,1]) {
    const peer = 1 - active;
    const actorPage = pages[active], peerPage = pages[peer];
    const before = counts.map(count => ({...count}));
    await actorPage.locator("#rehearse-comparison").click();
    await actorPage.locator("#release-feedback").filter({hasText:"Rehearsal passed"}).waitFor();
    await actorPage.locator("#approve-comparison").click();
    await Promise.all(pages.map(page => page.locator("#layer-compare:enabled").waitFor()));
    const response = actorPage.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/compare");
    await actorPage.locator("#layer-compare").click();
    const result = await (await response).json();
    await peerPage.locator('[data-comparison-run="' + result.run + '"] .comparison-conclusion').waitFor();
    assert.equal(result.releaseVersion, 2 + active * 2);
    assert.equal(result.summary.fixed, 4);
    assert.equal(result.summary.unchanged, 2);
    assert.equal(result.summary.regressed, 0);
    assert.equal(counts[active].posts - before[active].posts, 1);
    assert.equal(counts[peer].posts - before[peer].posts, 0);
    assert.equal(counts[peer].reads - before[peer].reads, 1);
    await actorPage.locator("#restore-review").click();
    await Promise.all(pages.map(page => page.locator("#layer-compare").waitFor({state:"hidden"})));
    assert.deepEqual(await Promise.all(pages.map(page => page.evaluate(() => performance.timeOrigin))), origins);
    for (const [index,selector] of ["#layer-diff","#layer-checks"].entries()) {
      assert.equal(await pages[index].locator(selector).getAttribute("aria-pressed"),"true");
    }
    observations.push({operator:commits[active].slice(0,7),observer:commits[peer].slice(0,7),
      version:result.releaseVersion,base:result.base,tree:result.candidateTree,fixed:result.summary.fixed,
      unchanged:result.summary.unchanged,passiveReads:1,passivePosts:0,documentsPreserved:2});
  }
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({browser:browser.version(), clientHashes:loaded, observations}, null, 2));
} finally {
  await browser?.close();
  await desk.close();
}
