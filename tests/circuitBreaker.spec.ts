import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { CircuitBreaker, CircuitState } from "../src/circuitBreaker";

describe("CircuitBreaker — full state-machine coverage", () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Initial state ────────────────────────────────────────────────────────

  it("starts in CLOSED state", () => {
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    expect(cb.canExecute()).toBe(true);
  });

  // ── CLOSED → OPEN ────────────────────────────────────────────────────────

  it("remains CLOSED below the failure threshold", () => {
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    expect(cb.canExecute()).toBe(true);
  });

  it("trips to OPEN once failureThreshold is reached", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure(); // 3rd = threshold
    expect(cb.getState()).toBe(CircuitState.OPEN);
    expect(cb.canExecute()).toBe(false);
  });

  it("success in CLOSED resets the failure counter, preventing premature trip", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess(); // reset counter
    cb.recordFailure();
    cb.recordFailure();
    // Only 2 failures after the reset — still CLOSED
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    cb.recordFailure(); // now 3 total since last success → OPEN
    expect(cb.getState()).toBe(CircuitState.OPEN);
  });

  // ── OPEN → HALF_OPEN (time-based probe) ──────────────────────────────────

  it("stays OPEN before resetTimeoutMs elapses", () => {
    cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
    vi.advanceTimersByTime(999); // just under timeout
    expect(cb.getState()).toBe(CircuitState.OPEN);
    expect(cb.canExecute()).toBe(false);
  });

  it("transitions to HALF_OPEN after resetTimeoutMs elapses", () => {
    cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
    vi.advanceTimersByTime(1001);
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
    expect(cb.canExecute()).toBe(true);
  });

  // ── HALF_OPEN → CLOSED (success path) ────────────────────────────────────

  it("closes the circuit on success in HALF_OPEN (default successThreshold=1)", () => {
    cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
    vi.advanceTimersByTime(1001);
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);

    cb.recordSuccess();
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    expect(cb.canExecute()).toBe(true);
  });

  it("requires successThreshold=2 consecutive successes before closing", () => {
    const cb2 = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 500,
      successThreshold: 2,
    });

    cb2.recordFailure(); cb2.recordFailure();
    vi.advanceTimersByTime(501);
    expect(cb2.getState()).toBe(CircuitState.HALF_OPEN);

    cb2.recordSuccess(); // 1st — still HALF_OPEN
    expect(cb2.getState()).toBe(CircuitState.HALF_OPEN);

    cb2.recordSuccess(); // 2nd — now CLOSED
    expect(cb2.getState()).toBe(CircuitState.CLOSED);
  });

  // ── HALF_OPEN → OPEN (failure path) ──────────────────────────────────────

  it("immediately reopens on any failure during HALF_OPEN probe", () => {
    cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
    vi.advanceTimersByTime(1001);
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);

    cb.recordFailure();
    expect(cb.getState()).toBe(CircuitState.OPEN);
    expect(cb.canExecute()).toBe(false);
  });

  it("resets halfOpenSuccesses counter when probe fails mid-way (successThreshold=3)", () => {
    const cb3 = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 100,
      successThreshold: 3,
    });

    cb3.recordFailure(); cb3.recordFailure();
    vi.advanceTimersByTime(101);
    expect(cb3.getState()).toBe(CircuitState.HALF_OPEN);

    cb3.recordSuccess(); // 1 of 3
    cb3.recordSuccess(); // 2 of 3
    cb3.recordFailure(); // reverts to OPEN

    expect(cb3.getState()).toBe(CircuitState.OPEN);

    // After timeout, probe again — should need all 3 successes from scratch
    vi.advanceTimersByTime(101);
    expect(cb3.getState()).toBe(CircuitState.HALF_OPEN);

    cb3.recordSuccess();
    cb3.recordSuccess();
    expect(cb3.getState()).toBe(CircuitState.HALF_OPEN); // still needs 3rd
    cb3.recordSuccess();
    expect(cb3.getState()).toBe(CircuitState.CLOSED);
  });

  // ── canExecute boundary ───────────────────────────────────────────────────

  it("canExecute is false only in OPEN state", () => {
    // CLOSED
    expect(cb.canExecute()).toBe(true);

    // OPEN
    cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
    expect(cb.canExecute()).toBe(false);

    // HALF_OPEN
    vi.advanceTimersByTime(1001);
    expect(cb.canExecute()).toBe(true);

    // Back to CLOSED
    cb.recordSuccess();
    expect(cb.canExecute()).toBe(true);
  });

  // ── Default options ──────────────────────────────────────────────────────

  it("uses defaults (failureThreshold=5, resetTimeoutMs=30 000) when no options passed", () => {
    const defaultCb = new CircuitBreaker();
    for (let i = 0; i < 4; i++) defaultCb.recordFailure();
    expect(defaultCb.getState()).toBe(CircuitState.CLOSED);

    defaultCb.recordFailure(); // 5th
    expect(defaultCb.getState()).toBe(CircuitState.OPEN);

    vi.advanceTimersByTime(29_999);
    expect(defaultCb.getState()).toBe(CircuitState.OPEN);

    vi.advanceTimersByTime(2); // just over 30 000
    expect(defaultCb.getState()).toBe(CircuitState.HALF_OPEN);
  });
});
