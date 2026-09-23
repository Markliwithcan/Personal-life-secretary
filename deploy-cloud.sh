#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
version="${1:?Usage: bash deploy-cloud.sh VERSION}"
[[ "$version" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || exit 2
export ASSISTANT_IMAGE="feishu-assistant:$version"
test -f cloud-config/assistant.local.json
test -f cloud-config/feishu.local.json
test -d cloud-data
docker compose config --quiet
# Build before stopping the current service. Existing images remain available for rollback.
docker compose build assistant
docker compose stop assistant
if test -f cloud-data/feishu/inbox.sqlite3; then
  backup_dir="$(pwd)/cloud-backups/$(date -u +%Y%m%dT%H%M%SZ)-$version"
  mkdir -p "$backup_dir"
  docker compose run --rm --no-deps --user 0:0 -v "$backup_dir:/backup" assistant node cloud-backup.mjs backup /data/feishu /backup
fi
docker compose up -d --no-build --wait --wait-timeout 150 assistant
printf 'ASSISTANT_IMAGE=%s\n' "$ASSISTANT_IMAGE" > .env
printf 'Deployed %s. Check message reception and reminder delivery.\n' "$ASSISTANT_IMAGE"
