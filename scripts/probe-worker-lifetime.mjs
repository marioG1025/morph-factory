// Use the two shipping review modules to compare client-worker retirement policies.
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {generatePublisherKey, signManifest} from "../runtime/vendor/llp/llp-core.js";
import {startHost} from "../runtime/review-host.mjs";
import {launchBrowser} from "../tests/browser/desk.mjs";

const policy = process.argv[2] || "retire";
if (!["retire", "reference", "eight-loads"].includes(policy) || process.argv.length > 3) {
  throw Error("Usage: node scripts/probe-worker-lifetime.mjs [retire|reference|eight-loads]");
}
const pairs = 72;
const directory = await mkdtemp(join(tmpdir(), "morph-lifetime-"));
let server, browser;
try {
  server = await startHost(directory);
  const baseline = (await server.command({op: "evidence"})).manifest;
  const compare = (await server.command({op: "candidate"})).manifest;
  const blobs = {};
  for (const {layers} of [baseline, compare]) {
    blobs[layers.review] = (await server.command({op: "blob", hash: layers.review})).data;
  }
  // Keep each production manifest's module hashes, placement and grants. A fresh
  // disposable signer gives every offer its own monotonically increasing version.
  const {privateKey, publicJwk} = await generatePublisherKey();
  const offers = [];
  for (let version = 1; version <= 2 * pairs + 1; version++) {
    const manifest = {...(version % 2 ? baseline : compare), version};
    offers.push({manifest, sig: await signManifest(manifest, privateKey)});
  }
  browser = await launchBrowser();
  const page = await browser.newPage();
  const core = await readFile(new URL("../runtime/vendor/llp/llp-core.js", import.meta.url));
  await page.route("http://127.0.0.1/**", route => route.request().url().endsWith("/llp-core.js") ?
    route.fulfill({contentType: "text/javascript", body: core}) :
    route.fulfill({contentType: "text/html", body: "<!doctype html><title>LLP worker lifetime</title>"}));
  await page.goto("http://127.0.0.1/");
  const result = await page.evaluate(async ({offers, blobs, publicJwk, policy}) => {
    const {LiveHost} = await import("/llp-core.js");
    const retirements = new WeakMap();
    let inlineFallbacks = 0;
    class ProbeHost extends LiveHost {
      retire(slot, previous, version) {
        const count = (retirements.get(previous.box) || 0) + 1;
        retirements.set(previous.box, count);
        if (policy === "retire" || (policy === "eight-loads" && count >= 8)) previous.box.kill();
        else super.retire(slot, previous, version);
      }
    }
    const clients = [];
    const makeHost = () => {
      const host = new ProbeHost({app: offers[0].manifest.app, trustedKeys: [publicJwk],
        onLog: e => { if (e.msg.includes("blocks workers")) inlineFallbacks++; }});
      host.kv.set("desk/hasDraft", 1);
      host.kv.set("desk/title", "Keep concert dates on the advertised day");
      host.kv.set("desk/identity", "fixture-calendar-draft");
      return host;
    };
    const readBlob = hash => Uint8Array.from(atob(blobs[hash]), char => char.charCodeAt(0));
    let completedPairs = 0, attemptedVersion, stage;
    async function apply(host, offer, description) {
      attemptedVersion = offer.manifest.version;
      stage = description;
      const result = await host.apply(offer.manifest, offer.sig, readBlob);
      if (!result.ok) throw Error(result.reason);
    }
    try {
      for (let i = 0; i < 2; i++) {
        const client = makeHost();
        clients.push(client);
        await apply(client, offers[0], "initial baseline");
      }
      for (let index = 1; index < offers.length; index += 2) {
        const shadow = makeHost();
        try {
          await apply(shadow, offers[index - 1], "rehearsal baseline");
          await apply(shadow, offers[index], "rehearsal candidate");
        } finally { shadow.close(); }
        for (const client of clients) await apply(client, offers[index], "compare");
        for (const client of clients) await apply(client, offers[index + 1], "restore");
        completedPairs++;
      }
      return {completedPairs, inlineFallbacks};
    } catch (error) {
      return {completedPairs, attemptedVersion, stage, error: error.message, inlineFallbacks};
    } finally { for (const client of clients) client.close(); }
  }, {offers, blobs, policy, publicJwk});
  console.log(JSON.stringify({engine: process.env.MORPH_BROWSER_ENGINE || "chromium", browser: browser.version(), policy, pairs, ...result}));
  if (result.error) process.exitCode = 1;
} finally {
  try { await browser?.close(); }
  finally {
    server?.close();
    await rm(directory, {recursive: true, force: true});
  }
}
