/**
 * Resilient Circuit Breaker for Nexus API Gateway proxy routing
 */
export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private lastStateChange = Date.now();

  constructor(
    private options: CircuitBreakerOptions = { failureThreshold: 5, resetTimeoutMs: 30000 },
  ) {}

  getState(): CircuitState {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastStateChange > this.options.resetTimeoutMs) {
        this.state = CircuitState.HALF_OPEN;
        this.lastStateChange = Date.now();
      }
    }
    return this.state;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = CircuitState.CLOSED;
    this.lastStateChange = Date.now();
  }

  recordFailure(): void {
    this.failures++;
    if (this.failures >= this.options.failureThreshold) {
      this.state = CircuitState.OPEN;
      this.lastStateChange = Date.now();
    }
  }

  canExecute(): boolean {
    const current = this.getState();
    return current === CircuitState.CLOSED || current === CircuitState.HALF_OPEN;
  }
}
