#!/usr/bin/env bash
# The pre-commit gate: lint, typecheck and the full coverage suite, run
# concurrently, each tool's complete output kept in .tmp/check-logs.
#
# A green run fingerprints the worktree into .tmp/check.stamp, so the husky
# hook skips the full suite for content that just passed. Any tracked or
# untracked edit invalidates the stamp, and so does a stamp older than an hour:
# gitignored inputs (lib/, node_modules, staged dsh baselines) can drift without
# changing the fingerprint. `--full` always re-runs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAMP=".tmp/check.stamp"
LOGS=".tmp/check-logs"
INDEX=".tmp/check-index"
STAMP_TTL_MIN=60

# The fingerprint is the worktree's tree object, built through a THROWAWAY
# index: staged and unstaged edits plus untracked files all count, while
# gitignored outputs (.tmp, coverage, lib, node_modules, IDE/tool state) do not.
fingerprint() {
  local tree
  mkdir -p .tmp
  rm -f "$INDEX"
  if ! GIT_INDEX_FILE="$INDEX" git add -A -- . >/dev/null; then
    rm -f "$INDEX"
    return 1
  fi
  tree="$(GIT_INDEX_FILE="$INDEX" git write-tree)" || tree=""
  rm -f "$INDEX"
  [[ -n "$tree" ]] || return 1
  printf '%s\n' "$tree"
}

FULL=0
[[ "${1:-}" == "--full" ]] && FULL=1

# Command substitutions do not inherit errexit on bash 3.2 (macOS), so both
# fingerprint calls check their status explicitly.
BEFORE="$(fingerprint)" || { echo "==> check: cannot fingerprint the worktree" >&2; exit 1; }
if (( FULL == 0 )) && [[ -f "$STAMP" ]] && [[ "$(cat "$STAMP")" == "$BEFORE" ]] \
  && [[ -n "$(find "$STAMP" -mmin "-$STAMP_TTL_MIN" 2>/dev/null)" ]]; then
  echo "==> check: worktree unchanged since the last green gate — skipping. Run 'pnpm run check --full' to force a full run."
  exit 0
fi

rm -rf "$LOGS"
mkdir -p "$LOGS"

echo "==> check: lint, typecheck and coverage in parallel"
pnpm run lint >"$LOGS/lint.log" 2>&1 & LINT=$!
pnpm run typecheck >"$LOGS/typecheck.log" 2>&1 & TYPECHECK=$!
pnpm run coverage >"$LOGS/coverage.log" 2>&1 & COVERAGE=$!

FAILED=""
wait "$LINT" || FAILED="$FAILED lint"
wait "$TYPECHECK" || FAILED="$FAILED typecheck"
wait "$COVERAGE" || FAILED="$FAILED coverage"

for name in lint typecheck coverage; do
  echo
  echo "===== $name ====="
  cat "$LOGS/$name.log"
done

echo
if [[ -n "$FAILED" ]]; then
  echo "==> check FAILED:$FAILED" >&2
  exit 1
fi

# A gate run over a moving worktree proves nothing, so an edit during the run
# must not be stamped as verified.
AFTER="$(fingerprint)" || { echo "==> check: cannot fingerprint the worktree" >&2; exit 1; }
if [[ "$BEFORE" != "$AFTER" ]]; then
  echo "==> check: the worktree changed while the gate ran — re-run before committing." >&2
  exit 1
fi

printf '%s\n' "$BEFORE" > "$STAMP"
echo "==> check passed: lint, typecheck and 100% per-file coverage (lint/typecheck/coverage output above; logs in $LOGS)"
