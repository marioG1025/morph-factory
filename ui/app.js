"use strict";

const byId = (id) => document.getElementById(id);
let state = null;
let pending = false;
let view = "diff";
let confirmDiscard = false;
let watchTimer = null;

function message(value, error = false) {
  const notice = byId("notice");
  notice.textContent = value;
  notice.classList.toggle("error", error);
  notice.hidden = !value;
}

function showView(name, notifyLayer = true) {
  view = name;
  byId("show-diff").setAttribute("aria-pressed", String(view === "diff"));
  byId("show-checks").setAttribute("aria-pressed", String(view === "checks"));
  byId("diff-view").hidden = view !== "diff";
  byId("checks-view").hidden = view !== "checks";
  if (notifyLayer) window.dispatchEvent(new CustomEvent("morph:select-view", {detail: name}));
}

async function api(path, body) {
  const options = {cache: "no-store"};
  if (body !== undefined) {
    options.method = "POST";
    options.headers = {"Content-Type": "application/json"};
    options.body = JSON.stringify(body);
  }
  const response = await fetch("/api/" + path, options);
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The factory did not return a valid response (HTTP " + response.status + ").");
  }
  if (!response.ok || result.error) throw new Error(result.error || "Request failed (HTTP " + response.status + ").");
  return result;
}

function renderFindings(scan) {
  const list = byId("findings");
  const expanded = new Set([...list.querySelectorAll("details[open]")].map((item) => item.dataset.id));
  list.replaceChildren();
  const findings = scan?.findings ?? [];
  byId("finding-count").textContent = scan ? String(findings.length) : "—";
  if (!findings.length) {
    const empty = document.createElement("p");
    empty.className = "placeholder";
    empty.textContent = scan ? "This scan returned no findings." : "Scan the repository to see source locations and evidence.";
    list.append(empty);
    return;
  }
  for (const finding of findings) {
    const item = document.createElement("details");
    item.className = "finding";
    item.dataset.id = String(finding.id);
    item.open = expanded.has(item.dataset.id);
    const summary = document.createElement("summary");
    summary.textContent = finding.title;
    const location = document.createElement("span");
    location.className = "path";
    location.textContent = finding.path + (finding.line ? ":" + finding.line : "");
    const evidence = document.createElement("p");
    evidence.className = "evidence";
    evidence.textContent = finding.evidence;
    summary.append(location);
    item.append(summary, evidence);
    list.append(item);
  }
}

function renderDiff(draft) {
  const output = byId("diff-output");
  output.replaceChildren();
  const lines = draft.diff.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  let added = 0;
  let removed = 0;
  const rows = document.createDocumentFragment();
  for (const source of lines) {
    const row = document.createElement("span");
    row.className = "diff-line";
    if (/^(\+\+\+|---|@@|diff --git|index )/.test(source)) {
      row.classList.add("meta");
    } else if (source.startsWith("+")) {
      row.classList.add("add");
      added++;
    } else if (source.startsWith("-")) {
      row.classList.add("remove");
      removed++;
    }
    row.textContent = source;
    rows.append(row);
  }
  output.append(rows);
  byId("diff-summary").textContent = "+" + added + " / −" + removed + " lines · base " + draft.base.slice(0, 10);
}

let checkingCommit = false;
let renderedHeadRun;

function renderHeadCheck() {
  const result = state?.headCheck;
  byId("head-intake").hidden = !state || Boolean(state.draft);
  byId("check-head").disabled = !state?.check?.length || pending || checkingCommit;
  let status = state?.check?.length ? "Run your configured check on a clean copy of HEAD." :
    "Start the desk with --check and a trusted project command to check this commit.";
  if (result) {
    status = result.base.slice(0, 10) + " · " + result.label;
    if (result.failed) status += " " + result.failed + (result.failed === 1 ? " named failure." : " named failures.");
    if (result.failed + result.errors > result.cases.length) status += " Showing the first " + result.cases.length + ".";
  }
  byId("head-status").textContent = checkingCommit ? "Checking a clean copy of the current commit…" : status;
  if (renderedHeadRun === result?.id) return;
  renderedHeadRun = result?.id;
  byId("head-output").hidden = !result?.output;
  byId("head-output").querySelector("pre").textContent = result?.output || "";
  const list = byId("head-cases");
  list.replaceChildren();
  for (const [index, item] of (result?.cases || []).entries()) {
    const row = document.createElement("details");
    row.open = index === 0;
    const title = document.createElement("summary");
    title.textContent = item.name;
    const detail = document.createElement("p");
    detail.className = "evidence";
    detail.textContent = item.detail || "No additional detail from the runner.";
    row.append(title, detail);
    if (item.status === "failed") {
      const proposal = document.createElement("button");
      proposal.type = "button";
      proposal.className = "button secondary";
      proposal.textContent = "Prepare proposal";
      proposal.addEventListener("click", () => window.dispatchEvent(new CustomEvent("morph:check-proposal",
        {detail: {source:{base: result.base, run: result.id, case: item.id},
          idea: "Fix the failing check “" + item.name + "”.\n\nCommit " + result.base +
            (item.detail ? "\nObserved result:\n" + item.detail : "")}})));
      row.append(proposal);
    }
    list.append(row);
  }
}

function renderStages(scan, draft) {
  const steps = ["scan", "draft", "verify", "review"];
  const completed = [Boolean(scan), Boolean(draft), Boolean(draft?.verification?.ok), Boolean(draft?.review)];
  const next = completed.indexOf(false);
  steps.forEach((step, index) => {
    const item = document.querySelector('[data-stage="' + step + '"]');
    const failed = step === "verify" && draft?.verification?.ok === false;
    item.classList.toggle("done", completed[index]);
    item.classList.toggle("current", next === index);
    item.classList.toggle("failed", failed);
    const detail = item.querySelector(".stage-mark");
    detail.textContent = completed[index] ? "✓" : failed ? "!" : String(index + 1);
    detail.setAttribute("aria-label", completed[index] ? "Complete" : failed ? "Failed" : "Step " + (index + 1));
  });
}

function render() {
  const history = state?.history || [];
  byId("history-count").textContent = history.length ? "(" + history.length + ")" : "";
  const entries = history.map(event => {
    const row = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = event.title;
    const detail = document.createElement("span");
    detail.textContent = [event.outcome, event.base.slice(0, 8), new Date(event.at).toLocaleString(), event.branch].filter(Boolean).join(" · ");
    row.append(title, detail);
    return row;
  });
  byId("history-records").replaceChildren(...entries);
  if (!history.length) byId("history-records").textContent = "Run a verification to record the first experiment for this checkout.";
  const scan = state?.scan;
  const draft = state?.draft;
  const ready = Boolean(state) && !pending;
  const review = draft?.review;
  const verified = draft?.verification?.ok === true;
  const stale = Boolean(draft && scan && draft.base !== scan.head);
  const repoPath = state?.repo ?? "";
  const repoName = repoPath.split(/[\\/]/).filter(Boolean).at(-1);
  const connection = byId("connection");
  connection.textContent = state ? "Local host" : "Disconnected";
  connection.className = "connection " + (state ? "online" : "offline");
  byId("repo-name").textContent = repoName || "Repository unavailable";
  byId("repo-path").textContent = repoPath;
  byId("branch").textContent = scan?.branch || "—";
  byId("commit").textContent = scan?.head?.slice(0, 10) || "—";
  byId("commit").title = scan?.head || "";
  byId("tree").textContent = scan ? (scan.dirty ? "Uncommitted changes" : "Clean") : "—";
  byId("case-link").hidden = scan?.head !== "6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24";
  byId("scan").disabled = !ready;
  byId("scan").textContent = scan ? "Rescan" : "Scan only";
  byId("watch").disabled = !ready;
  renderWatchOptions();
  byId("walkthrough").disabled = !ready || Boolean(review) || stale;
  byId("walkthrough").lastChild.textContent = draft ? (verified ? "Inspect checks" : "Verify current draft") : "Run walkthrough";
  byId("manual").disabled = !ready || !scan;
  byId("auto-draft").hidden = !scan?.proposal;
  byId("auto-draft").disabled = !ready;
  byId("empty-draft").hidden = Boolean(draft);
  byId("active-draft").hidden = !draft;
  byId("save-draft").disabled = !ready;
  const hint = byId("draft-hint");
  hint.textContent = scan ? (scan.proposal ? scan.proposal.title : "This scan has no suggested patch. Add a unified diff to test your own change.") : "Run the walkthrough to scan this repository and test an available patch. You decide whether to save the review branch.";
  const badge = byId("draft-status");
  badge.textContent = review ? "Branch saved" : stale ? "Base changed" : verified ? "Verified" : draft?.verification ? "Checks failed" : draft ? "Draft" : "Waiting";
  badge.className = "pill" + (stale || draft?.verification?.ok === false ? " bad" : verified || review ? " good" : "");
  renderFindings(scan);
  renderHeadCheck();
  renderStages(scan, draft);
  if (!draft) {
    window.dispatchEvent(new Event("morph:desk-updated"));
    return;
  }
  byId("draft-title").textContent = draft.title;
  renderDiff(draft);
  byId("checks-output").textContent = draft.verification ? [verified ? "PASS" : "FAIL", draft.verification.verification, draft.verification.output].filter(Boolean).join("\n\n") : "Run checks to capture verification output.";
  byId("verify").hidden = Boolean(review) || verified;
  byId("verify").disabled = !ready || stale;
  byId("verify").textContent = draft.verification ? "Run checks again" : "Run checks";
  byId("review").hidden = !verified || Boolean(review);
  byId("review").disabled = !ready || stale;
  byId("discard").disabled = !ready;
  byId("discard").textContent = confirmDiscard ? "Confirm discard" : review ? "Clear review" : "Discard draft";
  byId("review-result").hidden = !review;
  if (review) {
    byId("review-branch").textContent = review.branch;
    byId("review-commit").textContent = "Commit " + review.commit;
    // Quote PowerShell arguments as literals, including paths that contain spaces.
    const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
    byId("publish-command").textContent = "python publish_review.py --repo " + quote(repoPath) + " --branch " + quote(review.branch);
  }
  byId("action-hint").textContent = review ? "The branch is ready for local review." : stale ? "The repository has a newer commit. Rebase the patch and create a fresh draft." : verified ? "Save the tested commit on a local branch for review." : "Verification runs the configured project check against this patch.";
  showView(view, false);
  window.dispatchEvent(new Event("morph:desk-updated"));
}

async function update(action, body = {}) {
  if (state?.draft && (action === "verify" || action === "discard")) {
    const {base, diff} = state.draft;
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(diff)));
    body.expectedPatch = {base, digest: Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")};
  }
  state = await api(action, body);
  render();
}

async function run(task) {
  if (pending) return;
  pending = true;
  confirmDiscard = false;
  render();
  try {
    await task();
  } catch (error) {
    message(error.message, true);
    if (byId("manual-dialog").open) {
      byId("form-error").textContent = error.message;
      byId("form-error").hidden = false;
    }
    // A failed or stale request can still leave a verification report on the host.
    try { state = await api("state"); } catch { state = null; }
  } finally {
    pending = false;
    render();
  }
}

async function scan() {
  message("Scanning the current commit…");
  await update("scan");
  const count = state.scan.findings.length;
  message("Scan complete. " + count + (count === 1 ? " finding" : " findings") + " at " + state.scan.head.slice(0, 10) + ".");
}

async function verify() {
  showView("checks");
  message("Running the configured verification command…");
  await update("verify");
  if (state.draft?.verification?.ok) {
    message("Checks passed. Inspect the diff and choose whether to save a review branch.");
  } else {
    message("Verification failed. Inspect the check output before revising the patch.", true);
  }
}

byId("scan").addEventListener("click", () => run(scan));
byId("check-head").addEventListener("click", () => run(async () => {
  checkingCommit = true;
  renderHeadCheck();
  try {
    if (!state.scan) await update("scan");
    await update("check-head", {base: state.scan.head});
    message("");
  } finally {
    checkingCommit = false;
  }
}));
byId("verify").addEventListener("click", () => run(verify));
byId("walkthrough").addEventListener("click", () => run(async () => {
  if (!state.draft) {
    await scan();
    if (!state.scan.proposal) {
      message("Scan complete. Add your own patch to continue the walkthrough.");
      return;
    }
    message("Preparing the suggested patch…");
    await update("draft", {base: state.scan.head, ifEmpty: true});
  }
  if (state.draft.verification?.ok) {
    showView("checks");
    byId("change-panel").scrollIntoView({block: "nearest"});
    message("Checks passed. Save a review branch when you are ready.");
    return;
  }
  await verify();
}));
byId("auto-draft").addEventListener("click", () => run(async () => {
  await update("draft", {base: state.scan.head, ifEmpty: true});
  showView("diff");
  message("Draft created. Inspect its diff and run checks.");
}));
byId("review").addEventListener("click", () => run(async () => {
  message("Saving the verified commit on a local review branch…");
  await update("review", {digest: state.draft.verification.digest});
  message("Saved " + state.draft.review.branch + ".");
}));
byId("discard").addEventListener("click", () => {
  if (!confirmDiscard && !state?.draft?.review) {
    confirmDiscard = true;
    render();
    message("Choose Confirm discard to remove the current draft.");
    return;
  }
  run(async () => {
    await update("discard");
    showView("diff");
    message("Draft cleared.");
  });
});
byId("show-diff").addEventListener("click", () => showView("diff"));
byId("show-checks").addEventListener("click", () => showView("checks"));

let manualBase = "";
byId("manual").addEventListener("click", () => {
  byId("form-error").hidden = true;
  manualBase = state.scan.head;
  byId("manual-base").textContent = "Base commit " + manualBase.slice(0, 10);
  byId("manual-dialog").showModal();
  byId("patch-title").focus();
});
byId("close-dialog").addEventListener("click", () => byId("manual-dialog").close());
byId("patch-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    await update("draft", {title: byId("patch-title").value.trim(), diff: byId("patch-diff").value, base: manualBase, ifEmpty: true});
    byId("manual-dialog").close();
    byId("patch-form").reset();
    showView("diff");
    message("Draft created. Inspect its diff and run checks.");
  });
});

// The subscription belongs to this tab. Its first observation is an anchor.
// Comparing against the server's shared scan alone would let one tab consume
// a commit change before the other watchers had observed it.
let watchEpoch = 0, watchCursor = null, watchTarget = null, watchPolling = false, watchNote = "";
function renderWatchOptions() {
  const watching = byId("watch").checked;
  byId("watch-options").hidden = !watching;
  const checks = byId("watch-checks");
  checks.disabled = !watching || !state?.checkKey || (!checks.checked && Boolean(state?.draft));
  byId("watch-command").textContent = watching && state?.check ?
    state.check.map(arg => /\s|"/.test(arg) ? JSON.stringify(arg) : arg).join(" ") : "";
  let note = watchNote || (watchCursor ? "Watching from " + watchCursor.slice(0, 10) + "." : "Reading the current commit…");
  if (!state?.checkKey) note = "Scanning only. Configure a trusted --check command to watch for failures.";
  else if (state?.draft) note = checks.checked ? "Project checks are paused while a draft is open." :
    "Watched project checks are available on an empty desk.";
  byId("watch-status").textContent = note;
}

function scheduleWatch(delay) {
  clearTimeout(watchTimer);
  if (byId("watch").checked && !document.hidden) watchTimer = setTimeout(pollWatch, delay);
}

function canPoll(epoch) {
  return epoch === watchEpoch && byId("watch").checked && !pending && !document.hidden && !document.querySelector("dialog[open]");
}

async function pollWatch() {
  const epoch = watchEpoch;
  if (watchPolling) return;
  if (!canPoll(epoch)) { scheduleWatch(10000); return; }
  watchPolling = true;
  let delay = 10000;
  try {
    const head = await api("head");
    if (!canPoll(epoch)) return;
    const commandChanged = state?.checkKey !== head.checkKey;
    if (commandChanged) {
      byId("watch-checks").checked = false;
      watchTarget = null;
      watchNote = "The configured command changed. Review it before enabling watched checks.";
    }
    const checks = byId("watch-checks").checked;
    if (watchCursor !== head.head) {
      watchTarget = watchCursor && checks && !head.occupied ?
        {base: head.head, checkKey: head.checkKey, generation: head.draftGeneration} : null;
      watchCursor = head.head;
      if (!commandChanged) watchNote = "";
    }
    if (head.occupied) watchTarget = null;
    const needsScan = state?.scan?.head !== head.head;
    if (needsScan || commandChanged || state?.draftGeneration !== head.draftGeneration ||
        (state?.headCheck?.id || null) !== head.checkRun) {
      const before = state;
      const fresh = needsScan ? await api("scan", {ifChanged:true}) : await api("state");
      if (!canPoll(epoch) || state !== before) { delay = 0; return; }
      state = fresh;
      render();
      // HEAD can advance inside the scan itself. Pick up the latest SHA.
      if (state.scan?.head !== head.head) { delay = 0; return; }
    }
    if (!watchTarget || !checks) return;
    watchNote = "Checking " + watchTarget.base.slice(0, 10) + "…";
    renderWatchOptions();
    const before = state;
    const reply = await api("watch-check", watchTarget);
    if (!canPoll(epoch) || state !== before) { delay = 0; return; }
    if (reply.status === "running") {
      watchNote = "Waiting for the active project check.";
      delay = 1700;
      return;
    }
    if (reply.status === "moved") { delay = 0; return; }
    watchTarget = null;
    if (reply.status === "ready") {
      state = reply.state;
      watchNote = "Checked " + state.headCheck.base.slice(0, 10) + ". " + state.headCheck.label;
      if (state.headCheck.status === "error") {
        byId("watch-checks").checked = false;
        watchNote += " Watched checks paused. Inspect the output before enabling them again.";
      }
      render();
    } else if (reply.status === "command-changed") {
      byId("watch-checks").checked = false;
      watchNote = "The configured command changed. Review it before enabling watched checks.";
      delay = 0;
    } else {
      watchNote = reply.status === "occupied" ? "Skipped this commit because the proposal changed." : "";
      delay = 0;
    }
  } catch (error) {
    if (epoch === watchEpoch) {
      byId("watch").checked = byId("watch-checks").checked = false;
      watchTarget = null;
      message("Commit watch paused. " + error.message, true);
    }
  } finally {
    watchPolling = false;
    renderWatchOptions();
    scheduleWatch(epoch === watchEpoch ? delay : 0);
  }
}

function resetWatch() {
  watchEpoch++;
  watchCursor = watchTarget = null;
  watchNote = "";
  if (!byId("watch").checked) byId("watch-checks").checked = false;
  renderWatchOptions();
  scheduleWatch(0);
}
byId("watch").addEventListener("change", resetWatch);
byId("watch-checks").addEventListener("change", resetWatch);
document.addEventListener("visibilitychange", () => scheduleWatch(0));

async function connect() {
  try {
    state = await api("state");
    if (state.draft && !state.scan) state = await api("scan", {});
    if (state.draft?.verification?.ok === false) showView("checks");
  } catch (error) {
    message("Could not connect to the local factory. Reload this page after starting the server. " + error.message, true);
  }
  render();
}
window.addEventListener("morph:draft-ready", connect);
// The shell owns Git state, large documents and approved side effects. The signed
// review layer chooses what to render and asks for a narrow, named action.
window.morphDesk = Object.freeze({
  snapshot: () => ({state, pending, confirmDiscard, view}),
  rememberView: name => showView(name, false),
  action: name => {
    const controls = {verify: "verify", save: "review", discard: "discard"};
    const control = controls[name] && byId(controls[name]);
    if (state?.draft && control && !control.disabled && !control.hidden) control.click();
  }
});
connect();
