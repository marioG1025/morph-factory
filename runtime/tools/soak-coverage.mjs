// Observe the test runner even during a deliberate wait between product checks.
const heartbeatMs = 5000;
const allowedGapMs = 15000;

function scheduleHeartbeat(tick, interval) {
  const timer = setInterval(tick, interval);
  timer.unref();
  return () => clearInterval(timer);
}

export function startCoverage({utc = Date.now, steady = () => performance.now(), schedule = scheduleHeartbeat} = {}) {
  let lastUtc = utc(), lastSteady = steady();
  let heartbeats = 0, longestGapMs = 0, failure = null;
  const iso = timestamp => new Date(timestamp).toISOString();
  function sample() {
    const now = utc(), currentSteady = steady();
    const wallGapMs = now - lastUtc, steadyGapMs = currentSteady - lastSteady;
    longestGapMs = Math.max(longestGapMs, wallGapMs, steadyGapMs);
    if (!failure && (wallGapMs < 0 || longestGapMs > allowedGapMs)) {
      failure = {reason:wallGapMs < 0 ? "UTC clock moved backwards" : "Scheduled observations were missed",
        fromUtc:iso(lastUtc), toUtc:iso(now), wallGapMs, steadyGapMs:Math.round(steadyGapMs)};
    }
    lastUtc = now;
    lastSteady = currentSteady;
  }
  const stop = schedule(() => { heartbeats++; sample(); }, heartbeatMs);
  function report() {
    sample();
    return {heartbeatMs, allowedGapMs, heartbeats, longestGapMs:Math.round(longestGapMs),
      lastObservedUtc:iso(lastUtc), failure};
  }
  return {
    stop, report,
    check() {
      // A resumed deadline callback can run before the overdue interval callback.
      const observed = report();
      if (failure) throw Error(`${failure.reason} from ${failure.fromUtc} to ${failure.toUtc}. Rerun the interval on an awake host with a stable clock.`);
      return observed;
    }
  };
}
