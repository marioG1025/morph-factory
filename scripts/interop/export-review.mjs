// Produce a fresh comparison fixture from releases that the real factory server accepted.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { APP, startHost } from "../../runtime/review-host.mjs";
import { LiveHost } from "../../runtime/vendor/llp/llp-core.js";

const directory = process.argv[2];
if (!directory) throw Error("Pass a temporary output directory.");
const service = await startHost(join(directory, "authority"));
const publicKey = service.session().publicKey;
const host = new LiveHost({app: APP, trustedKeys: [publicKey]});
const seed = {
  "desk/hasDraft": 1,
  "desk/title": "Keep date-only concerts on the advertised day",
  "desk/summary": "VibeCheck · calendar-day.patch",
  "desk/identity": "interop:calendar-day",
  "desk/hasComparison": 0,
};
const fixture = {app: APP, publicKey, seed, blobs: {}, releases: [], steps: []};
for (const [key, value] of Object.entries(seed)) host.kv.set(key, value);

function find(tree, predicate) {
  return [tree, ...(tree.c || []).flatMap(node => find(node, () => true))].filter(predicate);
}

async function record(label, action, fields, expectedDocuments) {
  const views = await host.render();
  assert.deepEqual(views.map(v => v.slot), ["review"], "Only the client slot runs here");
  const tree = views[0].tree;
  const docs = find(tree, node => node.k === "document").map(node => node.a.source);
  assert.deepEqual(docs, expectedDocuments, "Expected renderer instructions for " + label);
  const buttons = find(tree, node => node.k === "button").map(node => node.a.id);
  assert.equal(buttons.includes("compare"), service.status().release === "compare");
  fixture.steps.push({label, action, ...fields, tree, store: Object.fromEntries(host.kv)});
}

async function applyRelease(label, expectedDocuments) {
  // ServerHost records the untouched signed envelope used by its client relay.
  const {manifest, sig} = service.runtime.tenant(APP).releases.get(null);
  const response = await service.command({op: "blob", hash: manifest.layers.review});
  fixture.blobs[manifest.layers.review] = response.data;
  fixture.releases.push({manifest, sig});
  const result = await host.apply(manifest, sig, async hash => {
    assert.ok(Object.hasOwn(fixture.blobs, hash), "Client requested a non-client blob");
    return Buffer.from(fixture.blobs[hash], "base64");
  });
  assert.ok(result.ok, result.reason);
  await record(label, "apply", {release: fixture.releases.length - 1}, expectedDocuments);
}

try {
  await applyRelease("Review opens on the diff", ["diff"]);
  await host.dispatch("review", "checks");
  await record("Operator selects Check output", "dispatch", {event: "checks"}, ["checks"]);

  const offered = await service.command({op: "candidate"});
  await service.command({op: "approve", expectedVersion: service.status().version,
    expectedDigest: offered.digest});
  await applyRelease("Compare appears on the selected checks tab", ["checks"]);

  host.kv.set("desk/hasComparison", 1);
  await record("Host supplies comparison evidence", "set", {key: "desk/hasComparison", value: 1},
    ["checks", "comparison"]);
  await service.command({op: "restore", expectedVersion: service.status().version});
  await applyRelease("Restore keeps the tab and hides Compare", ["checks"]);
  await host.dispatch("review", "diff");
  await record("Operator returns to the diff", "dispatch", {event: "diff"}, ["diff"]);
  await writeFile(join(directory, "fixture.json"), JSON.stringify(fixture));
} finally {
  host.close();
  service.close();
}
