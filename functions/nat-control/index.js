let ec2Sdk;
let ssmSdk;
try {
  ec2Sdk = require('@aws-sdk/client-ec2');
  ssmSdk = require('@aws-sdk/client-ssm');
} catch (error) {
  class Client { async send() { throw error; } }
  const command = name => ({ [name]: class { constructor(input) { this.input = input; } } })[name];
  ec2Sdk = { EC2Client: Client, DescribeRouteTablesCommand: command('DescribeRouteTablesCommand'), DescribeInstancesCommand: command('DescribeInstancesCommand'), DescribeInstanceStatusCommand: command('DescribeInstanceStatusCommand'), StartInstancesCommand: command('StartInstancesCommand'), StopInstancesCommand: command('StopInstancesCommand') };
  ssmSdk = { SSMClient: Client, GetParameterCommand: command('GetParameterCommand'), PutParameterCommand: command('PutParameterCommand'), DeleteParameterCommand: command('DeleteParameterCommand'), GetParametersByPathCommand: command('GetParametersByPathCommand') };
}
const { EC2Client, DescribeRouteTablesCommand, DescribeInstancesCommand, DescribeInstanceStatusCommand, StartInstancesCommand, StopInstancesCommand } = ec2Sdk;
const { SSMClient, GetParameterCommand, PutParameterCommand, DeleteParameterCommand, GetParametersByPathCommand } = ssmSdk;
const { state: microvmState, terminate: terminateMicrovm } = require('./microvm');
const { routeUsesNatFromRoutes, sessionIsActive, sessionsAreIdle } = require('./decisions');

const ec2 = new EC2Client({ maxAttempts: 3 });
const ssm = new SSMClient({ maxAttempts: 3 });
const graceMs = 5 * 60 * 1000;
const agentCoreJobCapMs = 60 * 60 * 1000;
const agentCoreStartupCapMs = 12 * 60 * 1000;
const agentCoreCleanupGraceMs = 15 * 60 * 1000;
const retryable = message => ({ status: 'retryable', message });

async function routeUsesNat(client = ec2) {
  const result = await client.send(new DescribeRouteTablesCommand({ RouteTableIds: [process.env.PRIVATE_ROUTE_TABLE_ID] }));
  const routes = result.RouteTables?.[0]?.Routes || [];
  return routeUsesNatFromRoutes(routes, process.env.NAT_INSTANCE_ID);
}

async function instanceState(client = ec2) {
  const result = await client.send(new DescribeInstancesCommand({ InstanceIds: [process.env.NAT_INSTANCE_ID] }));
  return result.Reservations?.[0]?.Instances?.[0]?.State?.Name || 'unknown';
}

async function ensureRunning({ ec2Client = ec2, ssmClient = ssm } = {}) {
  if (!(await routeUsesNat(ec2Client))) return { status: 'unmanaged' };
  const current = await instanceState(ec2Client);
  if (current === 'running') {
    await ssmClient.send(new PutParameterCommand({ Name: process.env.STARTED_AT_PARAMETER, Value: new Date().toISOString(), Type: 'String', Overwrite: true }));
    return { status: 'acknowledged', state: current };
  }
  if (current === 'pending') {
    await ssmClient.send(new PutParameterCommand({ Name: process.env.STARTED_AT_PARAMETER, Value: new Date().toISOString(), Type: 'String', Overwrite: true }));
    return { status: 'acknowledged', state: current };
  }
  if (current === 'stopped') {
    await ec2Client.send(new StartInstancesCommand({ InstanceIds: [process.env.NAT_INSTANCE_ID] }));
    await ssmClient.send(new PutParameterCommand({ Name: process.env.STARTED_AT_PARAMETER, Value: new Date().toISOString(), Type: 'String', Overwrite: true }));
    return { status: 'acknowledged', state: 'pending' };
  }
  if (current === 'stopping') return retryable('NAT instance is stopping');
  return { status: 'failed', message: `NAT instance state is ${current}` };
}

async function parameter(name, client = ssm) {
  try { return (await client.send(new GetParameterCommand({ Name: name }))).Parameter?.Value || ''; }
  catch (error) { if (error.name === 'ParameterNotFound') return ''; throw error; }
}

function agentCoreLeaseName(jobId) {
  return `${process.env.AGENTCORE_JOB_LEASES_PATH || '/ipad-claude/agentcore/jobs/'}${jobId}`;
}

function parseLeaseExpiry(value) {
  try {
    const lease = JSON.parse(value);
    return Number.isFinite(lease.expiresAt) ? lease.expiresAt : null;
  } catch {
    return null;
  }
}

async function activeAgentCoreLeaseCount({ ssmClient = ssm, now = Date.now() } = {}) {
  const path = process.env.AGENTCORE_JOB_LEASES_PATH || '/ipad-claude/agentcore/jobs/';
  let token;
  let active = 0;
  do {
    const page = await ssmClient.send(new GetParametersByPathCommand({ Path: path, Recursive: true, NextToken: token }));
    for (const item of page.Parameters || []) {
      const expiresAt = parseLeaseExpiry(item.Value || '');
      if (expiresAt === null || expiresAt > now) active++;
      else await ssmClient.send(new DeleteParameterCommand({ Name: item.Name }));
    }
    token = page.NextToken;
  } while (token);
  return active;
}

function leaseValue(now, deadlineAt) {
  const hardDeadline = Number.isFinite(deadlineAt) && deadlineAt > now && deadlineAt <= now + agentCoreStartupCapMs + agentCoreJobCapMs
    ? deadlineAt
    : now + agentCoreStartupCapMs + agentCoreJobCapMs;
  return JSON.stringify({ hardDeadlineAt: hardDeadline, expiresAt: hardDeadline + agentCoreCleanupGraceMs });
}

async function acquireAgentCoreLease(jobId, { ec2Client = ec2, ssmClient = ssm, now = Date.now(), deadlineAt } = {}) {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(jobId || '')) return { status: 'failed', message: 'invalid job id' };
  const name = agentCoreLeaseName(jobId);
  const value = leaseValue(now, deadlineAt);
  await ssmClient.send(new PutParameterCommand({ Name: name, Value: value, Type: 'String', Overwrite: true }));
  try {
    const result = await ensureRunning({ ec2Client, ssmClient });
    if (['unmanaged', 'failed'].includes(result.status)) throw new Error(result.message || result.status);
    return { status: result.status === 'acknowledged' ? result.state : result.status, leaseName: name };
  } catch (error) {
    await ssmClient.send(new DeleteParameterCommand({ Name: name }));
    throw error;
  }
}

async function renewAgentCoreLease(jobId, { ssmClient = ssm, now = Date.now() } = {}) {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(jobId || '')) return { status: 'failed', message: 'invalid job id' };
  const name = agentCoreLeaseName(jobId);
  const current = await parameter(name, ssmClient);
  if (!current) return { status: 'not-found' };
  let lease;
  try { lease = JSON.parse(current); } catch { return { status: 'failed', message: 'invalid lease value' }; }
  if (!Number.isFinite(lease.hardDeadlineAt) || lease.hardDeadlineAt <= now) return { status: 'expired' };
  const value = JSON.stringify({
    hardDeadlineAt: lease.hardDeadlineAt,
    expiresAt: lease.hardDeadlineAt + agentCoreCleanupGraceMs,
  });
  await ssmClient.send(new PutParameterCommand({ Name: name, Value: value, Type: 'String', Overwrite: true }));
  return { status: 'renewed' };
}

async function waitForAgentCoreNat({ ec2Client = ec2, ssmClient = ssm, jobId, deadlineAt, now = Date.now() } = {}) {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(jobId || '')) return { status: 'failed', message: 'invalid job id' };
  if (!(await parameter(agentCoreLeaseName(jobId), ssmClient))) return { status: 'failed', message: 'AgentCore job lease is missing' };
  if (Number.isFinite(deadlineAt) && now >= deadlineAt) return { status: 'expired' };
  const state = await instanceState(ec2Client);
  if (state === 'stopped') {
    const result = await ensureRunning({ ec2Client, ssmClient });
    return result.status === 'acknowledged' ? { status: 'waiting' } : result;
  }
  if (state !== 'running') return ['pending', 'stopping'].includes(state) ? { status: 'waiting' } : retryable(`NAT instance is ${state}`);
  const result = await ec2Client.send(new DescribeInstanceStatusCommand({ InstanceIds: [process.env.NAT_INSTANCE_ID], IncludeAllInstances: true }));
  const status = result.InstanceStatuses?.[0];
  return status?.InstanceStatus?.Status === 'ok' && status?.SystemStatus?.Status === 'ok'
    ? { status: 'ready' }
    : { status: 'waiting' };
}

async function releaseAgentCoreLease(jobId, { ssmClient = ssm } = {}) {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(jobId || '')) return { status: 'failed', message: 'invalid job id' };
  try { await ssmClient.send(new DeleteParameterCommand({ Name: agentCoreLeaseName(jobId) })); }
  catch (error) { if (error.name !== 'ParameterNotFound') throw error; }
  return { status: 'released' };
}

async function trackedIds(client = ssm) {
  const ids = [];
  let token;
  do {
    const page = await client.send(new GetParametersByPathCommand({ Path: '/ipad-claude/users/', Recursive: true, NextToken: token }));
    for (const item of page.Parameters || []) {
      if (item.Name.endsWith('/mvm-identifier') && item.Value && item.Value !== '-') ids.push(item.Value);
    }
    token = page.NextToken;
  } while (token);
  return ids;
}

async function reconcile({ ec2Client = ec2, ssmClient = ssm, stateFn = microvmState, now = Date.now() } = {}) {
  if (!(await routeUsesNat(ec2Client))) return { status: 'unmanaged' };
  const started = await parameter(process.env.STARTED_AT_PARAMETER, ssmClient);
  if (started && now - Date.parse(started) < graceMs) return { status: 'grace' };
  let agentCoreJobs;
  try { agentCoreJobs = await activeAgentCoreLeaseCount({ ssmClient, now }); }
  catch (error) { console.error('AgentCore lease check failed', error.message); return retryable('AgentCore lease state is unavailable'); }
  if (agentCoreJobs > 0) return { status: 'agentcore-active', jobs: agentCoreJobs };
  const ids = await trackedIds(ssmClient);
  const states = [];
  let allIdle = true;
  for (const id of ids) {
    try {
      const current = await stateFn(id);
      states.push(current);
      if (sessionIsActive(current)) allIdle = false;
    } catch (error) { allIdle = false; console.error('MicroVM state check failed', id, error.message); }
  }
  allIdle = allIdle && sessionsAreIdle(states);
  if (!allIdle) return { status: 'active', sessions: ids.length };
  const current = await instanceState(ec2Client);
  if (current === 'stopped') return { status: 'already-stopped', sessions: ids.length };
  if (current === 'stopping' || current === 'pending') return retryable(`NAT instance is ${current}`);
  if (current !== 'running') return { status: 'failed', message: `NAT instance state is ${current}` };
  await ec2Client.send(new StopInstancesCommand({ InstanceIds: [process.env.NAT_INSTANCE_ID] }));
  console.log(`Stopped NAT instance after ${ids.length} idle session(s)`);
  return { status: 'stopped', sessions: ids.length };
}

async function nightlyShutdown({ ec2Client = ec2, ssmClient = ssm, stateFn = microvmState, terminateFn = terminateMicrovm } = {}) {
  const ids = await trackedIds(ssmClient);
  const results = [];
  for (const id of ids) {
    try {
      const state = await stateFn(id);
      if (state === 'TERMINATED' || state === 'NOT_FOUND') results.push({ id, status: 'already-terminated' });
      else if (state === 'TERMINATING') results.push({ id, status: 'termination-in-progress' });
      else {
        await terminateFn(id);
        results.push({ id, status: 'termination-requested' });
      }
    } catch (error) {
      results.push({ id, status: 'termination-failed', error: error.message });
      console.error('Nightly MicroVM termination failed', id, error.message);
    }
  }
  const agentCoreJobs = await activeAgentCoreLeaseCount({ ssmClient });
  if (agentCoreJobs > 0) {
    console.log(`Nightly shutdown left NAT running for ${agentCoreJobs} AgentCore job lease(s)`);
    return { status: 'nightly-shutdown-deferred', microvms: results, agentCoreJobs, nat: await instanceState(ec2Client) };
  }
  const current = await instanceState(ec2Client);
  if (current === 'running' || current === 'pending') await ec2Client.send(new StopInstancesCommand({ InstanceIds: [process.env.NAT_INSTANCE_ID] }));
  const natStatus = current === 'running' || current === 'pending' ? 'stopping' : current;
  console.log('Nightly shutdown requested', JSON.stringify({ microvms: results, nat: natStatus }));
  if (results.some(result => result.status === 'termination-failed')) throw new Error('One or more MicroVM terminations failed; Scheduler will retry');
  return { status: 'nightly-shutdown-requested', microvms: results, nat: natStatus };
}

function isTenPmEastern(scheduledAt) {
  const date = scheduledAt ? new Date(scheduledAt) : new Date();
  const hour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(date);
  return hour === '22';
}

exports.handler = async event => {
  console.log('NAT control request', JSON.stringify(event));
  if (event.action === 'ensure-running') return ensureRunning();
  if (event.action === 'acquire-agentcore-lease') return acquireAgentCoreLease(event.jobId);
  if (event.action === 'renew-agentcore-lease') return renewAgentCoreLease(event.jobId);
  if (event.action === 'release-agentcore-lease') return releaseAgentCoreLease(event.jobId);
  if (event.action === 'wait-agentcore-nat') return waitForAgentCoreNat(event);
  if (event.action === 'nightly-shutdown') {
    if (!isTenPmEastern(event.scheduledAt)) return { status: 'skipped-outside-10pm-eastern' };
    return nightlyShutdown();
  }
  return reconcile();
};
exports._test = { routeUsesNat, ensureRunning, acquireAgentCoreLease, renewAgentCoreLease, releaseAgentCoreLease, waitForAgentCoreNat, activeAgentCoreLeaseCount, reconcile, nightlyShutdown, trackedIds, leaseValue };
