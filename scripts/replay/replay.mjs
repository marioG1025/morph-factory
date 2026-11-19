import {LiveHost, b64, canonical, sha256, verifyManifest} from "./llp-core.js";

const {recording, diff, blobs} = JSON.parse(document.getElementById("bundle").textContent);
const {publicKey, releases, observation} = recording;
const byId = id => document.getElementById(id);
let client, service, stage = -1, advancing = false, showing = false;

async function verifyRelease(release) {
  const {manifest, sig, serverRehearsal} = release;
  const digest = await sha256(new TextEncoder().encode(canonical(manifest)));
  if (manifest.app !== "morph.factory.review" || manifest.hosts.review !== "client" ||
      manifest.hosts.reviewService !== "server" || !await verifyManifest(manifest, sig, publicKey)) {
    throw Error("The recorded release signature or slot placement could not be verified.");
  }
  const {sig: signature, ...statement} = serverRehearsal;
  if (!await verifyManifest(statement, signature, publicKey) || statement.manifestDigest !== digest ||
      statement.version !== manifest.version || statement.app !== manifest.app || !statement.ok ||
      statement.release !== manifest["x-morph-release"]) throw Error("The recorded server rehearsal failed verification.");
  return digest;
}

// Both roles execute the original signed bytecode. This local adapter supplies the
// two stateless service calls needed by the replay without starting a WebSocket.
async function invokeService(operation) {
  return service.exclusive(async () => {
    const box = service.slots.get("reviewService").box;
    const {writes, effects} = await service.call("reviewService", box, "llp_event", service.kv,
      {id: operation, value: "replay\n"}, [], {apply: false});
    if (effects.length) throw Error("The captured replay service requested an external capability.");
    const reply = new Map(writes);
    if (reply.has("__error")) return "refused";
    if (!reply.has("__reply")) throw Error("The service returned no reply.");
    return reply.get("__reply");
  });
}

function createHosts() {
  const options = {app:"morph.factory.review", trustedKeys:[publicKey]};
  service = new LiveHost({...options, role:"server"});
  client = new LiveHost({...options, onRender: draw, capabilities:{
    remote: command => command === "reviewService:compare" ? invokeService("compare") : "refused",
    compare: async identity => {
      if (identity === observation.base + ":" + observation.patchDigest && client.version === observation.releaseVersion) {
        client.kv.set("desk/hasComparison", 1);
        await client.render();
      }
    }
  }});
  client.kv.set("desk/hasDraft", 1);
  client.kv.set("desk/identity", observation.base + ":" + observation.patchDigest);
  client.kv.set("desk/title", "Keep date-only concerts on the advertised day");
}

function flatten(node) {
  return node ? [node, ...(node.c || []).flatMap(flatten)] : [];
}

function draw(views) {
  const nodes = flatten(views.find(item => item.slot === "review")?.tree);
  if (!nodes.length) return;
  const actions = nodes.filter(node => node.k === "button");
  for (const tab of actions.filter(node => ["diff","checks"].includes(node.a.id))) {
    const id = "tab-" + tab.a.id;
    let button = byId(id);
    if (!button) {
      button = document.createElement("button");
      button.id = id; button.type = "button";
      button.onclick = () => client.dispatch("review", tab.a.id);
      byId("tabs").append(button);
    }
    button.textContent = tab.c.find(child => child.k === "text").t;
    button.setAttribute("aria-pressed", String(tab.a.style === "selected"));
  }
  const docs = nodes.filter(node => node.k === "document").map(node => node.a.source);
  const contents = docs.includes("diff") ? diff :
    "Project check · VibeCheck concert dates in America/Chicago\nThis recording captures the paired check under Compare results.";
  if (byId("document").textContent !== contents) byId("document").textContent = contents;
  const compare = actions.find(node => node.a.id === "compare");
  byId("comparison").hidden = !compare;
  byId("show").disabled = advancing || compare?.a.disabled === "1";
  showing = docs.includes("comparison");
  byId("observation").hidden = !showing;
  byId("show").hidden = showing;
}

function showFacts(index, digest, permission) {
  const {manifest} = releases[index];
  const items = {
    "Signed manifest": digest, "Client Wasm": manifest.layers.review, "Server Wasm": manifest.layers.reviewService,
    "Server compare reply": permission, "Product base": observation.base, "Product candidate tree": observation.candidateTree,
    "Test evidence": "Recorded locally on release " + observation.releaseVersion + ". The signatures cover the release and its rehearsal."
  };
  const rows = [];
  for (const [key,value] of Object.entries(items)) {
    const label = document.createElement("dt"), fact = document.createElement("dd");
    label.textContent = key; fact.textContent = value; rows.push(label,fact);
  }
  byId("facts").replaceChildren(...rows);
}

async function applyNext() {
  if (advancing) return;
  advancing = true; byId("advance").disabled = byId("show").disabled = true;
  try {
    if (stage === 2 || !client) {
      client?.close(); service?.close(); createHosts(); stage = -1;
    }
    const index = stage + 1;
    const envelope = releases[index], manifest = envelope.manifest;
    const digest = await verifyRelease(envelope);
    const blob = async hash => b64.dec(blobs[hash]);
    for (const host of [service, client]) {
      const applied = await host.apply(manifest, envelope.sig, blob);
      if (!applied.ok) throw Error("The recorded module could not activate. " + applied.reason);
    }
    const permission = await invokeService("compare");
    const expected = index === 1 ? "allowed" : "refused";
    if (permission !== expected || await invokeService("release") !== manifest["x-morph-release"]) {
      throw Error("The replayed service disagrees with the recorded release.");
    }
    stage = index;
    showFacts(index, digest, permission);
    byId("stage").textContent = "Signed release " + manifest.version + " · " +
      ["Original review", "Compare results available", "Original review restored"][index];
    byId("advance").textContent = ["Apply signed update", "Restore original review", "Replay again"][index];
    byId("advance").disabled = false;
  } catch (error) {
    client?.close(); service?.close();
    byId("stage").textContent = "Replay stopped";
    byId("error").textContent = error.message;
    byId("comparison").hidden = true;
  } finally {
    advancing = false;
    if (!byId("comparison").hidden && !showing) byId("show").disabled = false;
  }
}

byId("advance").onclick = applyNext;
byId("show").onclick = () => client.dispatch("review", "compare");
byId("summary").textContent = observation.counts.fixed + " fixed · " + observation.counts.unchanged +
  " unchanged · " + observation.counts.regressed + " regressed";
for (const item of observation.cases) {
  const row = document.createElement("tr");
  for (const value of [item.name,item.before,item.after]) {
    const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
  }
  if (item.classification === "fixed") row.lastChild.className = "fixed";
  byId("cases").append(row);
}
window.addEventListener("pagehide", () => {client?.close(); service?.close();}, {once:true});
applyNext();
