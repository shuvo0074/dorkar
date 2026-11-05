#!/usr/bin/env bash
# Signs a member into the app, builds a scenario for them, then runs every detail page.
# Usage: e2e/details.sh <app id> <link scheme>. Env: DEVICE, SMS_LOG, OUT, DORKAR_ROOT.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="$1"; scheme="$2"; phone="0170$(printf %07d $((RANDOM * 30)))"
log="${SMS_LOG:-$here/../../../var/dev-sms.log}"
out="${OUT:-$(mktemp -d)}"; echo "screenshots: $out"
m() { maestro ${DEVICE:+--device "$DEVICE"} test -e APP_ID="$app" -e OUT="$out" -e PHONE="$phone" -e SCHEME="$scheme" "$@"; }
m "$here/signin-phone.yaml"
code="$(grep -E "${phone:1}" "$log" | tail -1 | grep -oE '\b[0-9]{6}\b' | tail -1)"
m -e CODE="$code" "$here/signin-code.yaml"
# The API allows one code a minute per number, and the scenario signs in as the same member.
sleep 65
ids="$(node "$here/scenario.mjs" "$phone")"; echo "$ids"
env_args=(); while IFS= read -r line; do env_args+=(-e "$line"); done < <(node -e 'for (const [k,v] of Object.entries(JSON.parse(process.argv[1]))) console.log(`${k}=${v}`)' "$ids")
m "${env_args[@]}" "$here/details.yaml"
echo "details ok"
