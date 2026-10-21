import { strict as assert } from 'assert';
import { NexusGateway } from '../src/index.js';

async function runTests() {
  const gateway = new NexusGateway();
  gateway.addRoute({
    pathPrefix: '/api/v1',
    targets: ['http://backend-1:8080', 'http://backend-2:8080'],
    strategy: 'round-robin'
  });

  assert.equal(gateway.routeRequest('/api/v1/users'), 'http://backend-1:8080');
  assert.equal(gateway.routeRequest('/api/v1/users'), 'http://backend-2:8080');
  console.log('Nexus Gateway round-robin routing tests passed!');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
