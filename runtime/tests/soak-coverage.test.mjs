import assert from "node:assert/strict";
import {test} from "node:test";
import {startCoverage} from "../tools/soak-coverage.mjs";

function clocks() {
  let utc = Date.UTC(2026, 0, 1), steady = 0, pulse;
  const coverage = startCoverage({
    utc:() => utc, steady:() => steady,
    schedule(tick, interval) {
      assert.equal(interval, 5000);
      pulse = tick;
      return () => { pulse = null; };
    }
  });
  return {coverage, pulse:() => pulse(), advance(wallMs, steadyMs = wallMs) { utc += wallMs; steady += steadyMs; }};
}

test("scheduled heartbeats cover long intentional idle periods and tolerate short jitter", () => {
  const clock = clocks();
  for (let tick = 0; tick < 60; tick++) {
    clock.advance(tick % 2 === 0 ? 6100 : 3900);
    clock.pulse();
  }
  clock.coverage.check();
  assert.equal(clock.coverage.report().heartbeats, 60);
  assert.equal(clock.coverage.report().longestGapMs, 6100);
  assert.equal(clock.coverage.report().failure, null);
  clock.coverage.stop();
});

test("a final check catches hours of unobserved UTC even before the overdue timer fires", () => {
  const clock = clocks();
  clock.advance(5000); clock.pulse();
  clock.advance(10 * 3600000, 50); // The monotonic clock can pause during suspension.
  assert.throws(() => clock.coverage.check(), /Scheduled observations were missed.*2026-01-01T00:00:05.*10:00:05/);
  assert.equal(clock.coverage.report().failure.wallGapMs, 36000000);
});

test("a timer-detected gap stays failed after subsequent timely samples", () => {
  const clock = clocks();
  clock.advance(45000); clock.pulse();
  clock.advance(5000); clock.pulse();
  assert.throws(() => clock.coverage.check(), /00:00:00.*00:00:45/);
});

test("a UTC rollback fails an otherwise regular monotonic interval", () => {
  const clock = clocks();
  clock.advance(5000); clock.pulse();
  clock.advance(-2000, 5000); clock.pulse();
  assert.throws(() => clock.coverage.check(), /UTC clock moved backwards.*00:00:05.*00:00:03/);
  assert.equal(clock.coverage.report().failure.steadyGapMs, 5000);
});

test("a long monotonic gap also fails when UTC masks the pause", () => {
  const clock = clocks();
  clock.advance(5000, 60000);
  assert.throws(() => clock.coverage.check(), /Scheduled observations were missed/);
  assert.equal(clock.coverage.report().failure.steadyGapMs, 60000);
});
