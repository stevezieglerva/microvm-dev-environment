# EC2 NAT instance runbook

The stack routes both private subnets through one ARM64 Amazon Linux 2023
`t4g.nano` EC2 NAT instance in `PublicSubnet1`. It has 0.5 GiB of RAM, a
1 GiB disk-backed swap file, an Elastic IP, and an encrypted 8 GiB gp3 root
volume. The single instance creates a cross-AZ dependency for `PrivateSubnet2`,
so this design is intended for the single-user development environment.

The CloudFormation template provisions only the EC2 NAT path. The former
managed NAT Gateway and its EIP were removed by the 2026-10-04 stack update.
Both private subnets still route through the EC2 instance, and a post-update
MicroVM check returned its EIP. The template no longer provides a managed
Gateway rollback path.

The initial egress checks passed on 2026-10-04 from both private subnets and the
real MicroVM connector. They covered public HTTPS, AWS and STS APIs, Bedrock,
GitHub, PyPI, AgentCore web search, and the S3 Files home mount.

See [ADR 0001](adr/0001-use-stoppable-ec2-nat-instance.md) for the NAT design
and [ADR 0002](adr/0002-increase-nat-instance-memory.md) for the instance size.

## Automatic lifecycle

When token vending creates or resumes a MicroVM, it requests NAT instance
startup without waiting for the instance to become ready. Internet egress can
be unavailable briefly while EC2 starts and forwarding becomes available.

EventBridge invokes the NAT controller once per minute. It checks the live
private route and tracked MicroVM states, keeps NAT running while any VM is
starting, running, unknown, or temporarily unavailable, and stops the instance
only when every tracked VM is suspended or terminated. The controller does not
change routes. Its concurrency limit and start marker protect a concurrent
session start from an idle stop decision.

The existing 7,200-second MicroVM idle policy remains unchanged. Do not stop
the NAT instance while a session needs internet access for package downloads,
Git, Bedrock, AgentCore, or the S3 Files mount.

The stack also enforces a one-hour maximum MicroVM lifetime. A daily EventBridge
Scheduler job at 10 p.m. America/New_York terminates all tracked MicroVMs and
requests that the NAT instance stop, even if a session is still active.

## Verify egress

Confirm the instance is running and both EC2 status checks are `ok`:

```bash
INSTANCE_ID=$(aws cloudformation describe-stacks --stack-name ipad-claude \
  --query "Stacks[0].Outputs[?OutputKey=='NatInstanceId'].OutputValue" --output text)
aws ec2 describe-instance-status --instance-ids "$INSTANCE_ID" \
  --include-all-instances --output table
```

Confirm both private subnets use the shared route table and its default route
targets the instance. Then check from a real MicroVM connector:

```bash
curl -fsS --max-time 10 https://checkip.amazonaws.com
```

The result should match the NAT instance's Elastic IP. Check the required AWS,
Bedrock, package and Git endpoints, AgentCore web search, and S3 Files mount
from both private subnets and the real MicroVM connector after any networking
change.

## Manual recovery

For an EC2 start or health issue, inspect the instance through Systems Manager
Session Manager. To start it manually and wait for readiness:

```bash
aws ec2 start-instances --instance-ids "$INSTANCE_ID"
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
aws ec2 wait instance-status-ok --instance-ids "$INSTANCE_ID"
```

Stopping the NAT instance removes internet egress from both private subnets.
The automated controller normally handles idle stops; if manual stopping is
needed, first confirm every MicroVM is suspended or terminated:

```bash
aws ec2 stop-instances --instance-ids "$INSTANCE_ID"
```

The template no longer manages a NAT Gateway fallback. Restoring that path
requires an infrastructure change that adds a gateway and updates the route.

## Cost and monitoring

Approximate us-east-1 monthly cost is $5.75 when the `t4g.nano` runs 12 hours
per day, or $7.26 continuously. Estimates exclude data transfer, monitoring,
taxes, and price changes. A stopped instance still incurs Elastic IP and EBS
storage charges, but not instance compute charges. The former always-on NAT
Gateway and its EIP are removed when the updated stack is deployed.

Use the `ipad-claude-nat-instance` dashboard and status, CPU credit, memory,
and conntrack alarms. CloudWatch Agent publishes available memory; a systemd
timer publishes conntrack count, limit, and utilization. CloudWatch metrics
stop while the instance is stopped, and alarms treat missing data as
non-breaching, so check EC2 status directly after a start.

The instance uses SSM and IMDSv2, has no SSH key or management ingress, and
disables source/destination checks. A systemd-managed iptables service restores
VPC-scoped forwarding and MASQUERADE rules after reboot.
