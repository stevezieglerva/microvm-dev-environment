const assert = require('assert/strict');
const { routeUsesNatFromRoutes, sessionIsActive, sessionsAreIdle } = require('./decisions');
const controller = require('./index')._test;

assert.equal(routeUsesNatFromRoutes([{ DestinationCidrBlock: '0.0.0.0/0', InstanceId: 'i-nat' }], 'i-nat'), true);
assert.equal(routeUsesNatFromRoutes([{ DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-gateway' }], 'i-nat'), false);
assert.equal(sessionIsActive('RUNNING'), true);
assert.equal(sessionIsActive('STARTING'), true);
assert.equal(sessionIsActive('UNKNOWN'), true);
assert.equal(sessionIsActive('NOT_FOUND'), true);
assert.equal(sessionIsActive('SUSPENDED'), false);
assert.equal(sessionIsActive('TERMINATED'), false);
assert.equal(sessionsAreIdle([]), true);
assert.equal(sessionsAreIdle(['SUSPENDED', 'TERMINATED']), true);
assert.equal(sessionsAreIdle(['SUSPENDED', 'STARTING']), false);

process.env.NAT_INSTANCE_ID = 'i-nat';
process.env.PRIVATE_ROUTE_TABLE_ID = 'rt-private';
process.env.STARTED_AT_PARAMETER = '/ipad-claude/nat/started-at';
function fakeClients(instance = 'running', pages = [], calls = [], managed = true) {
  const ec2 = { send: async command => {
    calls.push(command.constructor.name);
    if (command.constructor.name === 'DescribeRouteTablesCommand') return { RouteTables: [{ Routes: managed ? [{ DestinationCidrBlock: '0.0.0.0/0', InstanceId: 'i-nat' }] : [] }] };
    if (command.constructor.name === 'DescribeInstancesCommand') return { Reservations: [{ Instances: [{ State: { Name: instance } }] }] };
    return {};
  } };
  let page = 0;
  const ssm = { send: async command => {
    calls.push(command.constructor.name);
    if (command.constructor.name === 'GetParameterCommand') return { Parameter: { Value: '' } };
    if (command.constructor.name === 'GetParametersByPathCommand') return pages[page++] || { Parameters: [] };
    return {};
  } };
  return { ec2, ssm };
}

(async () => {
  const startCalls = [];
  const start = fakeClients('stopped', [], startCalls);
  assert.deepEqual((await controller.ensureRunning({ ec2Client: start.ec2, ssmClient: start.ssm })).status, 'acknowledged');
  assert.equal(startCalls.includes('StartInstancesCommand'), true);
  assert.equal(startCalls.includes('PutParameterCommand'), true);

  const unmanaged = fakeClients('running', [], [], false);
  assert.equal((await controller.ensureRunning({ ec2Client: unmanaged.ec2, ssmClient: unmanaged.ssm })).status, 'unmanaged');
  assert.equal((await controller.reconcile({ ec2Client: unmanaged.ec2, ssmClient: unmanaged.ssm })).status, 'unmanaged');

  const idleCalls = [];
  const idle = fakeClients('running', [
    { Parameters: [{ Name: '/ipad-claude/users/a/mvm-identifier', Value: 'm-a' }], NextToken: 'next' },
    { Parameters: [{ Name: '/ipad-claude/users/b/mvm-identifier', Value: 'm-b' }] },
  ], idleCalls);
  const idleResult = await controller.reconcile({ ec2Client: idle.ec2, ssmClient: idle.ssm, stateFn: async id => id === 'm-a' ? 'SUSPENDED' : 'TERMINATED', now: Date.now() + 3600000 });
  assert.equal(idleResult.status, 'stopped');
  assert.equal(idleCalls.filter(call => call === 'GetParametersByPathCommand').length, 2);
  assert.equal(idleCalls.indexOf('DescribeInstancesCommand') < idleCalls.indexOf('StopInstancesCommand'), true);

  for (const state of ['stopped', 'stopping', 'pending']) {
    const calls = [];
    const current = fakeClients(state, [], calls);
    const result = await controller.reconcile({ ec2Client: current.ec2, ssmClient: current.ssm, now: Date.now() + 3600000 });
    assert.equal(result.status, state === 'stopped' ? 'already-stopped' : 'retryable');
    assert.equal(calls.includes('StopInstancesCommand'), false);
  }

  const uncertain = fakeClients('running', [{ Parameters: [{ Name: '/ipad-claude/users/a/mvm-identifier', Value: 'm-a' }] }]);
  assert.equal((await controller.reconcile({ ec2Client: uncertain.ec2, ssmClient: uncertain.ssm, stateFn: async () => 'UNKNOWN', now: Date.now() + 3600000 })).status, 'active');
  const failed = fakeClients('running', [{ Parameters: [{ Name: '/ipad-claude/users/a/mvm-identifier', Value: 'm-a' }] }]);
  assert.equal((await controller.reconcile({ ec2Client: failed.ec2, ssmClient: failed.ssm, stateFn: async () => { throw new Error('temporary API failure'); }, now: Date.now() + 3600000 })).status, 'active');
  const grace = fakeClients('running');
  const recent = new Date().toISOString();
  grace.ssm.send = async command => command.constructor.name === 'GetParameterCommand'
    ? { Parameter: { Value: recent } } : { RouteTables: [{ Routes: [] }] };
  assert.equal((await controller.reconcile({ ec2Client: grace.ec2, ssmClient: grace.ssm, now: Date.now() })).status, 'grace');
  console.log('NAT controller behavior tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
