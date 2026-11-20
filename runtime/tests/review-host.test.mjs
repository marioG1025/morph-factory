import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startHost } from "../review-host.mjs";
import { canonical, generatePublisherKey, LiveHost, sha256, signManifest, verifyManifest } from "../vendor/llp/llp-core.js";
import { connectServer } from "../vendor/llp/remote-client.mjs";
import { ServerLiveHost } from "../vendor/llp/server-host.mjs";
import { rehearseServer } from "../rehearsal.mjs";

async function until(condition, description) {
  const deadline = Date.now() + 10000;
  while (!condition()) {
    if (Date.now() >= deadline) throw Error("Timed out waiting for " + description);
    await delay(20);
  }
}

test("the same candidate can be rehearsed again after a transient server worker failure", async t => {
  const directory = await mkdtemp(join(tmpdir(), "morph-retry-rehearsal-"));
  const server = await startHost(directory);
  t.after(async () => { server.close(); await rm(directory, {recursive:true, force:true}); });
  const failure = t.mock.method(ServerLiveHost.prototype, "invoke", () => { throw Error("Temporary worker failure"); });
  const first = await server.command({op:"candidate"});
  assert.equal(first.serverRehearsal.ok, false);
  assert.match(first.serverRehearsal.error, /Temporary worker failure/);
  await assert.rejects(server.command({op:"approve", expectedVersion:1, expectedDigest:first.digest}), /rehearsal/);
  assert.equal(server.status().version, 1);
  failure.mock.restore();
  const second = await server.command({op:"candidate"});
  assert.equal(second.digest, first.digest);
  assert.equal(second.serverRehearsal.ok, true);
  const cached = await server.command({op:"candidate"});
  assert.deepEqual(cached.serverRehearsal, second.serverRehearsal);
  const approved = await server.command({op:"approve", expectedVersion:1, expectedDigest:second.digest});
  assert.equal(approved.version, 2);
});

function openClient(session, watch) {
  const host = new LiveHost({app: session.app, trustedKeys: [session.publicKey]});
  host.kv.set("desk/title", "Keep concert dates on the advertised day");
  const link = connectServer(host, session.endpoint, {app: session.app, token: session.token, watch,
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
  const {sig: proofSig, ...proof} = proposed.serverRehearsal;
  assert(await verifyManifest(proof, proofSig, first.publicKey));
  assert.equal(proof.manifestDigest, proposed.digest);
  assert.deepEqual(proof.checks.map(c => [c.operation, c.actual]), [["release","compare"], ["compare","allowed"]]);
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
  assert.deepEqual(active.serverRehearsal, proposed.serverRehearsal);
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
  assert.deepEqual((await server.command({op: "evidence"})).serverRehearsal, proposed.serverRehearsal);
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

test("a signed server module with the wrong business behavior fails shadow checks", async t => {
  const dir = await mkdtemp(join(tmpdir(), "morph-shadow-"));
  const server = await startHost(dir);
  t.after(async () => { server.close(); await rm(dir, {recursive:true, force:true}); });
  const key = await generatePublisherKey();
  const original = await server.command({op:"evidence"});
  const proposal = await server.command({op:"candidate"});
  const broken = {...proposal.manifest, layers: {...proposal.manifest.layers, reviewService: original.manifest.layers.reviewService}};
  const manifestDigest = await sha256(new TextEncoder().encode(canonical(broken)));
  const proof = await rehearseServer({current:null, snapshot:[], proposed:{
    manifest:broken, sig:await signManifest(broken, key.privateKey), digest:manifestDigest},
    blob: async hash => Buffer.from((await server.command({op:"blob",hash})).data,"base64"),
    publicKey:key.publicJwk, privateKey:key.privateKey});
  assert.equal(proof.ok, false);
  assert.deepEqual(proof.checks.map(c => [c.expected,c.actual]), [["compare","review"], ["allowed","refused"]]);
  assert.equal(server.status().release, "review");
});

for (const failurePoint of ["before release save", "after release save"]) {
  test(`an interrupted approval ${failurePoint} recovers to the saved release and accepts an exact retry`, async t => {
    const directory = await mkdtemp(join(tmpdir(), "morph-release-interrupt-"));
    let server = await startHost(directory);
    const client = openClient(server.session());
    t.after(async () => {
      client.close();
      server.close();
      await rm(directory, {recursive: true, force: true});
    });
    await until(() => server.status().acknowledged === 1, "the original client release");
    const original = await server.command({op: "evidence"});
    const proposed = await server.command({op: "candidate"});
    const approve = {op: "approve", expectedVersion: original.manifest.version, expectedDigest: proposed.digest};
    const save = server.runtime.saveReleases.bind(server.runtime);
    server.runtime.saveReleases = tenant => {
      if (failurePoint === "after release save") save(tenant);
      throw Error("Simulated storage interruption");
    };
    await assert.rejects(server.command(approve), error => error.restart === true);
    await assert.rejects(server.command({op: "requireCompare"}), /Restore the last signed release/);
    assert.equal(client.host.version, original.manifest.version, "the uncertain release was never relayed");
    client.close();

    server = await startHost(directory);
    const recovered = await server.command({op: "evidence"});
    const saved = failurePoint === "after release save" ? proposed : original;
    assert.deepEqual(recovered.manifest, saved.manifest);
    assert.deepEqual(recovered.serverRehearsal, saved.serverRehearsal);
    assert.equal((await server.command(approve)).version, proposed.version);
    assert.equal((await server.command(approve)).version, proposed.version, "a lost response can be retried once more");
    assert.equal((await server.command({op: "evidence"})).serverRehearsal.manifestDigest, proposed.digest);
    await server.command({op: "restore", expectedVersion: proposed.version});
    await assert.rejects(server.command(approve), /release changed/);
  });
}

test("disposing a disconnected client cancels a pending reconnect", async t => {
  const directory = await mkdtemp(join(tmpdir(), "morph-dispose-"));
  const server = await startHost(directory);
  const client = openClient(server.session());
  t.after(async () => {
    client.close(); server.close();
    await rm(directory, {recursive: true, force: true});
  });
  await until(() => server.status().acknowledged === 1, "the initial release");
  client.link.drop();
  await until(() => !client.link.online, "the disconnect followed by a pending retry");
  client.link.close();
  await delay(150);
  assert.equal(server.status().connected, 0);
  assert.equal(client.link.online, false);
});

test("a restored checkout needs its original publisher identity", async t => {
  const directory = await mkdtemp(join(tmpdir(), "morph-publisher-"));
  let server = await startHost(directory);
  t.after(async () => { server.close(); await rm(directory, {recursive: true, force: true}); });
  const original = server.session();
  server.close();
  const key = join(directory, "publisher.json");
  await rename(key, key + ".saved");
  await assert.rejects(startHost(directory), /missing its publisher.json/);
  await assert.rejects(access(key), {code: "ENOENT"}, "startup must preserve the checkout's trust origin");
  await rename(key + ".saved", key);
  server = await startHost(directory);
  assert.deepEqual(server.session().publicKey, original.publicKey);
  assert.equal(server.session().version, original.version);
});

test("a fresh client can fetch the signed module after a recoverable local blob loss", async t => {
  const directory = await mkdtemp(join(tmpdir(), "morph-restore-client-"));
  const clients = [];
  let server = await startHost(directory);
  t.after(async () => {
    for (const client of clients) client.close();
    server.close();
    await rm(directory, {recursive: true, force: true});
  });
  const candidate = await server.command({op: "candidate"});
  const original = await server.command({op: "approve", expectedVersion: server.status().version, expectedDigest: candidate.digest});
  const file = join(directory, "host", "blobs", original.reviewHash);
  for (const damage of ["missing", "incomplete"]) {
    server.close();
    if (damage === "missing") await rm(file);
    else await writeFile(file, (await readFile(file)).subarray(0, 30));
    server = await startHost(directory);
    assert.equal(await sha256(await readFile(file)), original.reviewHash);
    const client = openClient(server.session());
    clients.push(client);
    await until(() => server.status().acknowledged === 1, `${damage} client blob restored for a new client`);
    assert.equal(client.host.running().review, original.reviewHash);
    assert.equal(client.host.version, original.version);
    assert.equal(await client.host.capabilities.remote("reviewService:compare"), "allowed");
    client.close();
    clients.pop();
  }
});

test("a completed comparison reaches only subscribed peers and replays the latest marker on reconnect", async t => {
  const directory = await mkdtemp(join(tmpdir(), "morph-shared-comparison-"));
  const key = "shared/review/comparison";
  const clients = [];
  let server = await startHost(directory);
  t.after(async () => {
    for (const client of clients) client.close();
    server.close();
    await rm(directory, {recursive: true, force: true});
  });
  const first = server.session();
  const watching = openClient(first, [key]);
  const other = openClient(first, ["shared/other/"]);
  clients.push(watching, other);
  await until(() => server.status().acknowledged === 2, "both clients' initial release");
  const proposal = await server.command({op: "candidate"});
  const approved = await server.command({op: "approve", expectedVersion: first.version, expectedDigest: proposal.digest});
  const notice = {run: "1".repeat(32), base: "a".repeat(40), digest: "b".repeat(64), releaseVersion: approved.version};
  await until(() => server.status().acknowledged === 2, "both clients' compare release");
  await assert.rejects(server.command({op: "comparisonSaved", ...notice, digest: "invalid"}), /patch digest/);
  assert.deepEqual(await server.command({op: "comparisonSaved", ...notice, output: "excluded output"}), {published: true});
  await until(() => Boolean(watching.host.kv.get(key)), "the subscribed peer's native shared cache");
  assert.deepEqual(JSON.parse(watching.host.kv.get(key)), notice);
  assert.equal(other.host.kv.has(key), false);
  const delta = watching.link.received.map(raw => JSON.parse(raw)).find(m => m.t === "shared" && !m.full);
  assert.deepEqual(delta.set, [[key, JSON.stringify(notice)]]);
  const tenant = server.runtime.tenant(first.app), revision = tenant.kv.rev;
  assert.deepEqual(await server.command({op: "comparisonSaved", ...notice}), {published: true});
  assert.equal(tenant.kv.rev, revision, "a recovered acknowledgement does not mutate the store");

  const latest = {...notice, run: "2".repeat(32)};
  await server.command({op: "comparisonSaved", ...latest});
  await until(() => watching.host.kv.get(key) === JSON.stringify(latest), "a second comparison of the same patch");
  for (const client of clients.splice(0)) client.close();
  server.close();
  server = await startHost(directory);
  const fresh = openClient(server.session(), [key]);
  clients.push(fresh);
  await until(() => server.status().acknowledged === 1, "a fresh peer after restarting from disk");
  const full = fresh.link.received.map(raw => JSON.parse(raw)).find(m => m.t === "shared" && m.full);
  assert.deepEqual(full.set, [[key, JSON.stringify(latest)]]);
  assert.deepEqual(JSON.parse(fresh.host.kv.get(key)), latest);
  await server.command({op: "restore", expectedVersion: approved.version});
  assert.deepEqual(await server.command({op: "comparisonSaved", ...notice}), {published: false});
  assert.equal(server.runtime.tenant(first.app).kv.get(key), JSON.stringify(latest));
});

test("a failed marker write or flush recovers its durable value before accepting a retry", async t => {
  const directory = await mkdtemp(join(tmpdir(), "morph-recover-marker-"));
  let server = await startHost(directory);
  t.after(async () => {
    server.close();
    await rm(directory, {recursive: true, force: true});
  });
  const proposal = await server.command({op: "candidate"});
  const active = await server.command({op: "approve", expectedVersion: 1, expectedDigest: proposal.digest});
  const key = "shared/review/comparison";
  for (const [i, stage] of ["persist", "flush"].entries()) {
    const notice = {run: String(i + 1).repeat(32), base: "a".repeat(40), digest: "b".repeat(64), releaseVersion: 2};
    server.runtime[stage] = () => { throw Error("Injected " + stage + " failure"); };
    await assert.rejects(server.command({op: "comparisonSaved", ...notice}), error => error.restart === true);
    await assert.rejects(server.command({op: "status"}), /Restore the last signed release/);
    server.close();
    server = await startHost(directory);
    const store = server.runtime.tenant(active.app).kv;
    assert.equal(store.get(key) === JSON.stringify(notice), stage === "flush");
    const revision = store.rev;
    assert.deepEqual(await server.command({op: "comparisonSaved", ...notice}), {published: true});
    assert.equal(store.get(key), JSON.stringify(notice));
    assert.equal(store.rev === revision, stage === "flush", "only a missing journal entry needs a write");
  }
});
