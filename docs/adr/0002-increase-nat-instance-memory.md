# ADR 0002: Match NAT Instance Sizing to Deployed t4g.nano

- **Status:** Accepted
- **Date:** 2026-10-04
- **Decision owner:** Steve Ziegler
- **Updates:** [ADR 0001](0001-use-stoppable-ec2-nat-instance.md)
- **Decision update:** The earlier `t4g.small` template change was not deployed; this revision aligns the template with the live instance.
- **Implementation:** Verified 2026-10-04: the stack's NAT instance is running as `t4g.nano` in `us-east-1`; the template now matches.

## Context

The NAT instance runs as `t4g.nano`, which provides 0.5 GiB of RAM. During its
first bootstrap, Amazon Linux package installation was killed by the
out-of-memory handler. Adding a 1 GiB disk-backed swap file allowed setup to
finish, and that swap configuration is part of the instance bootstrap. The
stack was inspected on 2026-10-04 and the running instance was confirmed to be
`t4g.nano`; the earlier `t4g.small` template change had not been deployed.

## Decision drivers

- Match the template to the verified running instance size.
- Keep the ARM64 instance family and existing NAT design.
- Retain the 1 GiB swap file that allowed bootstrap to complete.
- Avoid increasing running compute costs unless monitoring shows a sustained need.

## Considered options

1. **Keep `t4g.nano` with the existing 1 GiB swap file.** This matches the
   running instance and costs less; the tradeoff is 0.5 GiB of physical RAM.
2. **Use `t4g.small` with 2 GiB of memory.** This provides four times the RAM
   at higher compute cost. It was selected in the earlier template revision,
   but was not deployed.
3. **Use a larger instance.** Additional memory is not currently justified.

## Decision

Keep the ARM64 Amazon Linux 2023 `t4g.nano` instance for the EC2 NAT host and
set `InstanceType` in the template to match. Retain the persistent 1 GiB
`/swapfile` created before package installation. Reconsider a larger type if
monitoring shows recurring memory pressure or another out-of-memory event.
Keep the network interface, Elastic IP, forwarding rules, monitoring, CPU
credit mode, and NAT Gateway migration modes from ADR 0001 unchanged.

## Consequences

- The `t4g.nano` provides 0.50 GiB of RAM; the 1 GiB swap file is disk-backed
  virtual memory and does not change the instance's physical RAM size.
- Private-subnet egress is unavailable while the NAT instance is stopped.
- The NAT Gateway remains available for rollback until egress validation is
  complete and an operator selects `instance-only`.

## References

- [NAT instance runbook](../nat-instance-runbook.md)
- [ADR 0001: Use a Stoppable EC2 NAT Instance](0001-use-stoppable-ec2-nat-instance.md)
- [Amazon EC2 general purpose instance specifications](https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html)
- [Amazon EC2 On-Demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/)
