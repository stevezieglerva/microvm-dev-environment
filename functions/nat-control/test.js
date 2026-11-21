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
process.env.AGENTCORE_JOB_LEASES_PATH = '/ipad-claude/agentcore/jobs/';
function fakeClients(instance = 'running', pages = [], calls = [], managed = true, leasePages = []) {
  const ec2 = { send: async command => {
    calls.push(command.constructor.name);
    if (command.constructor.name === 'DescribeRouteTablesCommand') return { RouteTables: [{ Routes: managed ? [{ DestinationCidrBlock: '0.0.0.0/0', InstanceId: 'i-nat' }] : [] }] };
    if (command.constructor.name === 'DescribeInstancesCommand') return { Reservations: [{ Instances: [{ State: { Name: instance } }] }] };
    if (command.constructor.name === 'DescribeInstanceStatusCommand') return { InstanceStatuses: [{ InstanceStatus: { Status: 'ok' }, SystemStatus: { Status: 'ok' } }] };
    return {};
  } };
  let page = 0;
  let leasePage = 0;
  const ssm = { send: async command => {
    calls.push(command.constructor.name);
    if (command.constructor.name === 'GetParameterCommand') return { Parameter: { Value: '' } };
    if (command.constructor.name === 'GetParametersByPathCommand') {
      return command.input.Path === process.env.AGENTCORE_JOB_LEASES_PATH
        ? leasePages[leasePage++] || { Parameters: [] }
        : pages[page++] || { Parameters: [] };
    }
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
  assert.equal(idleCalls.filter(call => call === 'GetParametersByPathCommand').length, 3);
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

  const leaseCalls = [];
  const leased = fakeClients('running', [], leaseCalls, true, [{ Parameters: [{ Name: '/ipad-claude/agentcore/jobs/job-12345678', Value: JSON.stringify({ expiresAt: Date.now() + 60000 }) }] }]);
  assert.equal((await controller.reconcile({ ec2Client: leased.ec2, ssmClient: leased.ssm, now: Date.now() })).status, 'agentcore-active');
  assert.equal(leaseCalls.includes('StopInstancesCommand'), false);

  const startLeaseCalls = [];
  const startLease = fakeClients('stopped', [], startLeaseCalls);
  assert.equal((await controller.acquireAgentCoreLease('job-12345678', { ec2Client: startLease.ec2, ssmClient: startLease.ssm })).status, 'pending');
  assert.equal(startLeaseCalls.indexOf('PutParameterCommand') < startLeaseCalls.indexOf('StartInstancesCommand'), true);

  const deadline = Date.now() + 3600000;
  const lease = JSON.parse(controller.leaseValue(Date.now(), deadline));
  assert.equal(lease.hardDeadlineAt, deadline);
  assert.equal(lease.expiresAt, deadline + 900000);
  let renewedValue = '';
  const renewAt = Date.now();
  const renewLeaseClient = { send: async command => {
    if (command.constructor.name === 'GetParameterCommand') return { Parameter: { Value: JSON.stringify({ hardDeadlineAt: renewAt + 10000, expiresAt: renewAt + 910000 }) } };
    if (command.constructor.name === 'PutParameterCommand') renewedValue = command.input.Value;
    return {};
  } };
  assert.equal((await controller.renewAgentCoreLease('job-12345678', { ssmClient: renewLeaseClient, now: renewAt })).status, 'renewed');
  assert.equal(JSON.parse(renewedValue).expiresAt, renewAt + 910000);
  const ready = fakeClients('running');
  assert.equal((await controller.waitForAgentCoreNat({ ec2Client: ready.ec2, ssmClient: { send: async () => ({ Parameter: { Value: 'lease' } }) }, jobId: 'job-12345678' })).status, 'ready');

  const restartCalls = [];
  const stoppedDuringLease = fakeClients('stopped', [], restartCalls);
  const waitingForRestart = await controller.waitForAgentCoreNat({
    ec2Client: stoppedDuringLease.ec2,
    ssmClient: { send: async () => ({ Parameter: { Value: 'lease' } }) },
    jobId: 'job-12345678',
  });
  assert.equal(waitingForRestart.status, 'waiting');
  assert.equal(restartCalls.includes('StartInstancesCommand'), true);

  const nightlyCalls = [];
  const nightly = fakeClients('running', [], nightlyCalls, true, [{ Parameters: [{ Name: '/ipad-claude/agentcore/jobs/job-12345678', Value: JSON.stringify({ expiresAt: Date.now() + 60000 }) }] }]);
  const nightlyResult = await controller.nightlyShutdown({ ec2Client: nightly.ec2, ssmClient: nightly.ssm, stateFn: async () => 'SUSPENDED' });
  assert.equal(nightlyResult.status, 'nightly-shutdown-deferred');
  assert.equal(nightlyCalls.includes('StopInstancesCommand'), false);
  const grace = fakeClients('running');
  const recent = new Date().toISOString();
  grace.ssm.send = async command => command.constructor.name === 'GetParameterCommand'
    ? { Parameter: { Value: recent } } : { RouteTables: [{ Routes: [] }] };
  assert.equal((await controller.reconcile({ ec2Client: grace.ec2, ssmClient: grace.ssm, now: Date.now() })).status, 'grace');
  console.log('NAT controller behavior tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
