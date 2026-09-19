#!/usr/bin/env node
/**
 * Restore Anthropic-internal npm packages into restored-src/node_modules.
 *
 * The published claude-code tarball ships a webpack bundle + source map, and the
 * map embeds the real source of the modules the runtime imports at execution
 * time (package/cli.js.map, `../node_modules/...` entries). Almost all of those
 * are public packages that `bun install` fetches from the registry, but a small
 * scope — the internal `@ant/*` packages (`@ant/claude-for-chrome-mcp`,
 * `@ant/computer-use-*`) — is Anthropic-internal and never published to npm, so
 * a clean install leaves those directories missing and the runtime fails with
 * "Cannot find module '@ant/...'". This script reconstructs them from the map.
 *
 * Policy: only the `@ant/` scope is reconstructed. Any *other* package that is
 * absent after `bun install` is a public package whose presence in the map is a
 * leftover of the original build's older dependency tree; bun's current
 * resolution (package.json + bun.lock) deliberately does not install it, so
 * rebuilding it from the map would only drop a package.json-less, native-binary
 * -less source stub into node_modules. Leave those alone.
 *
 * The script is idempotent and safe to run before or after `bun install`:
 * registry-managed `@ant/*` (should one ever be published) is skipped because a
 * package.json exists on disk.
 *
 * Usage:
 *   node scripts/restore-internal-deps.mjs      # any Node >= 18
 *   bun scripts/restore-internal-deps.mjs       # from scripts/bootstrap.sh
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAP_FILE = join(ROOT, "package", "cli.js.map");
const NODE_MODULES = join(ROOT, "restored-src", "node_modules");

function packageParts(rel) {
  // rel like "node_modules/@ant/computer-use-mcp/dist/index.js" or
  // "node_modules/chalk/source/index.js". Returns { pkg, rest } or null.
  const m = rel.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/(.*))?$/);
  if (!m) return null;
  const pkg = m[1];
  if (pkg === ".bin" || pkg.startsWith(".")) return null; // never restore dot-dirs
  return { pkg, rest: m[2] || "" };
}

function main() {
  if (!existsSync(MAP_FILE)) {
    console.error(`source map not found: ${MAP_FILE}`);
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(MAP_FILE, "utf8"));
  const { sources, sourcesContent } = raw;
  if (!Array.isArray(sources)) {
    console.error("source map has no `sources` array");
    process.exit(1);
  }

  const restored = new Map(); // pkg -> files written
  let skippedNonInternal = 0;
  let skippedInstalled = 0;
  let skippedNoContent = 0;

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const content = sourcesContent?.[i];
    if (typeof src !== "string") continue;

    // Normalize whatever prefix webpack/the map used ("webpack:///../node_modules/…",
    // "../../node_modules/…", "../node_modules/…") to a plain node_modules path.
    const rel = src.replace(/^.*node_modules\//, "node_modules/").replace(/\?.*$/, "");
    if (!rel.startsWith("node_modules/")) continue;

    const parts = packageParts(rel);
    if (!parts) continue;
    const { pkg, rest } = parts;

    if (!pkg.startsWith("@ant/")) {
      skippedNonInternal++;
      continue;
    }

    const pkgDir = join(NODE_MODULES, pkg);

    // Registry-managed @ant package already materialized by bun install → leave it.
    if (existsSync(join(pkgDir, "package.json"))) {
      skippedInstalled++;
      continue;
    }

    if (content == null) {
      skippedNoContent++;
      continue;
    }

    // Guard against any residual "../" escaping the package directory.
    const file = resolve(pkgDir, rest);
    if (!file.startsWith(pkgDir + sep)) {
      console.error(`refusing to write outside package dir: ${src}`);
      process.exit(1);
    }

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");

    if (!restored.has(pkg)) restored.set(pkg, []);
    restored.get(pkg).push(file);
  }

  console.log("Restored internal @ant packages from package/cli.js.map:");
  if (restored.size === 0) {
    console.log("  (none — node_modules already complete)");
  } else {
    for (const [pkg, files] of [...restored.entries()].sort()) {
      console.log(`  ${pkg}  (${files.length} file${files.length === 1 ? "" : "s"})`);
    }
  }
  const total = [...restored.values()].reduce((n, f) => n + f.length, 0);
  console.log(
    `  total ${total} file${total === 1 ? "" : "s"}, ` +
      `${skippedNonInternal} non-internal skipped, ` +
      `${skippedInstalled} installed skipped, ${skippedNoContent} with no content skipped`
  );

  if (total === 0 && skippedNonInternal === 0) {
    console.warn("warning: no node_modules sources were found in the map at all");
  }
}

main();
