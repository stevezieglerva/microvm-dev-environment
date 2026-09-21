#!/bin/bash
# Static IAM guardrail checks. Live simulation is optional and read-only.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
template="$ROOT_DIR/template.yaml"
for required in ipad-claude-sandbox-boundary ipad-claude/deployments iam:PassedToService iam:CreateUser iam:CreateAccessKey iam:DeleteRolePermissionsBoundary; do
  grep -Fq "$required" "$template" || { echo "missing IAM guardrail: $required" >&2; exit 1; }
done
if command -v cfn-lint >/dev/null 2>&1; then
  cfn-lint "$template"
fi
echo "IAM hardening checks passed"
