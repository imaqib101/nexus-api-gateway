import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, CircuitState } from "../src/circuitBreaker";

describe("CircuitBreaker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts closed and allows execution", () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    expect(cb.canExecute()).toBe(true);
  });

  it("opens once the failure threshold is reached", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    cb.recordFailure();
    expect(cb.getState()).toBe(CircuitState.OPEN);
    expect(cb.canExecute()).toBe(false);
  });

  it("a success resets the failure count", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it("moves to half-open after the reset timeout and allows a probe", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
    cb.recordFailure();
    vi.advanceTimersByTime(500);
    expect(cb.getState()).toBe(CircuitState.OPEN);
    vi.advanceTimersByTime(600);
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
    expect(cb.canExecute()).toBe(true);
  });

  it("closes again when the half-open probe succeeds", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
    cb.recordFailure();
    vi.advanceTimersByTime(1001);
    cb.recordSuccess();
    expect(cb.getState()).toBe(CircuitState.CLOSED);
  });

  it("re-opens when the half-open probe fails", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
    cb.recordFailure();
    vi.advanceTimersByTime(1001);
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
    cb.recordFailure();
    expect(cb.getState()).toBe(CircuitState.OPEN);
    expect(cb.canExecute()).toBe(false);
  });
});
