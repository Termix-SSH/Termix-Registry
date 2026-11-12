#!/usr/bin/env bash
# Turns on immutable releases in every public repo of the org and prints the
# result per repo. Needs gh logged in as an org admin. DRY=1 only reports.
set -u
ORG="${ORG:-Termix-SSH}"
fail=0
for repo in $(gh repo list "$ORG" --visibility public --no-archived --limit 500 --json name -q '.[].name'); do
  path="repos/$ORG/$repo/immutable-releases"
  before=$(gh api "$path" -q .enabled 2>/dev/null || echo "unknown")
  if [ "${DRY:-}" != "1" ] && [ "$before" != "true" ]; then
    gh api -X PUT "$path" > /dev/null 2>&1 || true
  fi
  after=$(gh api "$path" -q .enabled 2>/dev/null || echo "unknown")
  echo "$repo: before=$before after=$after"
  [ "$after" = "true" ] || fail=1
done
exit $fail
