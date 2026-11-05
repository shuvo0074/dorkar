#!/usr/bin/env bash
# The whole loop: browse, sign in, post a need, a seller offers (through the API), accept, a deal.
# Usage: e2e/run.sh <app id> <link scheme> [buyer phone]
# Env: DEVICE (maestro device id), SMS_LOG (default the repo's var/dev-sms.log), OUT (screenshots)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="$1"; scheme="$2"; phone="${3:-0170$(printf %07d $((RANDOM * 30)))}"
log="${SMS_LOG:-$here/../../../var/dev-sms.log}"
out="${OUT:-$(mktemp -d)}"; echo "screenshots: $out"
title="E2E phone $(date +%H%M%S)"
m() { maestro ${DEVICE:+--device "$DEVICE"} test -e APP_ID="$app" -e OUT="$out" -e PHONE="$phone" -e TITLE="$title" -e SCHEME="$scheme" "$@"; }
m "$here/browse.yaml"
m "$here/signin-phone.yaml"
code="$(grep -E "${phone:1}" "$log" | tail -1 | grep -oE '\b[0-9]{6}\b' | tail -1)"
m -e CODE="$code" "$here/signin-code.yaml"
m "$here/post-need.yaml"
offer="$(node "$here/seller-offer.mjs" "$title" "$log")"
m -e OFFER="$offer" "$here/accept-offer.yaml"
echo "journey ok"
