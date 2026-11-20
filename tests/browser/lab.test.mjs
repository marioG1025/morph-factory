import assert from "node:assert/strict";
import {test} from "node:test";
import {launchBrowser, startDesk} from "./desk.mjs";

test("unfinished note and caret survive a signed lab upgrade while the operator is typing", {timeout:90000}, async t => {
  const desk = await startDesk(); t.after(() => desk.close());
  const browser = await launchBrowser(); t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", err => errors.push(err.message));
  await page.goto(new URL("lab/index.html", desk.url).href);
  await page.locator("#upgrade:enabled").waitFor();
  const tasks = () => page.locator("#tasks button").evaluateAll(rows => rows.map(el => [el.textContent, el.ariaPressed]));
  const initialTasks = await tasks();
  const input = page.locator("#draft");
  await input.fill("Ship now");
  const initialDoc = await page.evaluate(() => performance.timeOrigin);

  // Hold only the real task blob callback inside the existing host's signed apply.
  // The manifest signature is checked before the host fetches a changed blob.
  await page.evaluate(async () => {
    const {LiveHost} = await import("/lab/llp-core.js");
    const probe = window.labProbe = {stage:"upgrade", paints:[]};
    const apply = LiveHost.prototype.apply;
    LiveHost.prototype.apply = function(manifest, sig, fetchBlob) {
      if (probe.stage !== "upgrade") return apply.call(this, manifest, sig, fetchBlob);
      return apply.call(this, manifest, sig, async hash => {
        const bytes = await fetchBlob(hash);
        probe.version = manifest.version;
        await new Promise(resolve => {probe.resume = resolve;});
        return bytes;
      });
    };
    const render = LiveHost.prototype.renderNow;
    LiveHost.prototype.renderNow = async function(...args) {
      const prior = document.querySelector("#tasks button");
      const result = await render.apply(this, args);
      const field = document.getElementById("draft");
      probe.paints.push({stage:probe.stage, version:this.version,
        tasksRedrawn:prior !== document.querySelector("#tasks button"), text:field.value, committed:this.kv.get("draft"),
        latest:this.bound("draft"), caret:field.selectionStart, focus:document.activeElement === field, disabled:field.disabled});
      return result;
    };
  });
  await page.locator("#upgrade").click();
  await page.waitForFunction(() => Boolean(window.labProbe.resume));
  assert.equal(await input.isEnabled(), true);
  assert.equal(await page.locator("#add").isEnabled(), false);
  await input.focus();
  await input.evaluate(el => el.setSelectionRange(4, 4));
  await input.pressSequentially(" Friday,");
  await input.press("ArrowLeft");
  const editor = () => input.evaluate(el => ({text:el.value, caret:el.selectionStart, focus:document.activeElement === el}));
  const typed = await editor();
  assert.deepEqual(typed, {text:"Ship Friday, now", caret:11, focus:true});
  await page.evaluate(() => window.labProbe.resume());
  await page.getByText(/Version 2 accepted/).waitFor();
  const redraw = await page.evaluate(() => window.labProbe.paints.find(p => p.stage === "upgrade" && p.version === 2 && p.tasksRedrawn));
  assert.ok(redraw, "The real signed upgrade redrew the task layer before the queued inputs committed");
  assert.equal(redraw.committed, "Ship now");
  assert.equal(redraw.latest, typed.text);
  assert.equal(redraw.text, typed.text);
  assert.equal(redraw.caret, typed.caret);
  assert.equal(redraw.focus, true);
  assert.deepEqual(await editor(), typed);
  assert.deepEqual(await tasks(), initialTasks);

  await page.evaluate(() => {window.labProbe.stage = "rehearsal";});
  await page.locator("#fail").click();
  await page.getByText(/LLP restored the previous layer/).waitFor();
  const rehearsal = await page.evaluate(() => window.labProbe.paints.filter(p => p.stage === "rehearsal"));
  assert.ok(rehearsal.length);
  assert.ok(rehearsal.every(p => p.disabled && p.text === typed.text), "The synthetic Add never appears in the editor");
  assert.equal(await input.inputValue(), typed.text);
  assert.deepEqual(await tasks(), initialTasks);
  await page.locator("#add").click();
  await page.locator("#tasks button").filter({hasText:typed.text}).waitFor();
  assert.equal((await tasks()).length, initialTasks.length + 1);
  assert.equal(await input.inputValue(), "");
  assert.equal(await page.evaluate(() => performance.timeOrigin), initialDoc);
  assert.deepEqual(errors, []);
  t.diagnostic("At the signed redraw: committed KV was 'Ship now'; bound text and the editor were 'Ship Friday, now'; caret 11.");
});
