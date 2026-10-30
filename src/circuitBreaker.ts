/**
 * Resilient Circuit Breaker for Nexus API Gateway proxy routing
 *
 * State machine:
 *   CLOSED    → normal operation; failures accumulate
 *   OPEN      → fast-fail; transitions to HALF_OPEN after resetTimeoutMs
 *   HALF_OPEN → probe mode; requires `successThreshold` consecutive successes
 *               before closing; any failure reopens immediately
 */
export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export interface CircuitBreakerOptions {
  /** Number of consecutive failures to trip the breaker (default: 5) */
  failureThreshold: number;
  /** Milliseconds to wait in OPEN before probing (default: 30 000) */
  resetTimeoutMs: number;
  /**
   * Consecutive successes required in HALF_OPEN to fully close the circuit.
   * Default: 1 (original behaviour).  Set to ≥ 2 for extra probe confidence.
   */
  successThreshold?: number;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private halfOpenSuccesses = 0;
  private lastStateChange = Date.now();

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly successThreshold: number;

  constructor(options: CircuitBreakerOptions = { failureThreshold: 5, resetTimeoutMs: 30_000 }) {
    this.failureThreshold = options.failureThreshold;
    this.resetTimeoutMs   = options.resetTimeoutMs;
    this.successThreshold = options.successThreshold ?? 1;
  }

  getState(): CircuitState {
    if (
      this.state === CircuitState.OPEN &&
      Date.now() - this.lastStateChange > this.resetTimeoutMs
    ) {
      this.state = CircuitState.HALF_OPEN;
      this.halfOpenSuccesses = 0;
      this.lastStateChange = Date.now();
    }
    return this.state;
  }

  recordSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.successThreshold) {
        this.failures = 0;
        this.halfOpenSuccesses = 0;
        this.state = CircuitState.CLOSED;
        this.lastStateChange = Date.now();
      }
      // Stay in HALF_OPEN until successThreshold is reached
    } else {
      // CLOSED: success resets the failure counter
      this.failures = 0;
    }
  }

  recordFailure(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in probe mode trips the circuit immediately
      this.halfOpenSuccesses = 0;
      this.state = CircuitState.OPEN;
      this.lastStateChange = Date.now();
      return;
    }

    this.failures++;
    if (this.failures >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
      this.lastStateChange = Date.now();
    }
  }

  canExecute(): boolean {
    const current = this.getState();
    return current === CircuitState.CLOSED || current === CircuitState.HALF_OPEN;
  }
}
