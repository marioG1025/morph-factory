// Morph supplies release policy and approval. LLP owns verification, placement, migration,
// persistence, blob delivery, remote calls, client acknowledgements, and the commit/relay order.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { canonical, generatePublisherKey, sha256, signManifest, verifyManifest } from "./vendor/llp/llp-core.js";
import { ServerHost, tokenAuth } from "./vendor/llp/server-host.mjs";
import { rehearseServer } from "./rehearsal.mjs";

export const APP = "morph.factory.review";
const signingAlgorithm = {name: "ECDSA", namedCurve: "P-256"};

function replaceFile(path, data) {
  const pending = path + "." + process.pid + ".tmp";
  writeFileSync(pending, data, {mode: 0o600, flush: true});
  renameSync(pending, path);
}

async function publisher(stateDir) {
  const path = join(stateDir, "publisher.json");
  if (existsSync(path)) {
    const {privateJwk, publicKey} = JSON.parse(readFileSync(path, "utf8"));
    return {publicKey, privateKey: await crypto.subtle.importKey("jwk", privateJwk, signingAlgorithm, false, ["sign"])};
  }
  if (existsSync(join(stateDir, "host"))) {
    throw Error("The saved host is missing its publisher.json. Restore that checkout's original key or choose a new state directory.");
  }
  const {privateKey, publicJwk} = await generatePublisherKey();
  const privateJwk = await crypto.subtle.exportKey("jwk", privateKey);
  replaceFile(path, JSON.stringify({privateJwk, publicKey: publicJwk}));
  return {privateKey, publicKey: publicJwk};
}

async function assets() {
  const bytes = new Map();
  const variants = {};
  for (const [release, index] of [["review", 1], ["compare", 2]]) {
    const layers = {};
    for (const [slot, path] of [["review", "../ui/layers/review-v" + index + ".wasm"],
                               ["reviewService", "./layers/service-v" + index + ".wasm"]]) {
      const data = readFileSync(new URL(path, import.meta.url));
      const hash = await sha256(data);
      bytes.set(hash, data);
      layers[slot] = hash;
    }
    variants[release] = layers;
  }
  return {bytes, variants};
}

async function restoreClientAsset(runtime, packagedAssets) {
  const tenant = runtime.tenant(APP);
  const active = tenant.releases.get(null);
  if (!active) return;
  // ServerHost restores its placed server worker and caches client bytes if they exist.
  // A signed release must also be deliverable to a new browser before the desk opens.
  const hash = active.manifest.layers.review;
  const saved = tenant.blobs.get(hash);
  if (saved && await sha256(saved) === hash) return;
  const packaged = packagedAssets.get(hash);
  if (!packaged) throw Error("The saved release needs a client module unavailable in this checkout. Restore its original content-addressed blob.");
  replaceFile(join(runtime.disk.dir, "blobs", hash), packaged);
  tenant.blobs.set(hash, packaged);
}

export async function startHost(stateDir, {tokenTtlMs = 3600000} = {}) {
  if (!Number.isSafeInteger(tokenTtlMs) || tokenTtlMs < 1000 || tokenTtlMs > 86400000) {
    throw Error("MORPH_SESSION_TTL_MS must be between 1000 and 86400000 milliseconds.");
  }
  mkdirSync(stateDir, {recursive: true, mode: 0o700});
  const {privateKey, publicKey} = await publisher(stateDir);
  const {bytes, variants} = await assets();
  const auth = tokenAuth(randomBytes(32));
  const runtime = new ServerHost({trustedKeys: [publicKey], authenticate: auth.authenticate,
    dataDir: join(stateDir, "host"), onLog: event => {
      if (event.kind === "error" || event.kind === "client-nack") console.error(event.kind, event.msg);
    }});
  // The release is persisted by ServerHost itself, with the signature checked during restore.
  try {
    const restored = await runtime.ready;
    if (restored.some(row => !row.ok)) throw Error("The saved release failed LLP verification. Inspect the local factory state.");
    await restoreClientAsset(runtime, bytes);
  } catch (error) {
    runtime.close();
    throw error;
  }
  const tenant = runtime.tenant(APP);
  const lane = runtime.lane(tenant);
  const blob = hash => {
    const data = bytes.get(hash) ?? tenant.blobs.get(hash);
    if (!data) throw Error("Unknown layer hash.");
    return data;
  };
  let cached;
  let needsRestore = false;
  const manifestHash = manifest => sha256(new TextEncoder().encode(canonical(manifest)));
  const receiptsDir = join(stateDir, "rehearsals");
  mkdirSync(receiptsDir, {recursive:true, mode:0o700});
  const candidate = async release => {
    const manifest = {llp: 1, app: APP, version: lane.version + 1, layers: variants[release],
      order: ["review", "reviewService"], hosts: {review: "client", reviewService: "server"},
      keys: {review: {own: ["review/"], read: ["desk/"]}, reviewService: {own: [], read: []}},
      caps: {review: release === "compare" ? ["deskAction", "remote", "compare"] : ["deskAction"], reviewService: []},
      overlap: release === "review" ? 0 : 30000, "x-morph-release": release};
    const digest = await manifestHash(manifest);
    // Future stateful server slots must invalidate this snapshot if their input state changes.
    // The review service currently owns no business data and writes only ephemeral replies.
    if (cached?.digest === digest && cached.sourceRevision === lane.kv.rev) return cached.envelope;
    const envelope = {manifest, sig: await signManifest(manifest, privateKey), publicKey, version: manifest.version, digest};
    const sourceRevision = lane.kv.rev;
    envelope.serverRehearsal = await rehearseServer({current: tenant.releases.get(null), snapshot: [...lane.kv],
      proposed: envelope, blob, publicKey, privateKey});
    cached = {digest, sourceRevision, envelope};
    return envelope;
  };
  const commit = async envelope => {
    const {serverRehearsal: proof} = envelope;
    if (!proof?.ok || proof.manifestDigest !== envelope.digest)
      throw Error("The isolated server rehearsal did not authorize this release.");
    // Save the evidence first. A crash before commit can only leave an unreferenced receipt.
    const proofPath = join(receiptsDir, envelope.digest + ".json");
    replaceFile(proofPath, JSON.stringify(proof));
    let accepted;
    try {
      accepted = await runtime.offer(envelope.manifest, envelope.sig, blob);
    } catch (cause) {
      // Upstream advances its in-memory lane before saving the release and relaying it.
      // If storage throws, only a fresh verified restore can establish the committed version.
      needsRestore = true;
      runtime.close();
      const error = Error("Could not confirm durable release state. Retry to restore the last signed release.", {cause});
      error.restart = true;
      throw error;
    }
    if (!accepted.ok) throw Error("LLP refused the release: " + accepted.reason);
  };
  if (!lane.manifest) await commit(await candidate("review"));
  const port = await runtime.listen(0, "127.0.0.1");
  const session = () => ({app: APP, endpoint: "ws://127.0.0.1:" + port,
    token: auth.issue("local-operator", APP, tokenTtlMs), publicKey, version: lane.version,
    release: lane.manifest["x-morph-release"], reviewHash: lane.manifest.layers.review,
    serverHash: lane.manifest.layers.reviewService});
  const status = () => ({
    app: APP, version: lane.version, release: lane.manifest["x-morph-release"],
    layers: lane.manifest.layers, hosts: lane.manifest.hosts, caps: lane.manifest.caps,
    connected: tenant.clients.size, acknowledged: [...tenant.clients].filter(c => c.version === lane.version).length,
  });
  async function transition(target, request) {
    const same = lane.manifest["x-morph-release"] === target;
    if (same && request.expectedVersion === lane.version - 1 &&
        (target !== "compare" || request.expectedDigest === await manifestHash(lane.manifest))) {
      // Commit succeeded but the approval response was lost. This exact retry creates no release.
      return session();
    }
    if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion !== lane.version) {
      throw Error("The live release changed. Refresh the release details and rehearse the current candidate.");
    }
    if (same) {
      if (target === "compare" && request.expectedDigest !== await manifestHash(lane.manifest))
        throw Error("Compare results already runs a different manifest. Refresh the release details.");
      return session();
    }
    const offered = await candidate(target);
    if (target === "compare" && request.expectedDigest !== offered.digest) {
      throw Error("The candidate release differs from the rehearsed manifest. Rehearse it again.");
    }
    await commit(offered);
    return session();
  }
  return {runtime, session, status, close: () => { if (!needsRestore) runtime.close(); }, async command(request) {
    if (needsRestore) throw Error("Restore the last signed release before continuing.");
    switch (request.op) {
      case "session": return session();
      case "status": return status();
      case "evidence": {
        const {manifest, sig} = tenant.releases.get(null);
        const digest = await manifestHash(manifest);
        const path = join(receiptsDir, digest + ".json");
        const result = {manifest, sig, publicKey};
        if (existsSync(path)) {
          const {sig: proofSig, ...proof} = JSON.parse(readFileSync(path, "utf8"));
          if (proof.manifestDigest !== digest || !(await verifyManifest(proof, proofSig, publicKey)))
            throw Error("The saved server rehearsal receipt does not match the active signed release.");
          result.serverRehearsal = {...proof, sig: proofSig};
        }
        return result;
      }
      case "candidate": return candidate("compare");
      case "blob": return {data: Buffer.from(blob(request.hash)).toString("base64")};
      case "approve": return transition("compare", request);
      case "restore": return transition("review", request);
      case "requireCompare": {
        // Use the upstream server worker's current version, including when an old tab is in overlap.
        const value = await lane.invoke("reviewService", "compare", "local-operator", "", lane.version);
        if (value !== "allowed") throw Error("The active server layer did not grant comparison.");
        return {allowed: true, version: lane.version};
      }
      default: throw Error("Unknown live-host command.");
    }
  }};
}

async function main() {
  const tokenTtlMs = Number(process.env.MORPH_SESSION_TTL_MS ?? 3600000);
  const host = await startHost(process.argv[2], {tokenTtlMs});
  const lines = createInterface({input: process.stdin, crlfDelay: Infinity});
  try {
    for await (const line of lines) {
      let answer;
      try { answer = {ok: true, result: await host.command(JSON.parse(line))}; }
      catch (error) { answer = {ok: false, error: error.message, restart: error.restart === true}; }
      process.stdout.write(JSON.stringify(answer) + "\n");
      if (answer.restart) break;
    }
  } finally { host.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error("Morph live host:", error.message);
    process.stdout.write(JSON.stringify({ok: false, error: error.message}) + "\n");
    process.exitCode = 1;
  });
}
