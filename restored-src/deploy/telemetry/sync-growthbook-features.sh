#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$SCRIPT_DIR/claude-growthbook-features.generated.json"
SDK_KEY=""
DRY_RUN=0
ENABLE_REMOTE_EVAL=0

usage() {
  cat <<'USAGE'
Usage:
  ./sync-growthbook-features.sh [--manifest FILE] [--sdk-key sdk-...] [--dry-run] [--enable-remote-eval]

Imports the generated Claude Code GrowthBook feature manifest into the
GrowthBook MongoDB container managed by this deploy/telemetry compose stack.

The script infers organization, project, and environment from the SDK
connection when --sdk-key is provided. Without --sdk-key, it uses the first SDK
connection in MongoDB.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest)
      MANIFEST="$2"
      shift 2
      ;;
    --sdk-key)
      SDK_KEY="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --enable-remote-eval)
      ENABLE_REMOTE_EVAL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$MANIFEST" ]]; then
  echo "Manifest not found: $MANIFEST" >&2
  echo "Generate it from the restored-src checkout first:" >&2
  echo "  node deploy/telemetry/generate-growthbook-features.mjs --write" >&2
  exit 1
fi

read_env_value() {
  local key="$1"
  local file="$SCRIPT_DIR/.env"
  [[ -f "$file" ]] || return 1
  awk -F= -v key="$key" '
    $0 !~ /^[[:space:]]*#/ && $1 == key {
      sub(/^[^=]*=/, "")
      gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      gsub(/^"|"$/, "")
      gsub(/^'\''|'\''$/, "")
      print
      exit
    }
  ' "$file"
}

MONGO_USER="${MONGO_INITDB_ROOT_USERNAME:-$(read_env_value MONGO_INITDB_ROOT_USERNAME || true)}"
MONGO_PASSWORD="${MONGO_INITDB_ROOT_PASSWORD:-$(read_env_value MONGO_INITDB_ROOT_PASSWORD || true)}"
MONGO_USER="${MONGO_USER:-growthbook}"
MONGO_PASSWORD="${MONGO_PASSWORD:-growthbook}"
DOCKER_CONFIG="${DOCKER_CONFIG:-}"
if [[ -z "$DOCKER_CONFIG" && -d "$SCRIPT_DIR/.docker-config" ]]; then
  export DOCKER_CONFIG="$SCRIPT_DIR/.docker-config"
fi

TMP_JS="$(mktemp)"
cleanup() {
  rm -f "$TMP_JS"
}
trap cleanup EXIT

cat >"$TMP_JS" <<'MONGOJS'
const fs = require("fs");

const manifestPath = "/tmp/claude-growthbook-features.generated.json";
const payload = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const sdkKey = process.env.CLAUDE_GB_SYNC_SDK_KEY || "";
const dryRun = process.env.CLAUDE_GB_SYNC_DRY_RUN === "1";
const enableRemoteEval = process.env.CLAUDE_GB_SYNC_ENABLE_REMOTE_EVAL === "1";

if (!payload || !Array.isArray(payload.features)) {
  throw new Error("Invalid manifest: expected { features: [...] }");
}

let sdkConnection = null;
if (sdkKey) {
  sdkConnection = db.sdkconnections.findOne({ key: sdkKey });
  if (!sdkConnection) {
    throw new Error(`No SDK connection found for key ${sdkKey}`);
  }
} else {
  sdkConnection = db.sdkconnections.findOne({}, { sort: { dateCreated: 1 } });
  if (!sdkConnection) {
    throw new Error("No SDK connection found. Create one in GrowthBook first.");
  }
}

const organization = sdkConnection.organization;
const project = Array.isArray(sdkConnection.projects) && sdkConnection.projects.length
  ? sdkConnection.projects[0]
  : undefined;
const environment = sdkConnection.environment || "production";
if (!organization || !project) {
  throw new Error("SDK connection is missing organization or project");
}

const now = new Date();
let inserted = 0;
let updated = 0;
let unchanged = 0;
let skipped = 0;

for (const feature of payload.features) {
  if (!feature.key || !feature.valueType || feature.conflict) {
    skipped++;
    continue;
  }

  const storedDefaultValue =
    feature.valueType === "json"
      ? JSON.stringify(feature.defaultValue)
      : feature.defaultValue;

  const doc = {
    id: feature.key,
    organization,
    archived: false,
    description:
      "Imported from restored-src GrowthBook call sites. Default mirrors code fallback.",
    owner: "",
    project,
    dateCreated: now,
    dateUpdated: now,
    version: 1,
    valueType: feature.valueType,
    defaultValue: storedDefaultValue,
    environments: [environment],
    environmentSettings: {
      [environment]: {
        enabled: true,
      },
    },
    rules: [],
    prerequisites: [],
    tags: ["restored-src", "claude-code"],
    linkedExperiments: [],
    neverStale: true,
    customFields: {},
    legacyDraftMigrated: true,
  };

  const existing = db.features.findOne({ organization, id: feature.key });
  if (!existing) {
    if (!dryRun) db.features.insertOne(doc);
    inserted++;
    continue;
  }

  const tags = Array.from(new Set([...(existing.tags || []), ...doc.tags]));
  const environments = Array.from(new Set([...(existing.environments || []), environment]));
  const envSettings = existing.environmentSettings || {};
  if (!envSettings[environment]) {
    envSettings[environment] = { enabled: true };
  } else if (envSettings[environment].enabled === undefined) {
    envSettings[environment].enabled = true;
  }

  const shouldBackfillDefaultValue =
    existing.defaultValue === undefined ||
    (
      feature.valueType === "json" &&
      typeof existing.defaultValue !== "string" &&
      (existing.tags || []).includes("restored-src")
    );

  const set = {
    description: existing.description || doc.description,
    project: existing.project || project,
    valueType: existing.valueType || doc.valueType,
    defaultValue: shouldBackfillDefaultValue
      ? doc.defaultValue
      : existing.defaultValue,
    environments,
    environmentSettings: envSettings,
    dateUpdated: now,
    tags,
    neverStale: existing.neverStale === undefined ? true : existing.neverStale,
    customFields: existing.customFields || {},
    legacyDraftMigrated:
      existing.legacyDraftMigrated === undefined
        ? true
        : existing.legacyDraftMigrated,
  };

  const changed =
    JSON.stringify(set.tags) !== JSON.stringify(existing.tags || []) ||
    JSON.stringify(set.environments) !== JSON.stringify(existing.environments || []) ||
    JSON.stringify(set.environmentSettings) !== JSON.stringify(existing.environmentSettings || {}) ||
    existing.project === undefined ||
    existing.valueType === undefined ||
    shouldBackfillDefaultValue ||
    existing.neverStale === undefined ||
    existing.customFields === undefined ||
    existing.legacyDraftMigrated === undefined;

  if (changed) {
    if (!dryRun) db.features.updateOne({ organization, id: feature.key }, { $set: set });
    updated++;
  } else {
    unchanged++;
  }
}

let remoteEvalChanged = false;
if (enableRemoteEval && sdkConnection.remoteEvalEnabled !== true) {
  if (!dryRun) {
    db.sdkconnections.updateOne(
      { _id: sdkConnection._id },
      { $set: { remoteEvalEnabled: true, dateUpdated: now } },
    );
  }
  remoteEvalChanged = true;
}

const cacheResult = dryRun ? { deletedCount: 0 } : db.sdkcache.deleteMany({});

printjson({
  dryRun,
  organization,
  project,
  environment,
  sdkConnection: sdkConnection.name,
  sdkKey: sdkConnection.key,
  inserted,
  updated,
  unchanged,
  skipped,
  manifestFeatures: payload.features.length,
  unresolved: Array.isArray(payload.unresolved) ? payload.unresolved.length : 0,
  remoteEvalChanged,
  sdkCacheDeleted: cacheResult.deletedCount,
  totalFeaturesForOrg: db.features.countDocuments({ organization }),
});
MONGOJS

cd "$SCRIPT_DIR"
docker compose cp "$MANIFEST" mongo:/tmp/claude-growthbook-features.generated.json >/dev/null
docker compose cp "$TMP_JS" mongo:/tmp/sync-growthbook-features.js >/dev/null

CLAUDE_GB_SYNC_SDK_KEY="$SDK_KEY" \
CLAUDE_GB_SYNC_DRY_RUN="$DRY_RUN" \
CLAUDE_GB_SYNC_ENABLE_REMOTE_EVAL="$ENABLE_REMOTE_EVAL" \
docker compose exec -T \
  -e CLAUDE_GB_SYNC_SDK_KEY \
  -e CLAUDE_GB_SYNC_DRY_RUN \
  -e CLAUDE_GB_SYNC_ENABLE_REMOTE_EVAL \
  mongo mongosh --quiet growthbook \
    -u "$MONGO_USER" \
    -p "$MONGO_PASSWORD" \
    --authenticationDatabase admin \
    /tmp/sync-growthbook-features.js
