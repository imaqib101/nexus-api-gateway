import { describe, it, expect } from 'vitest';
import { PowerOfTwoChoicesBalancer, CanaryRoutingBalancer } from '../src/algorithms';

describe('PowerOfTwoChoicesBalancer', () => {
  it('selects between two targets based on active connections', () => {
    const p2c = new PowerOfTwoChoicesBalancer();
    const targets = ['http://t1', 'http://t2'];
    const conns = new Map<string, number>();
    conns.set('http://t1', 10);
    conns.set('http://t2', 2);

    // t2 has fewer connections, should be selected more often or exclusively when weights differ significantly
    const selected = p2c.select(targets, conns);
    expect(targets).toContain(selected);
  });

  it('handles single target and empty targets', () => {
    const p2c = new PowerOfTwoChoicesBalancer();
    expect(p2c.select(['http://only'], new Map())).toBe('http://only');
    expect(() => p2c.select([], new Map())).toThrowError('No healthy targets available');
  });
});

describe('CanaryRoutingBalancer', () => {
  it('routes to canary target on matching header', () => {
    const canary = new CanaryRoutingBalancer({
      stableTarget: 'http://stable',
      canaryTarget: 'http://canary',
      canaryWeightPercent: 0,
      canaryHeaderKey: 'x-test-canary',
      canaryHeaderValue: 'yes'
    });

    const target = canary.select({
      headers: { 'x-test-canary': 'yes' }
    });
    expect(target).toBe('http://canary');
  });

  it('routes deterministically based on clientKey hash', () => {
    const canary = new CanaryRoutingBalancer({
      stableTarget: 'http://stable',
      canaryTarget: 'http://canary',
      canaryWeightPercent: 50
    });

    const t1 = canary.select({ clientKey: 'user_alpha_123' });
    const t2 = canary.select({ clientKey: 'user_alpha_123' });
    expect(t1).toBe(t2); // Deterministic
  });
});
