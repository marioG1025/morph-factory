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

function showView(name) {
  view = name;
  byId("show-diff").setAttribute("aria-pressed", String(view === "diff"));
  byId("show-checks").setAttribute("aria-pressed", String(view === "checks"));
  byId("diff-view").hidden = view !== "diff";
  byId("checks-view").hidden = view !== "checks";
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
  renderStages(scan, draft);
  if (!draft) return;
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
  showView(view);
}

async function update(action, body = {}) {
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

let checkingHead = false;
byId("watch").addEventListener("change", () => {
  clearInterval(watchTimer);
  if (!byId("watch").checked) return;
  if (!state?.scan && !pending) run(scan);
  watchTimer = setInterval(async () => {
    if (pending || checkingHead || byId("manual-dialog").open || document.hidden) return;
    checkingHead = true;
    try {
      const head = await api("head");
      if (head.changed && byId("watch").checked && !pending) await run(scan);
    } catch (error) {
      byId("watch").checked = false;
      clearInterval(watchTimer);
      message("Commit watch paused. " + error.message, true);
    } finally {
      checkingHead = false;
    }
  }, 10000);
});

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
connect();
