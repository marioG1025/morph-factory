// Run from the factory root after installing the tests/browser dependencies:
//   node scripts/restart-desk.mjs
//   node scripts/restart-desk.mjs --interrupt-notification
// Optionally set MORPH_VIBECHECK_REPO to clone an existing VibeCheck checkout locally.
// Both browser documents remain open when the Python desk and its LLP sidecar exit.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {isDeepStrictEqual} from "node:util";
import {launchBrowser, startDesk} from "../tests/browser/desk.mjs";

const base = "6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24";
const sharedKey = "shared/review/comparison";
const interruptNotice = process.argv[2] === "--interrupt-notification";
assert.ok(process.argv.length === (interruptNotice ? 3 : 2), "Supported option: --interrupt-notification");
const directory = await mkdtemp(join(tmpdir(), "morph-desk-restart-"));
const stateDir = join(directory, "state");
// Keeping the managed product here preserves its absolute checkout identity and state key.
const checkout = join(stateDir, "examples", "VibeCheck");
const start = port => startDesk({repo:null, stateDir, port, observeSidecar:true,
  env:interruptNotice ? {MORPH_TEST_NOTICE_DIR:directory} : {}});
let desk, browser;
const frames = [];
let reads = 0, operatorPosts = 0, peerPosts = 0;

async function until(predicate, message, timeout = 18000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw Error(message);
    await delay(100);
  }
}

function exited(pid) {
  try { process.kill(pid, 0); return false; }
  catch (err) { if (err.code !== "ESRCH") throw err; return true; }
}

function selection(el) {
  return {focused:document.activeElement === el, text:getSelection().toString(),
    top:el.scrollTop, left:el.scrollLeft};
}

async function compare(operator) {
  const posted = operator.waitForResponse(res => new URL(res.url()).pathname === "/api/compare" &&
    res.request().method() === "POST", {timeout:60000});
  await operator.locator("#layer-compare:enabled").click();
  const response = await posted;
  assert.equal(response.status(), 200);
  const report = await response.json();
  assert.equal(report.summary.fixed, 4);
  assert.equal(report.summary.unchanged, 2);
  await operator.locator('[data-comparison-run="' + report.run + '"]').waitFor();
  return report;
}

try {
  if (process.env.MORPH_VIBECHECK_REPO) {
    await mkdir(join(stateDir, "examples"), {recursive:true});
    execFileSync("git", ["clone", "--quiet", "--no-local", resolve(process.env.MORPH_VIBECHECK_REPO), checkout]);
    execFileSync("git", ["-C", checkout, "checkout", "--quiet", "--detach", base]);
  }
  desk = await start(0);
  const port = Number(new URL(desk.url).port);
  browser = await launchBrowser();
  const operator = await browser.newPage(), peer = await browser.newPage();
  const pages = [operator, peer];
  const origins = () => Promise.all(pages.map(page => page.evaluate(() => performance.timeOrigin)));
  const native = async path => {
    const response = await operator.request.get(new URL(path, desk.url).href);
    assert.equal(response.status(), 200, path);
    return response.json();
  };
  for (const page of pages) {
    page.on("request", req => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith("/api/comparisons/") && page === peer) reads++;
      if (path === "/api/compare" && req.method() === "POST") {
        if (page === peer) peerPosts++;
        else operatorPosts++;
      }
    });
  }
  peer.on("websocket", socket => socket.on("framereceived", msg => {
    const frame = JSON.parse(msg.payload.toString());
    if (frame.t !== "shared") return;
    const pair = frame.set.find(([key]) => key === sharedKey);
    if (pair) frames.push({full:frame.full === true, marker:JSON.parse(pair[1])});
  }));
  for (const page of pages) {
    await page.goto(desk.url);
    await page.locator("#approve-comparison:enabled").waitFor({timeout:45000});
  }
  const documents = await origins();
  await operator.locator("#layer-checks").click();
  await operator.locator("#approve-comparison").click();
  await peer.locator("#layer-compare:enabled").waitFor();
  const first = await compare(operator);
  await peer.locator('[data-comparison-run="' + first.run + '"]').waitFor();
  const prior = await native("/api/state");
  assert.equal(prior.draft.comparison.run, first.run);
  const digest = createHash("sha256").update(prior.draft.diff).digest("hex");
  const marker = run => ({run,base,digest,releaseVersion:first.releaseVersion});
  assert.deepEqual(frames, [{full:false, marker:marker(first.run)}]);
  const diff = peer.locator('#review-layer pre[aria-label="Unified diff"]');
  await diff.evaluate(el => {
    el.focus();
    const range = document.createRange(); range.selectNodeContents(el.querySelector(".diff-line"));
    getSelection().removeAllRanges(); getSelection().addRange(range); el.scrollTop = 36; el.scrollLeft = 14;
  });
  const beforeSelection = await diff.evaluate(selection);
  assert.ok(beforeSelection.focused && beforeSelection.text);
  const priorReads = reads;
  const pythonPid = desk.server.pid;
  const sidecarPid = Number(await readFile(join(desk.directory, "sidecar.pid"), "utf8"));
  assert.ok(Number.isInteger(sidecarPid) && sidecarPid > 0);
  let interruptedRun;
  if (interruptNotice) {
    await writeFile(join(directory, "stop-next-notice"), "");
    await operator.locator("#layer-compare:enabled").click();
    await until(() => desk.server.exitCode !== null, "Python did not stop on the armed comparison notification.");
    assert.equal(desk.server.exitCode, 86);
    interruptedRun = await readFile(join(directory, "interrupted-run"), "utf8");
    assert.match(interruptedRun, /^[0-9a-f]{32}$/);
    assert.notEqual(interruptedRun, first.run);
    // Inspect the committed native report before any replacement server has opened the desk.
    const files = (await readdir(stateDir)).filter(file => file.endsWith(".json"));
    assert.equal(files.length, 1);
    const saved = JSON.parse(await readFile(join(stateDir, files[0]), "utf8"));
    assert.equal(saved.draft.comparison.run, interruptedRun);
    assert.equal(frames.some(f => f.marker.run === interruptedRun), false);
    assert.equal(reads - priorReads, 0);
  }
  const beforeRestartPosts = operatorPosts + peerPosts;
  assert.equal(beforeRestartPosts, interruptNotice ? 2 : 1);
  await desk.close(); desk = undefined;
  await until(() => exited(pythonPid) && exited(sidecarPid), "Previous Python desk or sidecar still running.");

  desk = await start(port);
  const recovered = await native("/api/state");
  assert.equal(recovered.draft.comparison.run, interruptedRun || first.run);
  assert.equal(recovered.draft.diff, prior.draft.diff);
  assert.equal(recovered.draft.base, base);
  await until(async () => (await native("/api/live/status")).connected === 2, "Open tabs failed to rejoin.");
  await until(() => frames.some(f => f.full), "Peer missed persisted LLP snapshot.");
  const fullMarkers = frames.filter(f => f.full);
  let second = recovered.draft.comparison;
  let reconnectReads = reads - priorReads, beforeMeasure = priorReads;
  if (!interruptNotice) {
    assert.deepEqual(fullMarkers, [{full:true, marker:marker(first.run)}]);
    beforeMeasure = reads;
    second = await compare(operator);
    await until(() => frames.some(f => !f.full && f.marker.run === second.run), "Peer missed the new LLP delta.");
    assert.deepEqual(frames.at(-1), {full:false, marker:marker(second.run)});
    await until(() => reads > beforeMeasure, "Peer did not request the new report.");
  }
  assert.notEqual(second.run, first.run);
  assert.equal(second.releaseVersion, first.releaseVersion);
  const peerResult = peer.locator('[data-comparison-run="' + second.run + '"]');
  const rendered = await peerResult.waitFor({timeout:7000}).then(() => true, err => {
    if (err.name !== "TimeoutError") throw err;
    return false;
  });
  const panePreserved = await operator.locator("#layer-checks").getAttribute("aria-pressed") === "true" &&
    await peer.locator("#layer-diff").getAttribute("aria-pressed") === "true";
  const clean = execFileSync("git", ["-C", checkout, "status", "--porcelain"], {encoding:"utf8"}).trim() === "";
  let interruptedEvidence = {};
  if (interruptNotice) {
    reconnectReads = reads - priorReads;
    const invocations = await readFile(join(directory, "product-comparisons"), "utf8");
    const totalProductComparisons = invocations.trim().split(/\r?\n/).length;
    assert.equal(totalProductComparisons, 2);
    interruptedEvidence = {reportDurableBeforeExit:true, beforeExitNotice:false,
      durableRunInFullSnapshot:isDeepStrictEqual(fullMarkers, [{full:true, marker:marker(interruptedRun)}]),
      postRestartComparisons:operatorPosts + peerPosts - beforeRestartPosts, totalProductComparisons};
  }
  const evidence = {browser:browser.browserType().name() + " " + browser.version(), platform:process.platform,
    base, releaseVersion:second.releaseVersion, pythonAndSidecarExited:true,
    documentsPreserved:isDeepStrictEqual(await origins(), documents), panePreserved,
    peerSelectionPreserved:isDeepStrictEqual(await diff.evaluate(selection), beforeSelection),
    initialGeneration:prior.draftGeneration, recoveredGeneration:recovered.draftGeneration,
    priorRunViaFullSnapshot:fullMarkers.some(f => f.marker.run === first.run),
    newRunViaDelta:frames.some(f => !f.full && f.marker.run === second.run), reconnectReportReads:reconnectReads,
    newReportReads:reads - beforeMeasure, operatorComparisons:operatorPosts, peerComparisons:peerPosts,
    peerRenderedNewRun:rendered, fixed:second.summary.fixed, unchanged:second.summary.unchanged, productClean:clean,
    ...interruptedEvidence};
  console.log(JSON.stringify(evidence, null, 2));
  assert.equal(rendered, true, "Peer did not render the durable new report after restart.");
  assert.equal(recovered.draftGeneration, prior.draftGeneration);
  assert.equal(evidence.documentsPreserved, true);
  if (interruptNotice) {
    assert.equal(interruptedEvidence.durableRunInFullSnapshot, true);
    assert.equal(interruptedEvidence.postRestartComparisons, 0);
    await operator.locator('[data-comparison-run="' + second.run + '"]').waitFor();
  }
  assert.equal(reconnectReads, interruptNotice ? 1 : 0);
  assert.equal(reads - beforeMeasure, 1);
  assert.equal(operatorPosts, 2); assert.equal(peerPosts, 0);
  assert.equal(evidence.peerSelectionPreserved, true);
  assert.equal(panePreserved, true);
  assert.equal(await peerResult.locator('[data-kind="fixed"]').count(), 4);
  assert.equal(await peerResult.locator('[data-kind="unchanged"]').count(), 2);
  assert.equal(clean, true);
} finally {
  await browser?.close();
  await desk?.close();
  await rm(directory, {recursive:true,force:true,maxRetries:6,retryDelay:150});
}
