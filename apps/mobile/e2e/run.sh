#!/usr/bin/env bash
# Runs the journeys. Usage: e2e/run.sh <app id> [phone]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="$1"; phone="${2:-01700000123}"
log="${SMS_LOG:-$here/../../../var/dev-sms.log}"
out="${OUT:-$(mktemp -d)}"; echo "screenshots: $out"
m() { maestro test -e APP_ID="$app" -e OUT="$out" -e PHONE="$phone" "$@"; }
m "$here/browse.yaml"
m "$here/signin-phone.yaml"
code="$(grep -E "${phone:1}|$phone" "$log" | tail -1 | grep -oE '\b[0-9]{6}\b' | tail -1)"
m -e CODE="$code" "$here/signin-code.yaml"
m "$here/post-need.yaml"
