# NAT instance runbook

The stack supports a reversible migration from the managed NAT Gateway to one
ARM64 Amazon Linux 2023 `t4g.nano` EC2 NAT instance. The instance is in
`PublicSubnet1`; both private subnets continue to use their shared route table.
The single instance creates a cross-AZ dependency for `PrivateSubnet2`, so this
design is intended for the single-user development environment.

## Modes and safe transitions

| Mode | Private route target | NAT Gateway and EIP | NAT instance |
| --- | --- | --- | --- |
| `gateway` | NAT Gateway | retained | absent |
| `instance-standby` | NAT Gateway | retained | retained |
| `instance-active` | NAT instance | retained | retained |
| `instance-only` | NAT instance | removed | retained |

Deploy modes one step at a time:

```text
gateway <-> instance-standby <-> instance-active <-> instance-only
```

`scripts/deploy.sh` reads the deployed `NatMode` when `--nat-mode` is omitted
and passes it to every SAM deployment. It rejects skipped transitions. It also
requires the instance to be running with both EC2 status checks `ok` before
switching to `instance-active`.

## Provision and activate

1. Provision the instance while gateway traffic remains unchanged:

   ```bash
   ./scripts/deploy.sh --nat-mode instance-standby --skip-mvm
   ```

CloudFormation associates the instance EIP with its pre-created network
interface before launching the instance. The stack waits for UserData to
install and start NAT forwarding, monitoring, and SSM before it reports the
instance ready.

2. Confirm the instance output and wait for it to become ready:

   ```bash
   INSTANCE_ID=$(aws cloudformation describe-stacks --stack-name ipad-claude \
     --query "Stacks[0].Outputs[?OutputKey=='NatInstanceId'].OutputValue" --output text)
   aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
   aws ec2 wait instance-status-ok --instance-ids "$INSTANCE_ID"
   aws ec2 describe-instance-status --instance-ids "$INSTANCE_ID" \
     --include-all-instances --output table
   ```

3. Start an SSM session:

   ```bash
   aws ssm start-session --target "$INSTANCE_ID"
   ```

   At the remote shell prompt, verify forwarding, firewall rules, and services:

   ```bash
   sysctl net.ipv4.ip_forward
   systemctl is-enabled iptables nat-conntrack.timer amazon-ssm-agent
   systemctl is-active amazon-cloudwatch-agent nat-conntrack.timer amazon-ssm-agent
   iptables -S INPUT
   iptables -S FORWARD
   iptables -t nat -S POSTROUTING
   ```

The host firewall drops new inbound connections, including SSH. CloudFormation
does not expose a `Tags` property for `AWS::IAM::InstanceProfile`, so the
instance profile cannot receive the `Name`, `Type`, and `Created` tags through
this template; the associated role is tagged.

4. Switch private egress to the instance while retaining the gateway for
   rollback:

   ```bash
   ./scripts/deploy.sh --nat-mode instance-active --skip-mvm
   ```

5. Validate external HTTPS, AWS and Bedrock APIs, package and Git access,
   AgentCore web search, and the S3 Files mount from workloads in both private
   subnets and from a real MicroVM connector. Capture successful results for
   each subnet.

Keep `instance-active` for a 24–48 hour soak. Monitor the
`ipad-claude-nat-instance` dashboard and its status, CPU credit, memory, and
conntrack alarms during normal MicroVM use. Repeat the external HTTPS, AWS,
Bedrock, package/Git, AgentCore web search, and S3 Files checks from both
private subnets and the real MicroVM connector during the soak and before
selecting `instance-only`.

6. After the soak and a final egress check, remove the managed gateway and its
   EIP:

   ```bash
   ./scripts/deploy.sh --nat-mode instance-only --skip-mvm
   ```

Only this mode deletes the gateway resources. The instance EIP and encrypted
8 GiB gp3 volume remain attached to the instance.

## Daily operation

Start the instance before starting MicroVM work, then wait for both the
`running` state and EC2 system and instance status checks to be `ok`:

```bash
aws ec2 start-instances --instance-ids "$INSTANCE_ID"
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
aws ec2 wait instance-status-ok --instance-ids "$INSTANCE_ID"
```

Stopping the NAT instance stops all public internet egress from both private
subnets. Suspend or terminate every MicroVM session first, then stop it:

```bash
aws ec2 stop-instances --instance-ids "$INSTANCE_ID"
```

The instance's Elastic IP and 8 GiB EBS volume continue billing while it is
stopped. The instance itself does not accrue running compute charges while
stopped. Do not stop it while active sessions need package downloads, Git,
Bedrock, AgentCore, or S3 Files network access.
CloudWatch metrics stop while the instance is stopped; alarms treat missing
data as non-breaching, so check its EC2 status directly after starting it.

## Rollback

From `instance-active`, route traffic back to the gateway:

```bash
./scripts/deploy.sh --nat-mode instance-standby --skip-mvm
```

The instance remains available for diagnosis. To return to the original
gateway-only deployment, use:

```bash
./scripts/deploy.sh --nat-mode gateway --skip-mvm
```

If the stack is in `instance-only`, first select `instance-active`. CloudFormation
recreates the gateway and its EIP while private traffic remains on the healthy
instance. After the gateway is ready, select `instance-standby` to move the
route back, then `gateway` to remove the instance. Never skip a mode.

## Cost and monitoring assumptions

Approximate us-east-1 monthly cost is $5.75 when the `t4g.nano` runs 12 hours
per day, or $7.26 continuously, compared with roughly $36 for the always-on
managed gateway and EIP. These estimates exclude data transfer, NAT processing,
CloudWatch monitoring, taxes, and price changes. A stopped instance still
incurs Elastic IP and EBS storage charges.

The instance uses SSM and IMDSv2, has no SSH key or management ingress, and
disables source/destination checks. A systemd-managed iptables service restores
VPC-scoped forwarding and MASQUERADE rules after reboot. CloudWatch Agent
publishes available memory; a systemd timer publishes conntrack count, limit,
and utilization. The dashboard uses EC2 network throughput metrics.
