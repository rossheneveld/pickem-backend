#!/usr/bin/env bash
# Substitutes <YOUR-PROJECT-REF> and <YOUR-CRON-SECRET> across every cron
# migration file. Run with no arguments first (dry run) to see exactly what
# will change before anything is actually written.
#
# Usage:
#   ./fill-cron-placeholders.sh                                # dry run — shows diffs only
#   ./fill-cron-placeholders.sh <project-ref> <cron-secret>    # actually applies the changes
#
# Find your project ref in the Supabase dashboard URL:
#   https://supabase.com/dashboard/project/<THIS-PART-IS-YOUR-PROJECT-REF>
#
# Generate a cron secret with:
#   openssl rand -hex 32

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$SCRIPT_DIR/supabase/migrations"

FILES=(
  "002_cron_schedule.sql"
  "007_cron_touch_locked_picks.sql"
  "009_cron_auto_select_matchups.sql"
  "011_cron_notify_upcoming_locks.sql"
  "014_cron_notify_matchup_deadline.sql"
)

PROJECT_REF="${1:-}"
CRON_SECRET="${2:-}"

if [[ -z "$PROJECT_REF" || -z "$CRON_SECRET" ]]; then
  echo "DRY RUN — no changes will be made. Pass both arguments to actually apply them."
  echo ""
  for f in "${FILES[@]}"; do
    path="$MIGRATIONS_DIR/$f"
    if [[ ! -f "$path" ]]; then
      echo "MISSING: $path"
      continue
    fi
    echo "--- $f ---"
    grep -n "YOUR-PROJECT-REF\|YOUR-CRON-SECRET" "$path" || echo "  (no placeholders found — already filled in?)"
    echo ""
  done
  echo "Re-run as: $0 <your-project-ref> <your-cron-secret>"
  exit 0
fi

echo "Applying substitutions to ${#FILES[@]} files..."
for f in "${FILES[@]}"; do
  path="$MIGRATIONS_DIR/$f"
  if [[ ! -f "$path" ]]; then
    echo "MISSING: $path — skipped"
    continue
  fi
  sed -i.bak \
    -e "s/<YOUR-PROJECT-REF>/${PROJECT_REF}/g" \
    -e "s/<YOUR-CRON-SECRET>/${CRON_SECRET}/g" \
    "$path"
  echo "Updated: $f (backup saved as ${f}.bak)"
done

echo ""
echo "Done. Verify with:"
echo "  grep -rn 'YOUR-PROJECT-REF\\|YOUR-CRON-SECRET' \"$MIGRATIONS_DIR\"   # should print nothing"
echo ""
echo "Once confirmed, you can delete the .bak files:"
echo "  rm \"$MIGRATIONS_DIR\"/*.bak"
