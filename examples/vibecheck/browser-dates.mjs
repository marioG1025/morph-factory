// Exercise the checked-out React app and its actual navigation with a local fixture API.
import assert from "node:assert/strict";
import {appendFileSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {launchBrowser} from "../../tests/browser/desk.mjs";

const zones = ["America/Los_Angeles", "Pacific/Honolulu", "Asia/Tokyo", "UTC"];
// Each civil-day oracle lists the actual English strings for the two product routes.
const labels = {
  leap: ["Tue, Feb 29, 2028", "Tuesday, February 29, 2028"],
  march1: ["Wed, Mar 1, 2028", "Wednesday, March 1, 2028"],
  spring: ["Sun, Mar 14, 2027", "Sunday, March 14, 2027"],
  march15: ["Mon, Mar 15, 2027", "Monday, March 15, 2027"],
  fall: ["Sun, Nov 7, 2027", "Sunday, November 7, 2027"],
  nov6: ["Sat, Nov 6, 2027", "Saturday, November 6, 2027"]
};
// Expected day per zone in the same order as above. None of these inputs is in check-dates.cjs.
const fixtures = [
  ["leap-day", "2028-02-29", ["leap", "leap", "leap", "leap"]],
  ["dst-start", "2027-03-14", ["spring", "spring", "spring", "spring"]],
  ["dst-end", "2027-11-07", ["fall", "fall", "fall", "fall"]],
  ["tokyo-midnight", "2028-03-01T00:15:00+09:00", ["leap", "leap", "march1", "leap"]],
  ["pacific-evening", "2027-03-14T23:45:00-07:00", ["spring", "spring", "march15", "march15"]],
  ["offset-midnight", "2027-11-07T00:30:00-08:00", ["fall", "nov6", "fall", "fall"]]
];
const events = fixtures.map(([slug,date], index) => ({
  id:index + 1, event_id:slug, artist_names:"Calendar fixture " + slug, date, venue_area:"Dallas", artists:[]
}));
let failures = 0;
function record(id, name, status, detail) {
  if (process.env.MORPH_CASE_REPORT) {
    appendFileSync(process.env.MORPH_CASE_REPORT, JSON.stringify({id,name,status,detail}) + "\n");
  }
  if (status !== "passed") failures++;
  console.log(status.toUpperCase() + " " + name + " · " + detail);
}

function check(zone, event, route, actual, expected) {
  const name = route + " · " + zone + " · " + event.date;
  record(["browser",zone,event.event_id,route].join(":"), name,
    actual === expected ? "passed" : "failed", actual + " (expected " + expected + ")");
}

async function checkZone(browser, origin, zoneIndex) {
  const zone = zones[zoneIndex];
  const context = await browser.newContext({timezoneId:zone, locale:"en-US"});
  try {
    const requested = new Set(), errors = [];
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      requested.add(url.pathname);
      if (url.pathname === "/api/events") return route.fulfill({json:events});
      const event = events.find(e => url.pathname === "/api/events/" + e.event_id);
      return event ? route.fulfill({json:event}) : route.fulfill({status:404, json:{error:"Unknown fixture endpoint"}});
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", err => errors.push(err.message));
    await page.goto(origin);
    assert.equal(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), zone);
    for (const [index,event] of events.entries()) {
      const expected = labels[fixtures[index][2][zoneIndex]];
      const card = page.locator(".show-card").filter({has:page.getByText(event.artist_names, {exact:true})});
      check(zone, event, "list", (await card.locator(".show-date span").nth(1).innerText()).trim(), expected[0]);
      await card.click();
      await page.waitForURL(origin + "/show/" + event.event_id);
      const header = page.locator(".event-header");
      assert.equal(await header.locator("h1").innerText(), event.artist_names);
      const detail = header.locator(".meta-item").first().locator("span").nth(1);
      check(zone, event, "detail", (await detail.innerText()).trim(), expected[1]);
      await page.getByRole("button", {name:"Back to Shows"}).click();
      await page.waitForURL(origin + "/");
    }
    assert.deepEqual(errors, []);
    assert.ok(requested.has("/api/events"));
    for (const event of events) assert.ok(requested.has("/api/events/" + event.event_id));
  } finally { await context.close(); }
}

let server, browser;
try {
  const front = resolve("Music_Show_Helper/Frontend");
  const {createServer, version} = await import(pathToFileURL(resolve(front, "node_modules/vite/dist/node/index.js")).href);
  process.env.VITE_API_URL = "/api";
  server = await createServer({root:front, server:{host:"127.0.0.1",port:0}, logLevel:"error"});
  await server.listen();
  const origin = "http://127.0.0.1:" + server.httpServer.address().port;
  browser = await launchBrowser();
  console.log("VibeCheck browser runtime " + browser.browserType().name() + " " + browser.version() + ", Vite " + version);
  for (const index of zones.keys()) await checkZone(browser, origin, index);
} catch (err) {
  record("browser:harness", "VibeCheck product browser harness", "error", err.message);
} finally {
  await browser?.close();
  await server?.close();
}
process.exitCode = failures ? 1 : 0;
