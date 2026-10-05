# ADR 0004: Bound MicroVM and NAT Runtime for Cost

- **Status:** Accepted
- **Date:** 2026-10-05
- **Decision owner:** Steve Ziegler
- **Updates:** [ADR 0003](0003-remove-managed-nat-gateway.md)
- **Implementation:** Deployed to the `ipad-claude` stack in `us-east-1` on 2026-10-05.

## Context

ADR 0003 removed the unused managed NAT Gateway. The remaining EC2 NAT instance
starts when a MicroVM is launched or resumed and stops after all tracked VMs
are suspended or terminated. A running MicroVM can keep the NAT instance
running as well.

The token service previously allowed each MicroVM to run for up to eight hours.
The two-hour idle policy measures inbound proxy traffic, not human input. An
open browser terminal sends WebSocket keepalives, so a terminal left open can
keep the VM and NAT instance running without anyone typing.

## Decision drivers

- Bound compute runtime when a browser session is left open.
- End sessions at a predictable time each day, including active sessions.
- Preserve each user's `/home/coder` files across VM termination.
- Keep the existing NAT instance lifecycle for ordinary session start and idle.

## Considered options

1. **Keep the eight-hour maximum and rely on idle suspension.** This permits
   longer work sessions, but browser keepalives can prevent the idle timeout.
2. **Remove NAT egress.** This would reduce compute cost further, but the
   development environment needs outbound access for package, Git, AWS, and
   Bedrock operations.
3. **Limit each VM to one hour and add a nightly forced shutdown.** This puts a
   fixed bound on each VM and cleans up any remaining tracked sessions daily.

## Decision

Set each newly launched MicroVM's `maximumDurationInSeconds` to 3,600 seconds.
Keep the 7,200-second idle policy and its existing suspend behavior. The
one-hour maximum is a hard per-VM lifetime, even when proxy traffic continues.

Add a daily shutdown at 10 p.m. America/New_York. It terminates all MicroVMs
tracked in the stack's per-user SSM parameters, then requests that the EC2 NAT
instance stop. The schedule uses the UTC hours that correspond to 10 p.m. in
standard and daylight time; the Lambda checks the original scheduled timestamp
and acts only for 10 p.m. Eastern.

The nightly action does not disable sign-in or MicroVM creation. A later login
can launch a new VM and start the NAT instance; the following nightly run will
terminate tracked VMs again.

## Consequences

- A one-hour limit can terminate active work. The user's `/home/coder` data
  persists on S3 Files, while processes and files outside that mount do not
  survive termination.
- The 10 p.m. action can interrupt an active session and removes private-subnet
  internet egress when the NAT instance stops.
- Stopping the NAT instance avoids its instance compute charges while stopped;
  its attached Elastic IP and EBS storage remain provisioned and can still
  incur charges.
- The nightly action uses the existing EventBridge rule and NAT controller; it
  does not add EventBridge Scheduler permissions to the AWS user.

## References

- [NAT instance runbook](../nat-instance-runbook.md)
- [ADR 0001: Use a Stoppable EC2 NAT Instance](0001-use-stoppable-ec2-nat-instance.md)
- [ADR 0003: Remove the Managed NAT Gateway](0003-remove-managed-nat-gateway.md)
- [EventBridge scheduled rules](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-create-rule-schedule.html)
