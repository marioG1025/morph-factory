import { LiveHost, generatePublisherKey, sha256, signManifest } from "./llp-core.js";

const el = id => document.getElementById(id);
const notice = message => { el("status").textContent = message; };
const layers = new Map();
let host, key, release = 1, sequence = 0, busy = true, recoveries = 0;

function log(kind, message) {
  const line = document.createElement("li");
  line.textContent = new Date().toLocaleTimeString() + "  " + kind + "  ·  " + message;
  el("log").prepend(line);
  if (el("log").children.length > 40) el("log").lastChild.remove();
}

function refresh() {
  el("upgrade").disabled = busy || release === 2;
  el("fail").disabled = el("add").disabled = el("draft").disabled = busy;
  el("version").textContent = "Version " + release + " is live";
  el("tasks").replaceChildren();
  for (let i = 0; i < Number(host.kv.get("tasks.n") || 0); i++) {
    const done = Boolean(host.kv.get("tasks." + i + ".done"));
    const row = document.createElement("button");
    row.className = "task";
    row.disabled = busy;
    row.setAttribute("aria-pressed", String(done));
    row.textContent = (done ? "☑  " : "☐  ") + host.kv.get("tasks." + i + ".text");
    row.onclick = () => run(async () => { await host.dispatch("main", "t:" + i); });
    el("tasks").append(row);
  }
  el("draft").value = host.kv.get("draft") || "";
}

async function run(action) {
  if (busy) return;
  busy = true;
  refresh();
  try { await action(); }
  catch (error) { notice(error.message); log("error", error.message); }
  finally { busy = false; refresh(); }
}

async function publish(name) {
  const layer = layers.get(name);
  const manifest = { app: "morph.factory.lab", version: ++sequence, order: ["main"], layers: {main: layer.hash} };
  const signature = await signManifest(manifest, key.privateKey);
  const result = await host.apply(manifest, signature, async hash => {
    if (hash !== layer.hash) throw Error("Unexpected layer digest.");
    return layer.bytes;
  });
  if (!result.ok) throw Error(result.reason || "The host refused this layer.");
  return result;
}

function checklist() {
  return [...host.kv].filter(([k]) => /^tasks\.(n|\d+\.(done|text))$/.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
}

el("draft").oninput = event => host.setBound("draft", event.target.value);
el("add").onclick = () => run(async () => { await host.dispatch("main", "add"); });
el("draft").onkeydown = event => { if (event.key === "Enter") el("add").click(); };
el("upgrade").onclick = () => run(async () => {
  const before = JSON.stringify([checklist(), host.kv.get("draft")]);
  const {ms} = await publish("tasks_v2");
  release = 2;
  if (before !== JSON.stringify([checklist(), host.kv.get("draft")])) throw Error("Checklist continuity check failed.");
  notice("Version 2 accepted in " + Math.round(ms) + " ms. Task text, completion flags and the unfinished note match the previous version.");
});
el("fail").onclick = () => run(async () => {
  const before = JSON.stringify(checklist());
  const oldDraft = String(host.kv.get("draft") || "");
  const baseline = host.slots.get("main").hash;
  const count = recoveries;
  await publish(release === 1 ? "tasks_trap" : "rehearsal_v2");
  try {
    host.setBound("draft", "lab-rehearsal");
    await host.dispatch("main", "add");
  } finally {
    host.setBound("draft", oldDraft);
  }
  if (recoveries <= count || host.slots.get("main").hash !== baseline || before !== JSON.stringify(checklist())) {
    throw Error("The expected rollback and state checks did not all pass. See host events.");
  }
  notice("The test Add failed. LLP restored the previous layer. Your checklist matches its pre-test state, and your note is back in the editor.");
});

try {
  key = await generatePublisherKey();
  for (const name of ["tasks", "tasks_v2", "tasks_trap", "rehearsal_v2"]) {
    const response = await fetch("./" + name + ".wasm");
    if (!response.ok) throw Error("Could not load " + name + ".");
    const bytes = new Uint8Array(await response.arrayBuffer());
    layers.set(name, {bytes, hash: await sha256(bytes)});
  }
  host = new LiveHost({app: "morph.factory.lab", trustedKeys: [key.publicJwk],
    onLog: event => { log(event.kind, event.msg); if (event.kind === "rollback") recoveries++; },
    capabilities: { haptic: () => undefined }});
  await publish("tasks");
  for (const title of ["Reproduce the original behavior", "Review the proposed change"]) {
    host.setBound("draft", title);
    await host.dispatch("main", "add");
  }
  await host.dispatch("main", "t:0");
  busy = false;
  refresh();
  notice("Local publisher connected. Edit the checklist to begin.");
  window.addEventListener("pagehide", () => host.close(), {once:true});
} catch (error) { el("version").textContent = "Host unavailable"; notice(error.message); }
