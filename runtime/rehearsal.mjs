import { signManifest, Store } from "./vendor/llp/llp-core.js";
import { ServerLiveHost } from "./vendor/llp/server-host.mjs";

// Run semantic checks on the same two server releases and a copy of the live store.
// No Git checkout, project command, network listener or capability provider is attached.
export async function rehearseServer({current, snapshot, proposed, blob, publicKey, privateKey}) {
  const start = performance.now();
  const {manifest, sig, digest: manifestDigest} = proposed;
  const shadow = new ServerLiveHost({app: manifest.app, trustedKeys: [publicKey],
    capabilities: {}, idleMs: 0});
  const checks = [];
  const release = manifest["x-morph-release"];
  let problem;
  try {
    shadow.kv = new Store(snapshot);
    if (current) {
      const base = await shadow.apply(current.manifest, current.sig, blob);
      if (!base.ok) throw Error("Could not restore baseline in rehearsal: " + base.reason);
    }
    const applied = await shadow.apply(manifest, sig, blob);
    if (!applied.ok) throw Error("Isolated server refused the candidate: " + applied.reason);
    for (const [operation, expected] of [["release", release], ["compare", release === "compare" ? "allowed" : "refused"]]) {
      let actual;
      try {
        actual = await shadow.invoke("reviewService", operation, "rehearsal", "", manifest.version);
      } catch (err) {
        if (operation === "compare" && err.code === "app_error") actual = "refused";
        else throw err;
      }
      checks.push({operation, expected, actual, ok: actual === expected});
    }
  } catch (error) {
    problem = error.message;
  } finally {
    shadow.close();
  }
  const statement = {app: manifest.app, manifestDigest, baseVersion: current?.manifest.version ?? 0,
    version: manifest.version, release, ok: !problem && checks.every(check => check.ok),
    checks, elapsedMs: Math.round(performance.now()-start), atUtc: new Date().toISOString(),
    ...(problem ? {error: problem} : {})};
  return {...statement, sig: await signManifest(statement, privateKey)};
}
