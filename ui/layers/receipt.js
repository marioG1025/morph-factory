import {verifyManifest} from "/vendor/llp/llp-core.js";

// A full desk snapshot contains the checkout path, source and test output.
// Build the shareable receipt from an allowlist of public metadata.
async function get(path) {
  const response = await fetch(path, {cache:"no-store"});
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Could not read " + path);
  return data;
}

const button = document.getElementById("export-receipt");
button.addEventListener("click", async () => {
  button.disabled = true;
  const message = document.getElementById("receipt-status");
  try {
    const [envelope, desk] = await Promise.all([get("/api/live/evidence"), get("/api/state")]);
    if (!await verifyManifest(envelope.manifest, envelope.sig, envelope.publicKey)) {
      throw Error("The active release signature could not be verified.");
    }
    const receipt = {format:"morph-factory/experiment-receipt-v1", capturedAt:new Date().toISOString(),
      signedRelease:{manifest:envelope.manifest, sig:envelope.sig, publicKey:envelope.publicKey}};
    if (envelope.serverRehearsal) receipt.serverRehearsal = envelope.serverRehearsal;
    const run = desk.draft?.comparison;
    if (run && run.releaseVersion === envelope.manifest.version && run.base === desk.draft.base) {
      receipt.comparison = {recordedAt:run.at, base:run.base, patchDigest:run.digest,
        candidateTree:run.candidateTree, releaseVersion:run.releaseVersion,
        original:run.baseline.status, candidate:run.candidate.status, counts:run.summary};
    }
    const href = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2) + "\n"], {type:"application/json"}));
    const link = document.createElement("a");
    link.href = href;
    link.download = "morph-release-" + envelope.manifest.version + ".json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 2000);
    message.textContent = receipt.comparison ? "Downloaded the signed release and comparison counts." :
      "Downloaded the signed release. Run a comparison on this version to include its counts.";
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
