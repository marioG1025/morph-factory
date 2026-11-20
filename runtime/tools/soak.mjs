// Exercise the real localhost relay at human timescales. All Git, hosting, and model services
// remain outside this test. The JSON report contains counts and timings only.
import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startHost } from "../review-host.mjs";
import { canonical, LiveHost, sha256, verifyManifest } from "../vendor/llp/llp-core.js";
import { connectServer } from "../vendor/llp/remote-client.mjs";
import { startCoverage } from "./soak-coverage.mjs";

const minutes = Number(process.argv[2] || 5);
if (!(minutes > 0 && minutes <= 240)) throw Error("Choose a duration between 0 and 240 minutes.");
const reportPath = resolve(process.argv[3] || "soak-results.json");
const stateDir = await mkdtemp(join(tmpdir(), "morph-soak-"));
const began = performance.now(), deadline = began + minutes * 60_000;
const coverage = startCoverage();
const summary = {startedUtc: new Date().toISOString(), requestedMinutes: minutes,
  status: "running", releaseTransitions: 0, clientAcks: 0, stateChecks: 0, restarts: 0,
  briefReconnects: 0, idleEvictionsObserved: 0, tokenExpiryObserved: false, tokenRenewals: 0,
  compareGrants: 0, baselineRefusals: 0, verifiedRehearsals: 0, events: []};
const latencies = [];
let server;
const clients = [];
function event(text) { summary.events.push({utc: new Date().toISOString(), event: text}); }
async function snapshot() {
  const sorted = [...latencies].sort((a, b) => a-b);
  const quantile = q => sorted.length ? sorted[Math.ceil(q*sorted.length)-1] : null;
  const report = {...summary, elapsedSeconds: Math.round((performance.now()-began)/1000), coverage:summary.coverage ?? coverage.report(), node: process.version,
    platform: process.platform, updatedUtc: new Date().toISOString(),
    approvalReturnToTwoAcksMs: {samples: sorted.length, p50: quantile(.5), p95: quantile(.95), max: quantile(1),
      pollIntervalMs:20}};
  await writeFile(reportPath + ".tmp", JSON.stringify(report, null, 2) + "\n");
  await rename(reportPath + ".tmp", reportPath);
}
async function waitFor(predicate, label) {
  const until = performance.now() + 12000;
  while (!predicate()) {
    if (performance.now() > until) throw Error("Timeout: " + label);
    await delay(20);
  }
}
function link(client, session) {
  const connection = connectServer(client.host, session.endpoint, {app: session.app, token: session.token,
    retryMs: 1000, queueMs: 6000, upgradeWaitMs: 2000});
  client.link = connection;
  client.sessionTime = Date.now();
}
function attach(session) {
  const client = {host: new LiveHost({app: session.app, trustedKeys: [session.publicKey]})};
  client.host.kv.set("desk/title", "VibeCheck concert date repair");
  client.host.kv.set("review/soak_note", "Operator note " + clients.length);
  clients.push(client);
  link(client, session);
}
async function ack() {
  await waitFor(() => server.status().connected === 2 && server.status().acknowledged === 2 &&
    clients.every(c => c.host.version === server.status().version), "two clients ACK the current release");
}
async function assertRemote() {
  for (const [i, client] of clients.entries()) {
    assert.equal(client.host.kv.get("desk/title"), "VibeCheck concert date repair");
    assert.equal(client.host.kv.get("review/soak_note"), "Operator note " + i);
    summary.stateChecks += 2;
    if (server.status().release === "compare") {
      assert.equal(await client.host.capabilities.remote("reviewService:compare"), "allowed");
      summary.compareGrants++;
    } else {
      await assert.rejects(client.host.capabilities.remote("reviewService:compare"), /approved factory release/);
      summary.baselineRefusals++;
    }
  }
}
async function checkEvidence(trustedKey) {
  const envelope = await server.command({op:"evidence"});
  assert(await verifyManifest(envelope.manifest, envelope.sig, trustedKey));
  const {sig, ...proof} = envelope.serverRehearsal;
  assert(await verifyManifest(proof, sig, trustedKey));
  assert.equal(proof.manifestDigest, await sha256(new TextEncoder().encode(canonical(envelope.manifest))));
  assert.equal(proof.version, server.status().version);
  assert.equal(proof.ok, true);
  summary.verifiedRehearsals++;
}
let nextRestart = began + 83 * 60_000;
try {
  server = await startHost(stateDir);
  const initial = server.session();
  attach(initial);
  attach(initial);
  await ack();
  event("Two clients connected to the baseline release");
  do {
    coverage.check();
    const before = server.status();
    if (before.release === "compare") await server.command({op: "restore", expectedVersion: before.version});
    else {
      const {digest} = await server.command({op: "candidate"});
      await server.command({op: "approve", expectedVersion: before.version, expectedDigest: digest});
    }
    const committed = performance.now();
    await ack();
    latencies.push(Math.round(performance.now()-committed));
    summary.releaseTransitions++;
    summary.clientAcks += 2;
    await checkEvidence(initial.publicKey);
    await assertRemote();
    if (!summary.idleEvictionsObserved && minutes >= 5 && summary.releaseTransitions === 1) {
      // Upstream default idleMs is 120s; its sweeper runs every 30s.
      event("Holding the active server worker idle for 165 seconds");
      await snapshot();
      await delay(165000);
      coverage.check();
      const lane = server.runtime.lane(server.runtime.tenant(initial.app));
      assert.equal(lane.slots.get("reviewService").evicted, true, "server worker must have idled");
      summary.idleEvictionsObserved++;
      await assertRemote();
      event("An actual idle worker reloaded on a real remote call");
    }
    if (!summary.tokenExpiryObserved && Date.now()-clients[0].sessionTime > 61 * 60_000) {
      const client = clients[0];
      client.link.drop();
      await waitFor(() => client.link.received.some(raw => {
        const msg = JSON.parse(raw); return msg.t === "error" && msg.code === "unauthorized";
      }), "upstream rejects the expired original token on reconnect");
      summary.tokenExpiryObserved = true;
      client.link.close();
      link(client, server.session());
      await ack();
      await assertRemote();
      summary.tokenRenewals++;
      event("A real token expired. A new bootstrap session reconnected the existing client host");
    }
    if (summary.releaseTransitions % 9 === 0) {
      const client = clients[1];
      client.link.close();
      await waitFor(() => server.status().connected === 1, "closed second client leaves the relay");
      link(client, server.session());
      await ack();
      summary.briefReconnects++;
    }
    if (performance.now() >= nextRestart) {
      const prior = server.session();
      for (const client of clients) client.link.close();
      server.close();
      server = await startHost(stateDir);
      const current = server.session();
      assert.equal(current.version, prior.version);
      assert.deepEqual(current.publicKey, prior.publicKey);
      await checkEvidence(initial.publicKey);
      for (const client of clients) link(client, current);
      await ack();
      await assertRemote();
      summary.restarts++;
      event("Server restarted and both open client hosts resumed with the same signed release");
      nextRestart = performance.now() + 83 * 60_000;
    }
    coverage.check();
    await snapshot();
    const interval = minutes < 5 ? 1000 : 60000;
    await delay(Math.min(interval, Math.max(0, deadline-performance.now())));
  } while (performance.now() < deadline);
  summary.coverage = coverage.check();
  summary.status = "passed";
} catch (error) {
  summary.status = "failed";
  summary.coverage = coverage.report();
  event(error.message);
  process.exitCode = 1;
} finally {
  coverage.stop();
  for (const client of clients) { client.link?.close(); client.host.close(); }
  server?.close();
  await snapshot();
  await rm(stateDir, {recursive:true,force:true});
  console.log(summary.status, reportPath);
}
