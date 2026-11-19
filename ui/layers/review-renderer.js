// A small native renderer for the review layer's LLP UI tree. Only known elements,
// styles and document names are accepted; source text never becomes markup.
const styles = {
  review: "live-review", summary: "draft-summary", tabs: "live-view-switch",
  controls: "draft-controls", comparison: "comparison-panel"
};
const textOf = node => (node.c || []).filter(child => child.k === "text").map(child => child.t).join("");

function element(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}

function printComparison(report) {
  const content = document.createDocumentFragment();
  content.append(element("p", report.conclusion, "comparison-conclusion"));
  if (report.at && report.releaseVersion) content.append(element("p", "Measured on release " + report.releaseVersion +
    " · " + new Date(report.at).toLocaleString(), "footnote"));
  const pair = element("div", undefined, "comparison-runs");
  for (const [title, side] of [["Original", report.baseline], ["Patched", report.candidate]]) {
    const tile = element("section", undefined, "comparison-run");
    tile.dataset.status = side.status;
    tile.append(element("h4", title), element("strong", side.status));
    const facts = side.cases?.length ? side.passed + " passed · " + side.failed + " failed" : "Exit " + (side.exitCode ?? "—");
    tile.append(element("p", facts + " · " + (side.durationMs / 1000).toFixed(2) + " s", "footnote"));
    pair.append(tile);
  }
  content.append(pair);
  const cases = element("ul", undefined, "comparison-cases");
  for (const change of (report.changes || [])) {
    const row = element("li");
    row.dataset.kind = change.classification;
    row.append(element("span", change.name), element("span", change.classification));
    cases.append(row);
  }
  if (cases.childElementCount) content.append(cases);
  for (const [label, side] of [["Original output", report.baseline], ["Patched output", report.candidate]]) {
    const details = element("details", undefined, "comparison-raw");
    const log = element("pre", side.output || "The command produced no output.");
    details.append(element("summary", label), log);
    content.append(details);
  }
  return content;
}

function diffContent(diff) {
  const fragment = document.createDocumentFragment();
  for (const line of diff.trimEnd().split(/\r?\n/)) {
    const kind = /^(\+\+\+|---|@@|diff --git|index )/.test(line) ? "meta" :
      line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : "";
    fragment.append(element("span", line, ("diff-line " + kind).trim()));
  }
  return fragment;
}

function branchContent(review, repo) {
  const fragment = document.createDocumentFragment();
  const hint = element("details", undefined, "publish-hint");
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  hint.append(element("summary", "Publish a GitHub draft PR"),
    element("p", "Preview the destination. Add --publish to push the branch and open a draft PR."),
    element("code", "python publish_review.py --repo " + quote(repo) + " --branch " + quote(review.branch)));
  fragment.append(element("p", "Local review branch", "eyebrow"), element("strong", review.branch),
    element("p", "Commit " + review.commit, "mono"), hint);
  return fragment;
}

function renderDocument(el, source, model) {
  const draft = model.state?.draft;
  if (!draft) return;
  let key;
  let build;
  switch (source) {
    case "diff":
      key = draft.diff;
      build = () => diffContent(draft.diff);
      el.tabIndex = 0; el.setAttribute("aria-label", "Unified diff"); break;
    case "checks": {
      const run = draft.verification;
      key = run ? [run.ok ? "PASS" : "FAIL", run.verification, run.output].filter(Boolean).join("\n\n") :
        "Run checks to capture verification output.";
      build = () => document.createTextNode(key);
      el.tabIndex = 0; el.setAttribute("aria-label", "Verification results"); break;
    }
    case "branch":
      if (!draft.review) return;
      key = draft.review.commit; build = () => branchContent(draft.review, model.state.repo); break;
    case "comparison":
      if (!model.report) return;
      key = JSON.stringify(model.report); build = () => printComparison(model.report); break;
    default: return;
  }
  if (el._documentKey !== key) {
    el.replaceChildren(build());
    el._documentKey = key;
  }
}

function descriptor(node, index) {
  const attrs = node.a || {};
  switch (node.k) {
    case "root":
    case "col": return ["div", styles[attrs.style] || "", "col-" + (attrs.style || index)];
    case "row": return ["div", "actions", "actions"];
    case "heading": return ["h3", "", "heading"];
    case "label": return ["p", "footnote", "label-" + index];
    case "status": return ["p", "live-error", "error"];
    case "button": {
      const tab = ["tab", "selected"].includes(attrs.style);
      return ["button", tab ? "" : "button " + (attrs.style === "primary" ? "primary" : "secondary"), "action-" + attrs.id];
    }
    case "document": {
      const textDocument = ["diff", "checks"].includes(attrs.source);
      return [textDocument ? "pre" : "div", attrs.source === "branch" ? "review-result" : "live-document", "document-" + attrs.source];
    }
    default: return null;
  }
}

// Reuse keyed elements in place. A release that inserts a new panel keeps the diff
// scroll position, browser selection, disclosure state and focused controls.
function reconcile(parent, nodes, model, dispatch) {
  const existing = new Map([...parent.children].map(el => [el.dataset.layerKey, el]));
  const desired = new Set((nodes || []).map(descriptor).filter(Boolean).map(shape => shape[2]));
  for (const [key, el] of existing) if (!desired.has(key)) { el.remove(); existing.delete(key); }
  let index = 0;
  for (const node of nodes || []) {
    const shape = descriptor(node, index);
    if (!shape) continue;
    const [tag, css, key] = shape;
    const attrs = node.a || {};
    let el = existing.get(key);
    if (!el || el.localName !== tag) el = document.createElement(tag);
    existing.delete(key);
    el.dataset.layerKey = key; el.className = css;
    if (parent.children[index] !== el) parent.insertBefore(el, parent.children[index] || null);
    if (node.k === "button") {
      el.type = "button";
      el.id = "layer-" + attrs.id;
      el.disabled = attrs.disabled === "1";
      el.onclick = () => dispatch(attrs.id);
      if (attrs.style === "tab" || attrs.style === "selected") el.setAttribute("aria-pressed", String(attrs.style === "selected"));
    }
    if (node.k === "document") renderDocument(el, attrs.source, model);
    else if (["button","label","heading","status"].includes(node.k)) {
      const text = textOf(node);
      if (el.textContent !== text) el.textContent = text;
    } else reconcile(el, node.c, model, dispatch);
    index++;
  }
  for (const el of existing.values()) el.remove();
}

export function paintReview(container, tree, model, dispatch) {
  reconcile(container, [tree], model, dispatch);
}
