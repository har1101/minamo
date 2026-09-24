#!/usr/bin/env bash
# Builds and deploys the example with the AWS CLI only (CloudFormation runs the SAM transform; no SAM CLI needed).
# Env: STACK_NAME (default minamo-example), AWS_REGION (default us-east-1), ARTIFACT_BUCKET (default: created),
#      BEDROCK_MODEL_ID (optional override).
set -euo pipefail

STACK_NAME="${STACK_NAME:-minamo-example}"
AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION
cd "$(dirname "${BASH_SOURCE[0]}")/.."

npm run build

if [[ -z "${ARTIFACT_BUCKET:-}" ]]; then
  account="$(aws sts get-caller-identity --query Account --output text)"
  ARTIFACT_BUCKET="minamo-artifacts-${account}-${AWS_REGION}"
  if ! aws s3api head-bucket --bucket "${ARTIFACT_BUCKET}" 2>/dev/null; then
    echo "==> Creating artifact bucket ${ARTIFACT_BUCKET}"
    if [[ "${AWS_REGION}" == "us-east-1" ]]; then
      aws s3api create-bucket --bucket "${ARTIFACT_BUCKET}" >/dev/null
    else
      aws s3api create-bucket --bucket "${ARTIFACT_BUCKET}" --create-bucket-configuration "LocationConstraint=${AWS_REGION}" >/dev/null
    fi
    aws s3api put-public-access-block --bucket "${ARTIFACT_BUCKET}" \
      --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  fi
fi

echo "==> Packaging to s3://${ARTIFACT_BUCKET}/${STACK_NAME}"
aws cloudformation package --template-file template.yaml --s3-bucket "${ARTIFACT_BUCKET}" --s3-prefix "${STACK_NAME}" \
  --output-template-file dist/packaged.yaml >/dev/null

overrides=()
if [[ -n "${BEDROCK_MODEL_ID:-}" ]]; then overrides+=("BedrockModelId=${BEDROCK_MODEL_ID}"); fi

echo "==> Deploying stack ${STACK_NAME} (${AWS_REGION})"
aws cloudformation deploy --template-file dist/packaged.yaml --stack-name "${STACK_NAME}" \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --no-fail-on-empty-changeset \
  ${overrides[@]+--parameter-overrides "${overrides[@]}"}

aws cloudformation describe-stacks --stack-name "${STACK_NAME}" --query "Stacks[0].Outputs" --output table
