# ADR 0002: Increase NAT Instance Memory to 2 GiB

- **Status:** Accepted
- **Date:** 2026-10-04
- **Decision owner:** Steve Ziegler
- **Supersedes:** The NAT instance size selected in [ADR 0001](0001-use-stoppable-ec2-nat-instance.md)
- **Implementation:** Template updated; the live instance remains `t4g.nano` until a stack deployment.

## Context

The NAT instance initially used `t4g.nano`, which provides 0.5 GiB of memory.
During its first bootstrap, Amazon Linux package installation was killed by
the out-of-memory handler. Adding a 1 GiB disk-backed swap file allowed setup
to finish, and that swap configuration is now part of the instance bootstrap.
Swap helps absorb short peaks, but the NAT host still has little RAM headroom
for package updates, SSM, CloudWatch Agent, conntrack, and traffic forwarding.

## Decision drivers

- Give bootstrap and normal NAT operations more memory headroom.
- Keep the ARM64 instance family and existing NAT design.
- Keep the 1 GiB swap file as additional protection against temporary memory
  pressure.
- Keep the recurring cost increase proportional to the time the instance runs.

## Considered options

1. **Keep `t4g.nano` and rely on swap.** This has the lowest compute cost, but
   the initial out-of-memory failure showed limited headroom.
2. **Use `t4g.small` with 2 GiB of memory.** This increases compute cost while
   providing four times the RAM. This is the selected option.
3. **Use a larger instance.** Additional memory is unnecessary for the current
   NAT workload.

## Decision

Use an ARM64 Amazon Linux 2023 `t4g.small` instance for the EC2 NAT host. Retain
the persistent 1 GiB `/swapfile` created before package installation. Keep the
network interface, Elastic IP, forwarding rules, monitoring, CPU credit mode,
and NAT Gateway migration modes from ADR 0001 unchanged.

## Consequences

- The `t4g.small` provides 2.00 GiB of memory; `t4g.nano` provides 0.50 GiB.
- Using us-east-1 Linux On-Demand rates of approximately $0.0168/hour for
  `t4g.small` and $0.0042/hour for `t4g.nano`, the compute increase is about
  $0.0126/hour: roughly $4.60/month at 12 hours per day or $9.20/month if
  continuously running. This excludes EBS, Elastic IP, monitoring, data
  transfer, and NAT processing charges. If the instance runs only one hour per
  week, the compute increase is about $0.05/month, but private egress is
  unavailable whenever the NAT instance is stopped.
- Updating the live stack to this size remains a separate deployment; schedule
  it when a brief interruption to private egress is acceptable.
- The NAT Gateway remains available for rollback until the separate egress
  soak and validation are complete.

## References

- [NAT instance runbook](../nat-instance-runbook.md)
- [ADR 0001: Use a Stoppable EC2 NAT Instance](0001-use-stoppable-ec2-nat-instance.md)
- [Amazon EC2 general purpose instance specifications](https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html)
- [Amazon EC2 On-Demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/)
