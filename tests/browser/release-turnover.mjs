// Cross the signed release boundary reached by the original one-hour run without
// requiring 61 minutes of idle time. The full endurance test measures wall time.
import assert from "node:assert/strict";
import {test} from "node:test";
import {launchBrowser, startDesk} from "./desk.mjs";

test("two connected reviewers can rehearse release 124 and compare after 61 restore cycles", {timeout:240000}, async t => {
  const desk = await startDesk({env:{MORPH_SESSION_TTL_MS:"1500"}});
  t.after(() => desk.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const pages = await Promise.all([browser.newPage(), browser.newPage()]);
  const grants = pages.map(() => ({sessions:0, sockets:0, denials:0, expiry:0}));
  const errors = [];
  await Promise.all(pages.map(async (page, i) => {
    page.on("pageerror", e => errors.push(e.message));
    page.on("response", async r => {
      if (new URL(r.url()).pathname !== "/api/live/session" || !r.ok()) return;
      const {token} = await r.json();
      grants[i].sessions++;
      grants[i].expiry = JSON.parse(Buffer.from(token.split(".")[0], "base64url")).e;
    });
    page.on("websocket", socket => {
      grants[i].sockets++;
      socket.on("framereceived", frame => {
        if (JSON.parse(frame.payload.toString()).code === "unauthorized") grants[i].denials++;
      });
    });
    await page.goto(desk.url);
    await page.locator("#approve-comparison:enabled").waitFor();
  }));
  const [active, peer] = pages;
  const origins = await Promise.all(pages.map(page => page.evaluate(() => performance.timeOrigin)));
  await active.locator("#layer-checks").click();
  async function live(resource, data) {
    const url = desk.url + "api/live/" + resource;
    const res = data ? await active.request.post(url, {data, headers:{Origin:new URL(url).origin}}) : await active.request.get(url);
    assert.equal(res.status(), 200, resource);
    return res.json();
  }
  async function acknowledged(version) {
    await active.waitForFunction(async expected => {
      const status = await (await fetch("/api/live/status")).json();
      return status.version === expected && status.acknowledged === 2;
    }, version, {timeout:15000});
  }
  let version = 1;
  for (let cycle = 1; cycle <= 61; cycle++) {
    const candidate = await live("candidate");
    assert.equal(candidate.serverRehearsal.ok, true, candidate.serverRehearsal.error);
    await live("approve", {expectedVersion:version, expectedDigest:candidate.digest});
    await acknowledged(++version);
    await live("restore", {expectedVersion:version});
    await acknowledged(++version);
  }
  assert.equal(version, 123);
  await active.locator("#rehearse-comparison").click();
  await active.waitForFunction(() => {
    const el = document.querySelector("#release-feedback");
    return el.dataset.error === "true" || el.textContent.includes("Rehearsal passed");
  });
  assert.match(await active.locator("#release-feedback").textContent(), /Rehearsal passed/);
  await active.locator("#approve-comparison").click();
  await acknowledged(++version);
  const response = active.waitForResponse(r => new URL(r.url()).pathname === "/api/compare" && r.request().method() === "POST");
  await active.locator("#layer-compare:enabled").click();
  const report = await (await response).json();
  assert.equal(report.releaseVersion, 124);
  assert.equal(report.summary.fixed, 4);
  assert.equal(report.summary.unchanged, 2);
  await peer.locator('[data-comparison-run="' + report.run + '"] .comparison-conclusion').waitFor();
  assert.deepEqual(await Promise.all(pages.map(page => page.evaluate(() => performance.timeOrigin))), origins);
  assert.equal(await active.locator("#layer-checks").getAttribute("aria-pressed"), "true");
  for (const {sessions, sockets, denials, expiry} of grants) {
    assert.ok(expiry > 0 && Date.now() > expiry, "The original handshake credential has expired.");
    assert.deepEqual([sessions, sockets, denials], [1, 1, 0]);
  }
  assert.deepEqual(errors, []);
});
