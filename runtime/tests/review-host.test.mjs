import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startHost } from "../review-host.mjs";
import { canonical, LiveHost, sha256, verifyManifest } from "../vendor/llp/llp-core.js";
import { connectServer } from "../vendor/llp/remote-client.mjs";

async function until(condition, description) {
  const deadline = Date.now() + 10000;
  while (!condition()) {
    if (Date.now() >= deadline) throw Error("Timed out waiting for " + description);
    await delay(20);
  }
}

function openClient(session) {
  const host = new LiveHost({app: session.app, trustedKeys: [session.publicKey]});
  host.kv.set("desk/title", "Keep concert dates on the advertised day");
  const link = connectServer(host, session.endpoint, {app: session.app, token: session.token,
    retryMs: 30, queueMs: 4000, upgradeWaitMs: 2000});
  return {host, link, close: () => { link.close(); host.close(); }};
}

test("an approved live release reaches open review clients after server activation and survives restart", async t => {
  const directory = await mkdtemp(join(tmpdir(), "morph-live-"));
  let server = await startHost(directory);
  const first = server.session();
  const clients = [openClient(first), openClient(first)];
  t.after(async () => {
    for (const client of clients) client.close();
    server.close();
    await rm(directory, {recursive: true, force: true});
  });
  await until(() => server.status().acknowledged === 2, "both baseline ACKs");
  assert.equal(first.release, "review");
  assert.notEqual(first.reviewHash, first.serverHash);
  assert.equal(server.runtime.wss.address().address, "127.0.0.1");
  await assert.rejects(server.command({op: "requireCompare"}), /approved factory release/);

  const proposed = await server.command({op: "candidate"});
  assert(await verifyManifest(proposed.manifest, proposed.sig, first.publicKey));
  const module = await server.command({op: "blob", hash: proposed.manifest.layers.review});
  assert.equal(await sha256(Buffer.from(module.data, "base64")), proposed.manifest.layers.review);
  assert.equal(server.status().version, first.version, "rehearsing does not change the running release");
  const changedService = structuredClone(proposed.manifest);
  changedService.layers.reviewService = first.serverHash;
  const wrongPair = await sha256(new TextEncoder().encode(canonical(changedService)));
  await assert.rejects(server.command({op: "approve", expectedVersion: first.version, expectedDigest: wrongPair}),
    /differs from the rehearsed manifest/);
  await assert.rejects(server.command({op: "approve", expectedVersion: first.version}), /rehearsed manifest/);
  assert.equal(server.status().version, first.version);

  const second = await server.command({op: "approve", expectedVersion: first.version,
    expectedDigest: proposed.digest});
  assert.equal(second.version, first.version + 1);
  const active = await server.command({op: "evidence"});
  assert.deepEqual(active.manifest, proposed.manifest);
  assert(await verifyManifest(active.manifest, active.sig, active.publicKey));
  assert(!("token" in active));
  assert.deepEqual(await server.command({op: "requireCompare"}), {allowed: true, version: second.version});
  await until(() => server.status().acknowledged === 2, "both upgraded clients");
  for (const {host, link} of clients) {
    assert.equal(host.kv.get("desk/title"), "Keep concert dates on the advertised day");
    assert.equal(host.running().review, second.reviewHash);
    assert.equal(await host.capabilities.remote("reviewService:compare"), "allowed");
    const requested = link.sent.map(s => JSON.parse(s)).filter(m => m.t === "want").flatMap(m => m.hashes);
    assert.deepEqual(requested, [first.reviewHash, second.reviewHash], "browser fetches only the placed client layers");
  }
  await assert.rejects(server.command({op: "approve", expectedVersion: first.version}), /release changed/);
  for (const client of clients.splice(0)) client.close();
  server.close();

  server = await startHost(directory);
  const restored = server.session();
  assert.equal(restored.version, second.version);
  assert.deepEqual(restored.publicKey, first.publicKey);
  const fresh = openClient(restored);
  clients.push(fresh);
  await until(() => server.status().acknowledged === 1, "a reconnecting client on the persisted release");
  assert.equal(await fresh.host.capabilities.remote("reviewService:compare"), "allowed");

  const reverted = await server.command({op: "restore", expectedVersion: restored.version});
  assert.equal(reverted.version, second.version + 1);
  assert.equal(reverted.reviewHash, first.reviewHash);
  await until(() => server.status().acknowledged === 1, "rollback ACK");
  await assert.rejects(server.command({op: "requireCompare"}), /approved factory release/);
});
