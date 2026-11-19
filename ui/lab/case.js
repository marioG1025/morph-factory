"use strict";

const sourceHead = "6a2349d6ac2cb80ec5b32d46dee04b8f7d7bfb24";
const repairs = {
  date: {title: "Keep date-only VibeCheck events on the scheduled day", file: "calendar-day.patch"},
  build: {title: "Restore Vite environment types for the frontend build", file: "vite-types.patch"}
};
const controls = document.querySelectorAll(".load");
const status = document.getElementById("case-status");
const dialog = document.getElementById("replace-dialog");
let replacement = null;
let submitting = false;
let headMatches = false;

async function api(action, payload) {
  const options = {cache: "no-store"};
  if (payload !== undefined) {
    options.method = "POST";
    options.headers = {"Content-Type": "application/json"};
    options.body = JSON.stringify(payload);
  }
  const response = await fetch("/api/" + action, options);
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "Factory request failed.");
  return data;
}

function updateControls() {
  for (const button of controls) button.disabled = submitting || !headMatches;
}

function notice(text, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

function checkHead(current) {
  headMatches = current === sourceHead;
  updateControls();
  if (!headMatches) throw new Error("The active checkout is at " + current.slice(0, 10) + ". Open the VibeCheck demo at " + sourceHead.slice(0, 10) + " to load these patches.");
}

async function draftIdentity(draft) {
  const bytes = new TextEncoder().encode(draft.diff);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return {base: draft.base, title: draft.title,
    digest: Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join(""),
    reviewCommit: draft.review?.commit ?? null, verified: draft.verification?.ok ?? null};
}

async function save(payload) {
  await api("draft", payload);
  window.location.assign("/");
}

async function loadCase(name) {
  if (submitting) return;
  submitting = true;
  updateControls();
  try {
    const repair = repairs[name];
    if (!repair) throw new Error("Unknown repair.");
    const state = await api("scan", {});
    checkHead(state.scan.head);
    const response = await fetch(repair.file, {cache: "no-store"});
    if (!response.ok) throw new Error("Could not load " + repair.file + ".");
    const diff = await response.text();
    if (state.draft?.diff === diff && state.draft.base === sourceHead) {
      window.location.assign("/");
      return;
    }
    const payload = {title: repair.title, diff, base: sourceHead};
    if (!state.draft) {
      await save({...payload, ifEmpty: true});
      return;
    }
    replacement = {...payload, expectedDraft: await draftIdentity(state.draft)};
    document.getElementById("replace-copy").textContent = "Replace “" + state.draft.title + "” with “" + repair.title + "” on the factory floor?";
    dialog.showModal();
  } catch (error) {
    notice(error.message, true);
  } finally {
    submitting = false;
    updateControls();
  }
}

for (const button of controls) button.addEventListener("click", () => loadCase(button.dataset.case));
document.getElementById("cancel").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => { replacement = null; });
document.getElementById("replace").addEventListener("click", async () => {
  if (!replacement || submitting) return;
  submitting = true;
  const payload = replacement;
  dialog.close();
  updateControls();
  try {
    await save(payload);
  } catch (error) {
    notice(error.message, true);
  } finally {
    submitting = false;
    updateControls();
  }
});

api("head").then(data => {
  checkHead(data.head);
  notice("Choose a repair to inspect its patch and run local checks.");
}).catch(error => notice(error.message, true));
