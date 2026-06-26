/**
 * Restoration shim.
 *
 * The original packaged CLI receives MACRO values from its build pipeline.
 * Running restored TypeScript source directly does not have that pipeline, so
 * we provide only the build constants required by the real entrypoints.
 */

// Restoration shim: this runtime is not an installable upstream package.
// Disable the auto-updater by default so the REPL does not query npm for the
// local package placeholder or compare the source-restored display version as
// if it were a released semver build.
process.env.DISABLE_AUTOUPDATER ??= '1'

const version = process.env.CLAUDE_RESTORED_VERSION ?? '2.1.88 restored-src'
const packageUrl =
  process.env.CLAUDE_RESTORED_PACKAGE_URL ?? 'claude-code-restored-src'
const buildTime =
  process.env.CLAUDE_RESTORED_BUILD_TIME ?? new Date(0).toISOString()

Object.assign(globalThis, {
  MACRO: {
    VERSION: version,
    PACKAGE_URL: packageUrl,
    NATIVE_PACKAGE_URL: packageUrl,
    BUILD_TIME: buildTime,
    FEEDBACK_CHANNEL: 'restored-src local runtime',
    VERSION_CHANGELOG: '',
    ISSUES_EXPLAINER:
      'inspect RESTORATION.md; this local runtime is source-restored and not an upstream build',
  },
})

// Restoration shim: wrapper scripts run from the repository root, but the CLI
// should observe the user's original working directory.
if (process.env.CALLER_DIR) {
  process.chdir(process.env.CALLER_DIR)
}
