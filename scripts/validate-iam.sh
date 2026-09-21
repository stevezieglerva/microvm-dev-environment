#!/bin/bash
# Read-only validation entrypoint for the sandbox IAM policy.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/verify-iam-hardening.sh"
if [ "${1:-}" = "--simulate" ]; then
  command -v aws >/dev/null 2>&1 || { echo "aws CLI is required for simulation" >&2; exit 1; }
  echo "Policy simulation requires the deployed ExecutionRoleArn; use verify-install.sh --live."
fi
