(() => {
  const control = id => document.getElementById("agent-" + id);
  const dialog = control("dialog");
  let polling = null;
  let inProgress = false;
  let checkSource = null;

  async function request(route, payload) {
    const options = payload ? {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)
    } : {};
    const response = await fetch("/api/agent" + route, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The request failed.");
    return data;
  }

  function show(job) {
    const wasRunning = inProgress;
    inProgress = job.status === "running";
    const available = job.available !== false;
    control("submit").disabled = inProgress || !available;
    control("open").textContent = inProgress ? "View agent progress" : "Propose an idea";
    const message = job.status === "ready" && !wasRunning ? "" : job.message;
    control("status").textContent = available ? message : checkSource ?
      "Codex CLI is unavailable. Copy the proposal text or add a patch manually." :
      "Install and sign in to Codex CLI, then restart this desk.";
    if (inProgress) {
      if (!polling) polling = setTimeout(refresh, 1600);
    } else if (wasRunning && job.status === "ready") {
      if (dialog.open) dialog.close();
      control("form").reset();
      window.dispatchEvent(new Event("morph:draft-ready"));
    }
  }

  async function refresh() {
    clearTimeout(polling);
    polling = null;
    try {
      show(await request("/status"));
    } catch (error) {
      control("status").textContent = "Could not reach the desk. " + error.message;
      if (inProgress) polling = setTimeout(refresh, 3500);
    }
  }

  function openProposal(source, idea) {
    if (source || checkSource) {
      control("idea").value = idea || "";
      control("file").value = "";
    }
    checkSource = source;
    control("copy").hidden = !source;
    control("copy-status").textContent = "";
    control("submit").disabled = true;
    dialog.showModal();
    control("idea").focus();
    refresh();
  }
  control("open").addEventListener("click", () => openProposal(null));
  window.addEventListener("morph:check-proposal", event => openProposal(event.detail.source, event.detail.idea));
  control("copy").addEventListener("click", async () => {
    const field = control("idea");
    try {
      await navigator.clipboard.writeText(field.value);
      control("copy-status").textContent = "Proposal text copied.";
    } catch {
      field.focus();
      field.select();
      control("copy-status").textContent = "Text selected. Use your keyboard’s Copy command.";
    }
  });
  control("close").addEventListener("click", () => dialog.close());
  control("form").addEventListener("submit", async event => {
    event.preventDefault();
    control("submit").disabled = true;
    try {
      const proposal = {idea: control("idea").value.trim(), file: control("file").value.trim()};
      if (checkSource) proposal.checkSource = checkSource;
      show(await request("", proposal));
    } catch (error) {
      control("status").textContent = error.message;
      control("submit").disabled = false;
    }
  });
  refresh();
})();
