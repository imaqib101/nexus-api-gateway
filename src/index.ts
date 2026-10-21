export interface RouteRule {
  pathPrefix: string;
  targets: string[];
  strategy: 'round-robin' | 'least-connections';
}

export class NexusGateway {
  private routes: RouteRule[] = [];
  private counters: Map<string, number> = new Map();

  addRoute(rule: RouteRule) {
    this.routes.push(rule);
    this.counters.set(rule.pathPrefix, 0);
  }

  routeRequest(path: string): string {
    const route = this.routes.find(r => path.startsWith(r.pathPrefix));
    if (!route || route.targets.length === 0) {
      throw new Error(`No route found for path: ${path}`);
    }

    if (route.strategy === 'round-robin') {
      const idx = this.counters.get(route.pathPrefix)!;
      const target = route.targets[idx % route.targets.length];
      this.counters.set(route.pathPrefix, idx + 1);
      return target;
    }

    return route.targets[0];
  }
}
