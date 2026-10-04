#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/nat-mode.sh"

for mode in gateway instance-standby instance-active instance-only; do
  nat_mode_is_valid "$mode"
done
! nat_mode_is_valid invalid

for transition in \
  "gateway instance-standby" "instance-standby gateway" \
  "instance-standby instance-active" "instance-active instance-standby" \
  "instance-active instance-only" "instance-only instance-active"; do
  # shellcheck disable=SC2086
  nat_mode_transition_allowed $transition
done

for transition in \
  "gateway instance-active" "gateway instance-only" \
  "instance-standby instance-only" "instance-only instance-standby" \
  "instance-only gateway"; do
  # shellcheck disable=SC2086
  ! nat_mode_transition_allowed $transition
done

echo "NAT mode validation passed"
