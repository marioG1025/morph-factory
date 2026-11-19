// Stream a review release while VibeCheck is building in a real disposable checkout.
import assert from "node:assert/strict";
import {launchBrowser, startDesk} from "../tests/browser/desk.mjs";

const desk = await startDesk();
let browser;
try {
  browser = await launchBrowser();
  const operator = await browser.newPage(), observer = await browser.newPage();
  await operator.goto(new URL("lab/vibecheck.html", desk.url).href);
  await operator.locator("#load-build").click();
  await operator.locator("#replace").click();
  await operator.locator("#layer-verify").waitFor();
  await observer.goto(desk.url);
  await observer.locator("#layer-diff").click();
  const pages = [operator, observer];
  const origins = () => Promise.all(pages.map(page => page.evaluate(() => performance.timeOrigin)));
  const documents = await origins();
  const matches = endpoint => req => new URL(req.url()).pathname === "/api/" + endpoint && req.method() === "POST";
  const started = operator.waitForRequest(matches("verify"));
  const finished = operator.waitForResponse(res => matches("verify")(res.request()), {timeout:180000});
  let checkFinishedAt = null;
  const check = finished.then(async res => {
    checkFinishedAt = performance.now();
    assert.equal(res.status(), 200);
    return (await res.json()).draft.verification;
  });
  const began = performance.now();
  await operator.locator("#layer-verify").click();
  await started;
  await observer.locator("#approve-comparison").click();
  await Promise.all(pages.map(page => page.locator("#layer-compare:visible").waitFor()));
  const bothAdopted = performance.now();
  const checked = await check;
  assert(checked.ok, "The candidate’s real frontend build failed. " + checked.output);
  assert(bothAdopted < checkFinishedAt, "The build completed before both tabs adopted the release.");
  assert.equal(await observer.locator("#layer-diff").getAttribute("aria-pressed"), "true");
  const compared = observer.waitForResponse(res => matches("compare")(res.request()), {timeout:280000});
  await observer.locator("#layer-compare:enabled").click();
  const response = await compared;
  assert.equal(response.status(), 200);
  const report = await response.json();
  assert.equal(report.baseline.status, "failed");
  assert.equal(report.candidate.status, "passed");
  assert.equal(report.summary.fixed, 1);
  assert.equal(report.candidateTree, checked.tree);
  assert.deepEqual(await origins(), documents);
  console.log(JSON.stringify({recordedAt:new Date().toISOString(), product:"VibeCheck", base:report.base,
    candidateTree:report.candidateTree, documentsPreserved:pages.length,
    bothTabsAdoptedDuringBuild:true, millisecondsFromVerifyClickToBothTabs:Math.round(bothAdopted - began),
    millisecondsFromVerifyClickToBuildResult:Math.round(checkFinishedAt - began),
    original:report.baseline.status, candidate:report.candidate.status, counts:report.summary}, null, 2));
} finally {
  await browser?.close();
  await desk.close();
}
