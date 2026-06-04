#!/usr/bin/env bash
#
# compat-smoke.sh — Prove the PUBLISHED package surface type-checks against one
# or more Next.js majors.
#
# It builds the package, packs the real npm tarball (`pnpm pack`), then for each
# requested Next major it spins up a throwaway App Router consumer that installs
# `next@<major>` + the tarball and runs `tsc --noEmit`. This exercises the only
# coupling that reaches the consumer: the `next/server` re-export
# (NextRequest / NextResponse) in the published `dist/index.d.ts`, bound against
# the consumer's OWN installed Next version — not this repo's dev shims.
#
# Usage:
#   bash scripts/compat-smoke.sh 15            # single version
#   bash scripts/compat-smoke.sh 13 14 15      # whole matrix
#
# Exits non-zero if any requested version fails to install or type-check.

set -euo pipefail

VERSIONS=("$@")
if [ "${#VERSIONS[@]}" -eq 0 ]; then
  echo "usage: compat-smoke.sh <next-major> [next-major ...]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

echo "==> Building package (tsup)"
pnpm run build >/dev/null 2>&1

echo "==> Packing tarball (pnpm pack)"
pnpm pack --pack-destination "$WORK" >/dev/null 2>&1
TARBALL="$(ls "$WORK"/*.tgz | head -n1)"
if [ -z "${TARBALL:-}" ] || [ ! -f "$TARBALL" ]; then
  echo "FATAL: pnpm pack produced no tarball" >&2
  exit 1
fi
echo "    tarball: $(basename "$TARBALL")"

# Representative consumer route handler. Imports the public API, constructs the
# handler with a realistic options object, and exports it as an App Router POST.
# This is the real compatibility surface a consumer's tsc must accept.
read -r -d '' ROUTE_TS <<'TS' || true
import { nextProxyHandler, InMemoryRateLimitStore } from "nextjs-proxy";
import type { NextProxyOptions, RateLimitStore, LogInfo } from "nextjs-proxy";

const store: RateLimitStore = new InMemoryRateLimitStore();

const options: NextProxyOptions = {
  baseUrl: "https://api.example.com",
  allowedHosts: ["api.example.com"],
  stream: "auto",
  inMemoryRate: { windowMs: 60_000, max: 100, store },
  log: (info: LogInfo) => {
    void info.type;
  },
};

// nextProxyHandler returns (req: NextRequest) => Promise<NextResponse>, bound to
// the CONSUMER's own next/server types — the coupling this smoke test proves.
export const POST = nextProxyHandler(options);
TS

read -r -d '' TSCONFIG <<'JSON' || true
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "jsx": "preserve",
    "types": []
  },
  "include": ["app"]
}
JSON

declare -a RESULTS=()
OVERALL=0

for MAJOR in "${VERSIONS[@]}"; do
  case "$MAJOR" in
    13 | 14) REACT_RANGE="^18.2.0" ;;
    15) REACT_RANGE="^19.0.0" ;;
    *)
      echo "    skip: unsupported major '$MAJOR'"
      RESULTS+=("next@$MAJOR  SKIP (unsupported)")
      OVERALL=1
      continue
      ;;
  esac

  C="$WORK/consumer-$MAJOR"
  mkdir -p "$C/app/api/proxy"
  printf '%s\n' '{ "name": "compat-consumer", "private": true, "version": "0.0.0" }' >"$C/package.json"
  printf '%s\n' "$TSCONFIG" >"$C/tsconfig.json"
  printf '%s\n' "$ROUTE_TS" >"$C/app/api/proxy/route.ts"

  echo "==> [next@$MAJOR] installing (next@^$MAJOR.0.0, react $REACT_RANGE, typescript)"
  if ! (cd "$C" && npm install --no-audit --no-fund --loglevel=error \
    "next@^$MAJOR.0.0" "react@$REACT_RANGE" "react-dom@$REACT_RANGE" \
    "typescript@^5.5.0" "$TARBALL" >/dev/null 2>"$C/install.err"); then
    echo "    INSTALL FAILED:"
    sed 's/^/      /' "$C/install.err" || true
    RESULTS+=("next@$MAJOR  INSTALL-FAIL")
    OVERALL=1
    continue
  fi

  RESOLVED="$(cd "$C" && node -p "require('next/package.json').version" 2>/dev/null || echo '?')"
  echo "==> [next@$MAJOR] type-checking (resolved next@$RESOLVED)"
  if (cd "$C" && ./node_modules/.bin/tsc --noEmit >"$C/tsc.out" 2>&1); then
    echo "    PASS  (next@$RESOLVED)"
    RESULTS+=("next@$MAJOR  PASS (resolved $RESOLVED)")
  else
    echo "    FAIL  (next@$RESOLVED) — tsc output:"
    sed 's/^/      /' "$C/tsc.out" || true
    RESULTS+=("next@$MAJOR  FAIL (resolved $RESOLVED)")
    OVERALL=1
  fi
done

echo ""
echo "================ compat-smoke summary ================"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo "======================================================"
exit "$OVERALL"
