#!/usr/bin/env bash
# The full local browser and emulator run, one project after another (the machine cannot hold several browsers at once).
# Writes one summary file per stage to .local/uat-run/. Run from the repository root after `pnpm build`.
#   bash scripts/uat/run-all.sh
set -u
export PLAYWRIGHT_BROWSERS_PATH=.pw-browsers
OUT=.local/uat-run
mkdir -p "$OUT"
summary() { grep -aE "passed|failed|skipped|flaky|did not run|^\s+[0-9]+\) " | head -60; }

echo "== plain build" > "$OUT/00-build.txt"
pnpm build:pages >> "$OUT/00-build.txt" 2>&1 || echo "BUILD FAILED" >> "$OUT/00-build.txt"

for p in chromium firefox webkit edge mobile android iphone; do
  npx playwright test --project=$p --reporter=line > "$OUT/raw-$p.txt" 2>&1
  { echo "== $p"; summary < "$OUT/raw-$p.txt"; } > "$OUT/10-$p.txt"
  [ "$p" = chromium ] && cp test-results/uat-sweep.json "$OUT/uat-sweep.json" 2>/dev/null
done

# The emulator suite needs a site built for the emulators, exactly as the CI accounts job builds it.
export NEXT_PUBLIC_FIREBASE_CONFIG='{"apiKey":"demo-key","authDomain":"demo-agentontrack.firebaseapp.com","projectId":"demo-agentontrack","appId":"demo-app"}'
export AOT_FIREBASE_EMULATORS=1 AOT_CONFIGURED_BUILD=1
export PATH="$PWD/.local/jdk/bin:$PATH"
pnpm build:pages > "$OUT/20-build-configured.txt" 2>&1
pnpm dlx firebase-tools@15 emulators:exec --only auth,firestore --project demo-agentontrack "pnpm exec playwright test accounts.spec accounts-configured.spec early-access-emulator.spec rules.spec phone.spec phone-new-session.spec --project=chromium --workers=1 --reporter=line" > "$OUT/raw-emulator.txt" 2>&1
{ echo "== emulator"; summary < "$OUT/raw-emulator.txt"; } > "$OUT/30-emulator.txt"

# Leave the plain build in place for anything that runs afterwards.
unset NEXT_PUBLIC_FIREBASE_CONFIG AOT_FIREBASE_EMULATORS AOT_CONFIGURED_BUILD
pnpm build:pages > "$OUT/40-build-plain-again.txt" 2>&1
echo done > "$OUT/99-done.txt"
