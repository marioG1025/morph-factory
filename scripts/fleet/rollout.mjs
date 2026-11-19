// Opt-in experiment. Each host, keyring and working directory belongs to this run.
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import {APP, startHost} from "../../runtime/review-host.mjs";
import {LiveHost} from "../../runtime/vendor/llp/llp-core.js";
import {bucketOf, TrustStore} from "../../runtime/vendor/llp/fleet.js";
import {connectServer} from "../../runtime/vendor/llp/remote-client.mjs";
import {ServerHost, tokenAuth} from "../../runtime/vendor/llp/server-host.mjs";

const directory = process.argv[2];
if (!directory) throw Error("Start this experiment with python scripts/fleet/run.py.");
const {FleetController, serve} = await import(pathToFileURL(join(directory, "tools/fleet.mjs")).href);
const fleet = await FleetController.create({app:APP, version:100});
const clients = [];
const relayNacks = [];
let publisher, relay, sockets;
const auth = tokenAuth(randomBytes(32));
const channel = "stable";
const labId = "calendar-draft-in-fleet-experiment";
const log = (stage, evidence) => console.log(JSON.stringify({stage, ...evidence}));

async function until(check, label) {
  const deadline = Date.now() + 16000;
  while (!await check()) {
    if (Date.now() > deadline) throw Error("Timed out waiting for " + label);
    await delay(20);
  }
}

async function publish(name, original, percent = 100) {
  const {app, version, layers, order, ...fields} = original.manifest;
  assert.equal(app, APP);
  for (const hash of Object.values(layers)) {
    const blob = await publisher.command({op:"blob", hash});
    assert.equal(await fleet.addBlob(Buffer.from(blob.data, "base64")), hash);
  }
  // The fleet assigns and signs its channel, epoch, version and rollout share.
  // Carry the actual factory grants, state boundaries and placement into that envelope.
  return fleet.publish(name, layers, {order, percent, fields});
}

function client(id, channel, endpoint, WebSocketImpl = WebSocket) {
  const observed = [];
  const host = new LiveHost({app:APP, capabilities:{compare: value => {observed.push(value);}}});
  for (const [key, value] of Object.entries({"desk/hasDraft":1,"desk/title":"Calendar dates",
    "desk/summary":"Fleet observation","desk/identity":labId})) host.kv.set(key, value);
  const link = connectServer(host, endpoint, {app:APP, id, channel, token:auth.issue(id, APP),
    trust:new TrustStore(structuredClone(fleet.keyring)), WebSocketImpl, retryMs:100});
  const result = {host, link, id, observed};
  clients.push(result);
  return result;
}

function compareButton(tree) {
  return (tree.k === "button" && tree.a?.id === "compare") || (tree.c || []).some(compareButton);
}

async function inspect(client, release, packet) {
  const view = await client.host.render();
  assert.deepEqual(view.map(row => row.slot), ["review"]);
  assert.equal(client.host.running().review, packet.manifest.layers.review);
  assert.equal(compareButton(view[0].tree), release === "compare");
  assert.equal(await client.host.capabilities.remote("reviewService:release"), release);
  if (release === "review") {
    await assert.rejects(client.host.capabilities.remote("reviewService:compare"), /app_error/);
  } else {
    const count = client.observed.length;
    await client.host.dispatch("review", "compare");
    await until(() => client.observed.length === count + 1, "the Wasm comparison capability");
    assert.equal(client.observed.at(-1), labId);
  }
  assert.equal(client.host.kv.get("review/view"), "checks");
}

// Three deliberate observations: a canary under 50%, a held-back stable client,
// and an independent preview channel. Choose stable IDs with the upstream hash.
async function cohortIds() {
  let inside, outside;
  for (let i = 0; !(inside && outside); i++) {
    const id = "factory-desk-" + i;
    const bucket = await bucketOf(id, APP + "/" + channel);
    if (bucket < 5000) inside ??= id;
    else outside ??= id;
  }
  return {inside, outside};
}

function canWiden(target) {
  const convergence = fleet.convergence(channel);
  const status = relay.clientStatus(APP)[channel];
  const count = Object.values(status?.versions || {}).reduce((a, b) => a + b, 0);
  return convergence.complete && convergence.live === 1 && count === 2 &&
    status.versions[target] === 1 && status.skipped === 1;
}

try {
  publisher = await startHost(join(directory, "baseline-authority"));
  const baseline = await publisher.command({op:"evidence"});
  const candidate = await publisher.command({op:"candidate"});
  assert.ok(candidate.serverRehearsal.ok);
  sockets = await serve(fleet, {host:"127.0.0.1", port:0});
  const baseStable = await publish(channel, baseline);
  const basePreview = await publish("preview", baseline);
  relay = new ServerHost({authenticate:auth.authenticate, idleMs:0,
    onLog:event => {if (event.kind === "client-nack") relayNacks.push(event.msg);},
    fleet:{keyring:structuredClone(fleet.keyring), id:"factory-relay"}});
  await relay.joinFleet("ws://127.0.0.1:" + sockets.address().port, [channel,"preview"]);
  const endpoint = "ws://127.0.0.1:" + await relay.listen(0, "127.0.0.1");
  const {inside, outside} = await cohortIds();
  let hold = false, releaseAck;
  class CanarySocket extends WebSocket {
    send(data) {
      if (hold && JSON.parse(data).t === "ack") {
        releaseAck = () => super.send(data);
        return;
      }
      super.send(data);
    }
  }
  const canary = client(inside, channel, endpoint, CanarySocket);
  const waiting = client(outside, channel, endpoint);
  const preview = client("preview-observer", "preview", endpoint);
  await until(() => relay.clientStatus(APP).stable?.versions[baseStable] === 2 &&
    relay.clientStatus(APP).preview?.versions[basePreview] === 1, "three baseline ACKs");
  for (const c of clients) await c.host.dispatch("review", "checks");
  for (const c of clients) await inspect(c, "review", baseline);
  log("baseline", {stable:baseStable, preview:basePreview, clients:clients.length});

  const previewVersion = await publish("preview", candidate);
  await until(() => relay.clientStatus(APP).preview.versions[previewVersion] === 1, "preview ACK");
  await inspect(preview, "compare", candidate);
  await inspect(canary, "review", baseline);
  log("preview", {version:previewVersion, stableStillOn:canary.host.version});

  hold = true;
  const target = await publish(channel, candidate, 50);
  await until(() => releaseAck && relay.clientStatus(APP).stable.skipped === 1 &&
    fleet.convergence(channel).complete, "relay convergence and held canary ACK");
  assert.equal(canWiden(target), false);
  log("waiting-for-canary-ack", {relayComplete:true, target, clients:relay.clientStatus(APP).stable});
  await inspect(canary, "compare", candidate);
  await inspect(waiting, "review", baseline);
  hold = false;
  releaseAck();
  await until(() => canWiden(target), "eligible desk ACK before promotion");
  log("canary-approved", {target, clients:relay.clientStatus(APP).stable, included:inside, heldBack:outside});

  await fleet.setPercent(channel, 100);
  await until(() => relay.clientStatus(APP).stable.versions[target] === 2, "both stable client ACKs");
  await inspect(canary, "compare", candidate);
  await inspect(waiting, "compare", candidate);
  log("stable-promoted", {target, clients:relay.clientStatus(APP).stable,
    relayNacks:[...relayNacks],
    browserHash:candidate.manifest.layers.review, serverHash:candidate.manifest.layers.reviewService});
  const restored = await fleet.rollback(channel);
  await until(() => relay.clientStatus(APP).stable.versions[restored] === 2, "restore ACKs");
  for (const c of [canary,waiting]) await inspect(c, "review", baseline);
  await inspect(preview, "compare", candidate);
  log("stable-restored", {version:restored, previewStillOn:preview.host.version});
} finally {
  for (const c of clients) {c.link.close(); c.host.close();}
  relay?.close();
  await new Promise(resolve => sockets ? sockets.close(resolve) : resolve());
  publisher?.close();
}
