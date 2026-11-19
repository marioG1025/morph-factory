// Usage: node scripts/inspect-receipt.mjs path/to/morph-release.json [trusted-public-key.json]
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {canonical, sha256, verifyManifest} from "../runtime/vendor/llp/llp-core.js";

const [receiptPath, keyPath] = process.argv.slice(2);
if (!receiptPath) throw Error("Supply a downloaded experiment receipt path.");
const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
assert.equal(receipt.format, "morph-factory/experiment-receipt-v1", "Unknown receipt format");
const {manifest, sig, publicKey} = receipt.signedRelease;
const key = keyPath ? JSON.parse(await readFile(keyPath, "utf8")) : publicKey;
assert(await verifyManifest(manifest, sig, key), "Manifest signature did not verify");
assert.equal(manifest.app, "morph.factory.review");
console.log("Signature verified with " + (keyPath ? "the supplied trusted public key." : "the public key in this receipt."));
const manifestDigest = await sha256(new TextEncoder().encode(canonical(manifest)));
console.log("Manifest SHA-256:", manifestDigest);
console.log("Application:", manifest.app, "· release", manifest.version, "·", manifest["x-morph-release"]);
for (const slot of manifest.order) console.log(manifest.hosts[slot], slot, manifest.layers[slot]);
if (receipt.serverRehearsal) {
  const {sig: proofSignature, ...statement} = receipt.serverRehearsal;
  assert(await verifyManifest(statement, proofSignature, key), "Invalid server rehearsal signature");
  assert.equal(statement.manifestDigest, manifestDigest, "Rehearsal used another manifest");
  assert.equal(statement.version, manifest.version);
  assert.equal(statement.app, manifest.app);
  assert.equal(statement.ok, true);
  console.log("Signed server rehearsal verified:", statement.checks.map(check => check.operation).join(", "));
}
if (receipt.comparison) {
  const run = receipt.comparison;
  assert.equal(run.releaseVersion, manifest.version, "Comparison refers to a different release");
  console.log("Recorded comparison (unsigned observation):", run.original, "→", run.candidate);
  console.log("Base commit:", run.base, "· fixes:", run.counts.fixed, "· regressions:", run.counts.regressed);
}
