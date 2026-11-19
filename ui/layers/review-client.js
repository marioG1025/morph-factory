import { LiveHost, sha256 } from "/vendor/llp/llp-core.js";
import { connectServer } from "/vendor/llp/remote-client.mjs";
import { paintReview } from "./review-renderer.js";

const $ = id => document.getElementById(id);
const desk = window.morphDesk;
const slot = "review";
let host, link, session, currentEnvelope, offered, approvalInFlight = false, connecting = false;
let digest = "", lastDiff, digestRequest = 0, report = null, checking = false, lastVersion = 0;
let destroyed = false;

async function request(url, body) {
  const options = {cache: "no-store"};
  if (body !== undefined) Object.assign(options, {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)
  });
  const res = await fetch(url, options);
  const result = await res.json();
  if (!res.ok || result.error) throw Error(result.error || "Request failed (" + res.status + ").");
  return result;
}

function announce(text, error = false) {
  $("release-feedback").textContent = text;
  $("release-feedback").dataset.error = String(error);
}

function record(text) {
  const row = document.createElement("li");
  row.textContent = new Date().toLocaleTimeString() + "  " + text;
  $("release-log").prepend(row);
  if ($("release-log").children.length > 15) $("release-log").lastChild.remove();
  $("release-record").hidden = false;
}

function liveRelease() { return host?.manifest?.["x-morph-release"]; }

function showStatus() {
  const release = liveRelease();
  const online = Boolean(link?.online);
  const hasDraft = Boolean(desk.snapshot().state?.draft);
  $("release-actions").hidden = !release;
  if (!release) return;
  const compare = release === "compare";
  $("live-version").textContent = "Change review · v" + (compare ? "2" : "1");
  $("live-connection").textContent = online ? "Signed release " + host.version : "Reconnecting…";
  $("release-description").textContent = compare ? "Compare results is active on this desk." :
    "Available update · Compare the original and patched check results on this draft.";
  $("approve-comparison").hidden = $("rehearse-comparison").hidden = compare;
  $("restore-review").hidden = !compare;
  $("approve-comparison").disabled = $("rehearse-comparison").disabled =
    approvalInFlight || !hasDraft || !online || !digest;
  $("restore-review").disabled = approvalInFlight || !online || checking;
}

function snapshot() {
  const model = desk.snapshot();
  const draft = model.state?.draft;
  const savedReport = draft?.comparison;
  const current = report?.digest === digest && report?.base === draft?.base ? report :
    savedReport?.digest === digest && savedReport?.base === draft?.base ? savedReport : null;
  return {...model, report: current};
}

function project(model) {
  const {state, pending, confirmDiscard} = model;
  const draft = state?.draft;
  const stale = Boolean(state?.scan && draft && state.scan.head !== draft.base);
  return {
    "desk/hasDraft": Number(Boolean(draft)), "desk/identity": digest,
    "desk/title": draft?.title || "", "desk/summary": $("diff-summary").textContent,
    "desk/busy": Number(pending), "desk/stale": Number(stale),
    "desk/ran": Number(Boolean(draft?.verification)), "desk/verified": Number(Boolean(draft?.verification?.ok)),
    "desk/saved": Number(Boolean(draft?.review)), "desk/confirm": Number(confirmDiscard),
    "desk/hint": $("action-hint").textContent, "desk/comparing": Number(checking),
    "desk/hasComparison": Number(Boolean(model.report))
  };
}

async function sync() {
  const draft = desk.snapshot().state?.draft;
  if (lastDiff !== draft?.diff) {
    lastDiff = draft?.diff;
    const seq = ++digestRequest;
    digest = ""; report = null; offered = null;
    if (host) await host.exclusive(() => {
      host.kv.set("review/error", ""); host.kv.set("review/request", "");
    });
    const hash = draft ? await sha256(new TextEncoder().encode(draft.diff)) : "";
    if (seq !== digestRequest) return;
    digest = hash;
  }
  const owner = host;
  if (owner) await owner.exclusive(async () => {
    for (const [key, value] of Object.entries(project(snapshot()))) {
      if (owner.kv.get(key) !== value) owner.kv.set(key, value);
    }
    if (owner.version) await owner.renderNow();
  });
  showStatus();
}

async function runComparison(requested) {
  const draft = desk.snapshot().state?.draft;
  if (checking || !draft || requested !== digest) return;
  const base = draft.base;
  checking = true;
  await sync();
  try {
    const outcome = await request("/api/compare", {base, digest: requested});
    if (digest !== requested || base !== desk.snapshot().state?.draft?.base) return;
    report = outcome;
    record("Comparison complete on " + base.slice(0, 10) + ".");
    window.dispatchEvent(new Event("morph:draft-ready"));
  } catch (err) {
    if (requested === digest) announce(err.message, true);
  } finally {
    checking = false;
    await sync();
  }
}

function render(slots) {
  const active = slots.find(item => item.slot === slot);
  if (!active?.tree) {
    if (active?.error) announce(active.error, true);
    $("change-panel").dataset.llp = "unavailable"; $("review-layer").hidden = true; return;
  }
  const model = snapshot();
  $("change-panel").dataset.llp = "ready";
  $("review-layer").hidden = !model.state?.draft;
  if (model.state?.draft) paintReview($("review-layer"), active.tree, model, id => host.dispatch(slot, id));
  const layerView = host.kv.get("review/view");
  if (layerView === "diff" || layerView === "checks") desk.rememberView(layerView);
  if (host.version !== lastVersion) {
    const previous = lastVersion;
    lastVersion = host.version;
    offered = null;
    for (const raw of [...(link?.received || [])].reverse()) {
      const frame = JSON.parse(raw);
      if (frame.t === "manifest" && frame.manifest.version === host.version) { currentEnvelope = frame; break; }
    }
    record("Release " + host.version + " accepted · review " + host.running().review.slice(0, 12));
    if (previous) announce(liveRelease() === "compare" ? "Compare results is ready on the open draft." :
      "Original review restored. The draft is still open.");
  }
  showStatus();
}

async function connect() {
  if (destroyed || connecting) return;
  connecting = true;
  try {
    const next = await request("/api/live/session");
    if (destroyed) return;
    if (!host) {
      host = new LiveHost({app: next.app, trustedKeys: [next.publicKey], onRender: render,
        onLog: event => {
          if (event.kind === "reject" || event.kind === "error" || event.kind === "rollback") {
            record(event.msg); announce(event.msg, true);
          }
        },
        capabilities: {deskAction: op => desk.action(op), compare: runComparison}});
      await sync();
    } else if (session && (session.publicKey.x !== next.publicKey.x || session.publicKey.y !== next.publicKey.y)) {
      throw Error("The desk publisher changed. Reopen the desk to trust its new key.");
    }
    if (!link || !link.online || session.endpoint !== next.endpoint) {
      link?.close();
      link = connectServer(host, next.endpoint, {app: next.app, token: next.token, watch: [],
        retryMs: 800, queueMs: 12000});
    }
    session = next;
  } catch (err) {
    if (!host?.version) {
      $("live-version").textContent = "Live layer unavailable";
      $("release-description").textContent = err.message;
    } else announce(err.message, true);
  } finally {
    connecting = false;
    showStatus();
  }
}

function treeHas(node, test) {
  return test(node) || (node.c || []).some(child => treeHas(child, test));
}

async function rehearse() {
  if (!currentEnvelope || !digest) throw Error("Wait for the signed review layer and an open draft.");
  const initialVersion = host.version, initialDigest = digest;
  const candidate = await request("/api/live/candidate");
  const shadow = new LiveHost({app: session.app, trustedKeys: [session.publicKey]});
  const fetchBlob = async hash => {
    const res = await fetch("/api/live/blob/" + hash);
    if (!res.ok) throw Error("Missing rehearsal layer " + hash.slice(0, 12));
    return new Uint8Array(await res.arrayBuffer());
  };
  try {
    for (const [key,value] of host.kv) shadow.kv.set(key, value);
    const original = await shadow.apply(currentEnvelope.manifest, currentEnvelope.sig, fetchBlob);
    if (!original.ok) throw Error(original.reason);
    const selected = shadow.kv.get("review/view"), title = shadow.kv.get("desk/title");
    const accepted = await shadow.apply(candidate.manifest, candidate.sig, fetchBlob);
    if (!accepted.ok) throw Error(accepted.reason);
    const rows = await shadow.render();
    const tree = rows.find(s => s.slot === slot)?.tree;
    if (shadow.kv.get("desk/identity") !== initialDigest || shadow.kv.get("desk/title") !== title ||
        shadow.kv.get("review/view") !== selected || !tree || !treeHas(tree, n => n.k === "button" && n.a?.id === "compare")) {
      throw Error("The candidate failed the open-draft continuity check.");
    }
    if (host.version !== initialVersion || digest !== initialDigest) throw Error("The draft or release changed during rehearsal. Try again.");
    offered = {version: initialVersion, hash: candidate.manifest.layers.review,
      manifestDigest: candidate.digest, digest: initialDigest};
    record("Rehearsal passed · draft and selected pane preserved · candidate " + offered.hash.slice(0, 12));
    announce("Rehearsal passed. The signed update keeps this draft and its selected pane.");
  } finally { shadow.close(); }
}

async function changeRelease(action) {
  if (approvalInFlight) return;
  approvalInFlight = true; showStatus();
  try {
    if (action !== "restore" && (!offered || offered.version !== host.version || offered.digest !== digest)) {
      announce("Rehearsing the signed update against the open draft…");
      await rehearse();
    }
    if (action === "rehearse") return;
    const version = host.version;
    const body = {expectedVersion: version};
    if (action === "approve") body.expectedDigest = offered.manifestDigest;
    const next = await request("/api/live/" + action, body);
    // The browser installs only the signed manifest received from the WebSocket.
    // The HTTP approval receipt alone cannot activate a control on this desk.
    session = next;
    record("Server committed release " + next.version + " · reviewService " + next.serverHash.slice(0, 12));
    if (host.version < next.version) announce("Server approved. Waiting for the verified browser layer…");
  } catch (err) {
    offered = null;
    announce(err.message, true);
  } finally {
    approvalInFlight = false; showStatus();
  }
}

window.addEventListener("morph:desk-updated", () => sync().catch(e => announce(e.message, true)));
window.addEventListener("morph:select-view", event => {
  if (host) host.dispatch(slot, event.detail).catch(e => announce(e.message, true));
});
$("rehearse-comparison").onclick = () => changeRelease("rehearse");
$("approve-comparison").onclick = () => changeRelease("approve");
$("restore-review").onclick = () => changeRelease("restore");
const watch = setInterval(() => {
  if (!link?.online) connect();
  // The reference transport keeps wire traces for diagnostics. Trim binary frames
  // and previously seen messages after retaining the current signed envelope.
  if (link && currentEnvelope && link.received.length > 80) link.received.splice(0, link.received.length - 40);
  if (link && link.sent.length > 80) link.sent.splice(0, link.sent.length - 40);
  showStatus();
}, 3000);
window.addEventListener("pagehide", event => {
  if (event.persisted) return;
  destroyed = true; clearInterval(watch); link?.close(); host?.close();
}, {once:true});
connect();
