#!/usr/bin/env bash
# POST a synthetic ping to /webhook/github, signed with $GITHUB_WEBHOOK_SECRET.
set -euo pipefail

: "${GITHUB_WEBHOOK_SECRET:?missing in .env}"
: "${ROBOMP_BIND_PORT:=8080}"

body='{"zen":"bun ping","hook_id":0}'
sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" -r | awk '{print $1}')"

curl -fsS -X POST "http://localhost:${ROBOMP_BIND_PORT}/webhook/github" \
  -H 'Content-Type: application/json' \
  -H 'X-GitHub-Event: ping' \
  -H "X-GitHub-Delivery: bun-$(date +%s)" \
  -H "X-Hub-Signature-256: $sig" \
  --data "$body"
echo
