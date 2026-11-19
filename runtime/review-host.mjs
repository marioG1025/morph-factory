// Morph supplies release policy and approval. LLP owns verification, placement, migration,
// persistence, blob delivery, remote calls, client acknowledgements, and the commit/relay order.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { canonical, generatePublisherKey, sha256, signManifest } from "./vendor/llp/llp-core.js";
import { ServerHost, tokenAuth } from "./vendor/llp/server-host.mjs";

export const APP = "morph.factory.review";
const signingAlgorithm = {name: "ECDSA", namedCurve: "P-256"};

async function publisher(stateDir) {
  const path = join(stateDir, "publisher.json");
  if (existsSync(path)) {
    const {privateJwk, publicKey} = JSON.parse(readFileSync(path, "utf8"));
    return {publicKey, privateKey: await crypto.subtle.importKey("jwk", privateJwk, signingAlgorithm, false, ["sign"])};
  }
  const {privateKey, publicJwk} = await generatePublisherKey();
  const privateJwk = await crypto.subtle.exportKey("jwk", privateKey);
  const pending = join(stateDir, "publisher." + process.pid + ".tmp");
  writeFileSync(pending, JSON.stringify({privateJwk, publicKey: publicJwk}), {mode: 0o600});
  renameSync(pending, path);
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
  const restored = await runtime.ready;
  if (restored.some(row => !row.ok)) {
    runtime.close();
    throw Error("The saved release failed LLP verification. Inspect the local factory state.");
  }
  const tenant = runtime.tenant(APP);
  const lane = runtime.lane(tenant);
  const blob = hash => {
    const data = bytes.get(hash) ?? tenant.blobs.get(hash);
    if (!data) throw Error("Unknown layer hash.");
    return data;
  };
  const candidate = async release => {
    const manifest = {llp: 1, app: APP, version: lane.version + 1, layers: variants[release],
      order: ["review", "reviewService"], hosts: {review: "client", reviewService: "server"},
      keys: {review: {own: ["review/"], read: ["desk/"]}, reviewService: {own: [], read: []}},
      caps: {review: release === "compare" ? ["deskAction", "remote", "compare"] : ["deskAction"], reviewService: []},
      overlap: release === "review" ? 0 : 30000, "x-morph-release": release};
    const digest = await sha256(new TextEncoder().encode(canonical(manifest)));
    return {manifest, sig: await signManifest(manifest, privateKey), publicKey, version: manifest.version, digest};
  };
  const commit = async envelope => {
    const accepted = await runtime.offer(envelope.manifest, envelope.sig, blob);
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
    if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion !== lane.version) {
      throw Error("The live release changed. Refresh the release details and rehearse the current candidate.");
    }
    const offered = await candidate(target);
    if (target === "compare" && request.expectedDigest !== offered.digest) {
      throw Error("The candidate release differs from the rehearsed manifest. Rehearse it again.");
    }
    if (lane.manifest["x-morph-release"] === target) return session();
    await commit(offered);
    return session();
  }
  return {runtime, session, status, close: () => runtime.close(), async command(request) {
    switch (request.op) {
      case "session": return session();
      case "status": return status();
      case "evidence": {
        const {manifest, sig} = tenant.releases.get(null);
        return {manifest, sig, publicKey};
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
      catch (error) { answer = {ok: false, error: error.message}; }
      process.stdout.write(JSON.stringify(answer) + "\n");
    }
  } finally { host.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error("Morph live host:", error.message); process.exitCode = 1; });
}
