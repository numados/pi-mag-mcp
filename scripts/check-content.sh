#!/usr/bin/env bash
# Content hygiene: the text this repository ships must not carry machine- or
# tenant-specific data. Code, tests, docs, fixtures and commit messages are all
# published with the package, so an absolute home path, a customer name or a
# real tracker prefix leaks the same way a credential would.
#
# Usage:
#   scripts/check-content.sh            # tracked files
#   scripts/check-content.sh --history  # also every commit message
#
# The name denylist is machine-local on purpose: `~/.pi/agent/content-denylist.txt`
# (one token per line). Writing those names into the repository would leak them
# again — the same reason the shape checks below test shapes, not names.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT" || exit 1

DENYLIST="${CONTENT_DENYLIST:-$HOME/.pi/agent/content-denylist.txt}"
CHECK_HISTORY=false
[ "${1:-}" = "--history" ] && CHECK_HISTORY=true

failed=0
report() { # report <label> <file> <line> <text>
  printf '%s: %s:%s\n    %s\n' "$1" "$2" "$3" "$4"
  failed=1
}

# ── shape checks over tracked files ─────────────────────────────────────────
# The patterns are shapes, not names: a home directory of a real machine, a
# personal e-mail, a tracker id outside the neutral example prefixes.
SHAPE='(\/(Users|home)\/[A-Za-z0-9._-]+\/)'
EMAIL='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
TICKET='\b([A-Z]{2,6})-[0-9]{2,}\b'

while IFS= read -r file; do
  [ -f "$file" ] || continue
  case "$file" in
    *.lock|*/dist/*|*.png|*.jpg|*.pdf) continue ;;
  esac
  while IFS=: read -r line text; do
    report "home path" "$file" "$line" "$text"
  done < <(rg -n --no-heading -e "$SHAPE" "$file" 2>/dev/null | sed 's/^\([0-9]*\):/\1:/' | head -20)
  # A Teams thread id looks like `19:...@thread.tacv2` — a fixture, not an address.
  while IFS=: read -r line text; do
    case "$text" in *"@thread."*) continue ;; esac
    report "e-mail" "$file" "$line" "$text"
  done < <(rg -n --no-heading -e "$EMAIL" "$file" 2>/dev/null | head -20)
  while IFS= read -r match; do
    prefix="${match#*:}"
    prefix="${prefix%%-*}"
    # A literal pattern list: `|` inside a variable is not a case separator.
    case "$prefix" in
      ABC|PLAN|PROJ|TASK|SAMPLE|EXAMPLE|LOCAL|SMOKE|CANON|LEGACY|MULTI|STRING|ROUTED|FLOW) ;;
      *) report "ticket-like id" "$file" "-" "$match" ;;
    esac
  done < <(rg -oN --no-filename -e "$TICKET" "$file" 2>/dev/null | sort -u | head -20)
done < <(git ls-files)

# ── the machine-local denylist: real customer / product / person names ──────
if [ -f "$DENYLIST" ]; then
  while IFS= read -r token; do
    case "$token" in ''|\#*) continue ;; esac
    while IFS= read -r hit; do
      report "denylisted name" "${hit%%:*}" "-" "${hit#*:}"
    done < <(git grep -Ini --no-heading -F "$token" -- . 2>/dev/null | head -20)
  done < "$DENYLIST"
else
  printf 'note: no denylist at %s — only shape checks ran\n' "$DENYLIST"
fi

# ── commit messages carry the same rule ────────────────────────────────────
if [ "$CHECK_HISTORY" = true ]; then
  while IFS= read -r token; do
    case "${token:-}" in ''|\#*) continue ;; esac
    while IFS= read -r hit; do
      report "denylisted name in history" "commit" "${hit%%:*}" "${hit#*:}"
    done < <(git log --format='%h:%B' | grep -in -F "$token" | head -10)
  done < "$DENYLIST" 2>/dev/null || true
fi

if [ "$failed" -eq 0 ]; then
  printf 'content hygiene: clean\n'
else
  printf '\ncontent hygiene: problems above. Use neutral placeholders (~/vaults/work,\n/opt/notes/example-vault, ABC-123) and keep real names out of the repository.\n'
fi
exit "$failed"
