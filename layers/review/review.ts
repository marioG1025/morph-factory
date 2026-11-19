// Both signed releases share the upstream LLP ABI and their review state schema.
import { attr, cap, el, end, eventId, eventValue, getNum, getStr, heading, label, setStr, text } from "./llp";

function group(style: string): void {
  el("col"); attr("style", style);
}

function action(id: string, caption: string, style: string, disabled: bool = false): void {
  el("button");
  attr("id", id); attr("style", style);
  if (disabled) attr("disabled", "1");
  text(caption); end();
}

// The host renders full, scrollable repository documents by reference. Diffs and build
// logs can exceed the SDK's string transfer limit. They never enter the guest's store.
function document(id: string): void {
  el("document"); attr("source", id); end();
}

function comparePanel(inactive: bool): void {
  group("comparison"); heading("Compare results");
  label("Run one check against the original commit and this patch.");
  const waiting = getStr("review/request").length > 0 || getNum("desk/comparing") > 0;
  action("compare", waiting ? "Comparing…" : getNum("desk/hasComparison") ? "Run comparison again" : "Run comparison",
         "primary", inactive || waiting || getStr("desk/identity").length == 0);
  const failure = getStr("review/error");
  if (failure.length) { el("status"); attr("tone", "error"); text(failure); end(); }
  if (getNum("desk/hasComparison") > 0) document("comparison");
  end();
}

export function view(comparison: bool): void {
  group("review");
  if (getNum("desk/hasDraft") == 0) { end(); return; }
  const inactive = getNum("desk/busy") > 0 || getNum("desk/stale") > 0;
  const saved = getNum("desk/saved") > 0;
  const verified = getNum("desk/verified") > 0;
  const checks = getStr("review/view") == "checks";

  group("summary"); heading(getStr("desk/title")); label(getStr("desk/summary")); end();
  group("tabs");
  action("diff", "Diff", checks ? "tab" : "selected");
  action("checks", "Check output", checks ? "selected" : "tab");
  end();
  document(checks ? "checks" : "diff");
  if (comparison) comparePanel(inactive);
  if (saved) document("branch");
  group("controls");
  el("row");
  if (!saved) {
    if (verified) action("save", "Save review branch", "primary", inactive);
    else action("verify", getNum("desk/ran") > 0 ? "Run checks again" : "Run checks", "primary", inactive);
  }
  action("discard", getNum("desk/confirm") > 0 ? "Confirm discard" : saved ? "Clear review" : "Discard draft",
         "secondary", getNum("desk/busy") > 0);
  end();
  label(getStr("desk/hint")); end(); end();
}

export function event(comparison: bool): void {
  const id = eventId();
  if (id == "diff" || id == "checks") { setStr("review/view", id); return; }
  if (id == "save" || id == "verify" || id == "discard") { cap("deskAction", id); return; }
  if (!comparison) return;
  if (id == "compare" && getStr("review/request").length == 0) {
    const identity = getStr("desk/identity");
    if (identity.length > 0) {
      setStr("review/error", ""); setStr("review/request", identity);
      cap("remote", "reviewService:compare");
    }
  }
  if (id == "cap:remote") {
    const requested = getStr("review/request");
    setStr("review/request", "");
    if (requested.length == 0 || requested != getStr("desk/identity")) return;
    if (eventValue() == "allowed") cap("compare", requested);
    else setStr("review/error", "The server did not authorize comparison. Reconnect and try again.");
  }
}
