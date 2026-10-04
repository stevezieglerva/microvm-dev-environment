# ADR 0003: Remove the Managed NAT Gateway

- **Status:** Accepted
- **Date:** 2026-10-04
- **Decision owner:** Steve Ziegler
- **Updates:** [ADR 0001](0001-use-stoppable-ec2-nat-instance.md), [ADR 0002](0002-increase-nat-instance-memory.md)
- **Issue:** [#8](https://github.com/stevezieglerva/microvm-dev-environment/issues/8)

## Context

The private route table already sends both private subnets through the EC2 NAT
instance. On 2026-10-04, egress validation passed from both private subnets and
the real MicroVM connector, including AWS and Bedrock access, package and Git
access, AgentCore web search, and the S3 Files mount. At the time of this
decision, the managed NAT Gateway remained provisioned but was not on the
active route, so it continued to incur charges without serving traffic.

## Decision

Remove the `AWS::EC2::NatGateway` and its dedicated Elastic IP from the
CloudFormation template. Route private-subnet egress directly through the EC2
NAT instance. Remove the `NatMode` parameter and the staged gateway migration
controls from the deploy script; NAT lifecycle automation remains enabled.

The 2026-10-04 stack deployment applied this change and deleted the managed NAT
Gateway and its Elastic IP. Both private subnets still route through the EC2
instance, and a post-update MicroVM probe returned the instance's Elastic IP.
This repository no longer provides an infrastructure-managed gateway rollback
path.

## Consequences

- The template and live topology no longer retain the unused managed gateway.
- Routine deployments no longer need to carry or validate a NAT rollout mode.
- If the EC2 NAT instance is unavailable, private-subnet egress is unavailable
  until the instance is recovered. Restoring a managed gateway requires a
  separate infrastructure change.

## References

- [NAT instance runbook](../nat-instance-runbook.md)
- [ADR 0001: Use a Stoppable EC2 NAT Instance](0001-use-stoppable-ec2-nat-instance.md)
- [ADR 0002: Match NAT Instance Sizing to Deployed t4g.nano](0002-increase-nat-instance-memory.md)
