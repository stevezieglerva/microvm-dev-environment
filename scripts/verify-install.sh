#!/bin/bash
# Verify deployed control-plane readiness without changing AWS state.
set -euo pipefail
STACK_NAME="${STACK_NAME:-ipad-claude}"
REGION="${AWS_REGION:-us-east-1}"
status=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" --query 'Stacks[0].StackStatus' --output text)
case "$status" in CREATE_COMPLETE|UPDATE_COMPLETE) ;; *) echo "stack is not ready: $status" >&2; exit 1;; esac
for output in FrontendUrl TokenApiUrl UserPoolId UserPoolClientId S3FilesFileSystemId NetworkConnectorArn ExecutionRoleArn MicrovmImageArn; do
  value=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" --query "Stacks[0].Outputs[?OutputKey=='$output'].OutputValue | [0]" --output text)
  [ -n "$value" ] && [ "$value" != "None" ] || { echo "missing output: $output" >&2; exit 1; }
done
echo "CloudFormation outputs verified for $STACK_NAME"
