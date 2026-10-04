# ADR 0001: Use a Stoppable EC2 NAT Instance

- **Status:** Accepted
- **Date:** 2026-10-04
- **Decision owner:** Steve Ziegler
- **Issue:** [#8](https://github.com/stevezieglerva/microvm-dev-environment/issues/8)
- **Implementation:** [PR #9](https://github.com/stevezieglerva/microvm-dev-environment/pull/9) (merged); the unused managed gateway was removed in the 2026-10-04 stack update recorded in [ADR 0003](0003-remove-managed-nat-gateway.md). The live route targets the EC2 NAT instance.
- **Sizing confirmation:** [ADR 0002](0002-increase-nat-instance-memory.md) records the deployed `t4g.nano` size and retained 1 GiB swap file.

## Context

The stack sends both private subnets' internet traffic through one NAT Gateway
in `PublicSubnet1`. This single-user development environment uses that path for
package and Git access, AWS and Bedrock APIs, AgentCore web search, and the S3
Files mount. The managed gateway remains billed while the environment is idle.

An EC2 NAT instance can be stopped when no MicroVM work is active. It lowers
compute cost, but makes private-subnet egress depend on the instance being
running and healthy. The second private subnet also continues to depend on a
NAT instance in the first subnet's Availability Zone.

## Decision drivers

- Reduce recurring egress cost during idle hours.
- Keep the existing private-subnet routes and outbound capabilities.
- Retain a safe migration path and a quick route rollback during validation.
- Keep administration keyless through Systems Manager Session Manager.
- Accept manual start and stop operations for this single-user stack.

## Considered options

1. **Keep the NAT Gateway.** This preserves the managed service and current
   behavior, but continues to incur its hourly charge while idle.
2. **Use one stoppable EC2 NAT instance.** This reduces compute charges when
   stopped and is the selected option. It adds host maintenance and makes
   egress unavailable whenever the instance is stopped or unhealthy.
3. **Use a NAT Gateway in each Availability Zone.** This improves AZ-level
   isolation, but raises the fixed cost and is unnecessary for the current
   single-user environment.
4. **Use only VPC endpoints and remove general NAT egress.** This would not
   support the stack's required internet destinations, including package and
   Git services.

## Decision

Provision one ARM64 Amazon Linux 2023 `t4g.nano` NAT instance in `PublicSubnet1`
with an Elastic IP, encrypted 8 GiB gp3 root volume, IMDSv2, standard CPU
credits, and SSM-only administration. Persist forwarding and firewall rules,
disable source/destination checks, and monitor status, CPU credit, throughput,
memory, and conntrack use.

The initial rollout used four adjacent modes: `gateway`, `instance-standby`,
`instance-active`, and `instance-only`. After egress validation, the staged
gateway fallback was retired in ADR 0003. NAT instance start and stop behavior
was later automated as recorded in PR #11.

## Consequences

- The runbook estimates monthly cost at about $5.75 when the instance runs
  12 hours per day and $7.26 continuously, compared with about $36 for the
  gateway and EIP. These estimates exclude variable data charges, monitoring,
  taxes, and price changes.
- The EIP and EBS volume continue to incur charges while the instance is
  stopped. Stopping it removes internet egress for both private subnets.
- One instance remains a single point of failure and a cross-AZ dependency for
  the second private subnet; this is acceptable for the current environment.
- At the initial rollout, the operator started the instance and waited for EC2
  status checks before MicroVM work. Later lifecycle automation and gateway
  removal are recorded in PR #11 and ADR 0003.
- The operator owns AL2023 updates and NAT host maintenance.

## References

- [NAT instance runbook](../nat-instance-runbook.md)
- [Issue #8](https://github.com/stevezieglerva/microvm-dev-environment/issues/8)
- [PR #9](https://github.com/stevezieglerva/microvm-dev-environment/pull/9)
