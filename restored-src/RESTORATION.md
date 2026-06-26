# Restoration Notes

This repository is a source-restored tree. It is useful for reading and
analysis, but it should not be treated as a complete upstream source checkout.
Any change that makes the tree runnable must preserve that distinction.

## Goal

The goal of restoration work is a minimum runnable local development path, not
to create a new product fork.

Minimum restoration means:

- keep the original source shape understandable;
- make the primary CLI path start and fail clearly;
- label every reconstructed placeholder;
- avoid silently pretending unrecovered features work;
- keep product features, provider proxies, desktop apps, and IM integrations out
  of the minimum restoration layer.

## Layers

Think of the work in layers. A fix belongs in the lowest layer that explains
why it exists.

### Runtime Shim

Use this for values that were provided by the original build or package runtime,
but are absent when running restored source directly.

Examples:

- CLI wrapper script;
- Bun preload file;
- `MACRO.VERSION` and related build constants;
- working-directory handoff from wrapper to source entrypoint.

These shims are acceptable when they are small, explicit, and easy to delete if
a real build pipeline is recovered.

Current local shim:

- `bin/claude` preserves the caller's original working directory, then
  executes the restored CLI from the repository root.
- `bunfig.toml` preloads `preload.ts`.
- `preload.ts` provides missing `MACRO.*` build constants. It should not grow
  a parallel runtime configuration system.
- `MACRO.VERSION` defaults to `2.1.88 restored-src`: the recovered upstream
  version plus a visible source-restoration marker.
- `DISABLE_AUTOUPDATER` defaults to `1` because this local runtime is not an
  installable upstream package and should not query npm for update checks.
- `CLAUDE_CONFIG_DIR` defaults to the repo-local `.claude` directory so this
  restored runtime uses `.claude/settings*.json` through Claude Code's native
  settings loader without implicitly loading unrelated global plugins and hooks.
  Set `CLAUDE_CONFIG_DIR` explicitly to debug a different config root.

Local API/provider environment variables belong in `.claude/settings.local.json`
under the standard `env` field. This keeps credentials in the repo-local Claude
config directory and avoids a restoration-only `config.json` convention.

### Resource Placeholder

Use this when restored code imports a resource file that is missing from the
source tree, such as a Markdown skill file, prompt text file, or type-only
module.

Rules:

- add the narrowest file needed;
- put a restoration note at the top when the file format allows comments;
- avoid inventing behavior beyond the import contract;
- prefer empty or minimal content over speculative content.

### Optional Native Fallback

Use this when the original runtime expected a native package that is not
available in local restoration.

Rules:

- catch only the optional dependency boundary;
- return a conservative disabled value;
- do not hide errors from non-optional logic;
- document which native package is missing.

Example:

```ts
/**
 * Restoration fallback.
 *
 * The original runtime may load modifiers-napi on macOS. The restored source
 * does not require that native package for the primary CLI path, so failure to
 * load it is treated as "modifier not pressed".
 */
export function isModifierPressed(modifier: ModifierKey): boolean {
  if (process.platform !== 'darwin') return false
  try {
    const { isModifierPressed: nativeIsModifierPressed } =
      require('modifiers-napi') as { isModifierPressed: (m: string) => boolean }
    return nativeIsModifierPressed(modifier)
  } catch {
    return false
  }
}
```

### Dependency Repair

Prefer faithful dependency repair over stubbing. A `paths` alias to `stubs/*`
is a last resort, not the default way to make imports pass.

Rules:

- For real open-source packages, restore the official package contents from the
  exact package version instead of replacing the package with a local stub.
- If the local `node_modules` package has mismatched metadata and source
  contents, treat it as an install/cache restoration problem and repair the
  package. Do not preserve the mismatch behind a stub.
- If a package name is a public placeholder or reserved package but this repo
  already contains a real TypeScript replacement, alias to that implementation
  and verify it.
- If an internal package has recovered source files under `node_modules`, first
  try to connect its real source entrypoint and verify the import surface.
- Use a fail-fast internal-feature stub only when the original implementation
  is genuinely unrecovered or the recovered source cannot be made to load
  without inventing behavior.

Current dependency decisions:

- `chalk`: restore the official `chalk@5.6.2` package contents. Do not use a
  `chalk` stub; the real package provides terminal styling and `Chalk`.
- `ansi-styles`: restore the official package contents, as with `chalk`. Do not
  use a local stub for normal terminal color support.
- `is-stream`: restore the official package contents so dependencies such as
  `execa` receive the named stream helpers they import.
- `@growthbook/growthbook`: restore the real open-source package. If remote
  feature flags are intentionally disabled for a local run, make that policy
  explicit outside the package instead of silently replacing GrowthBook with a
  no-network fake.
- `color-diff-napi`: do not use an empty renderer stub. The public package is a
  placeholder, while this tree contains a real TypeScript replacement at
  `src/native-ts/color-diff/index.ts`; alias to that implementation and verify
  syntax highlighting/diff rendering.
- `@ant/claude-for-chrome-mcp`: this is an internal package. Recovered source
  files exist under `node_modules/@ant/claude-for-chrome-mcp/src`; connect
  `src/index.ts` and verify the exported surface first. Fall back to a
  fail-fast internal-feature stub only if the recovered source is incomplete or
  cannot load without fabricating behavior.

### Internal Feature Stub

Use this only when a module is imported by restored code but the original
implementation was not recovered and the code path is believed to be gated
behind an internal or disabled feature.

The stub must fail fast if executed. Do not use universal proxy stubs that make
every property and function appear to work.

Preferred shape:

```ts
/**
 * Restoration stub.
 *
 * This module was referenced by restored source, but its original
 * implementation was not recovered. It is expected to be reachable only behind
 * an internal feature gate. If this code path executes locally, fail fast so the
 * missing feature is visible.
 */
export const __restorationStub = true

export function unavailableInternalFeature(): never {
  throw new Error(
    'unavailableInternalFeature is not available in restored-src: original implementation was not recovered.',
  )
}
```

Avoid this shape:

```ts
const stub: any = new Proxy(function noop() {}, {
  get() {
    return stub
  },
  apply() {
    return stub
  },
})
```

That pattern can make missing functionality look successful and turns a precise
restoration gap into a later behavioral bug.

### Product Fork

These are not minimum restoration:

- desktop shell;
- local server;
- H5 remote access;
- IM adapters;
- model-provider proxy;
- scheduled-task product flows;
- release infrastructure;
- large new command surfaces.

They may be useful in a separate fork, but they should not be mixed into the
restoration layer unless the explicit goal changes.

## Minimum Runnable Path

The first target should be the smallest verifiable path:

```text
wrapper -> Bun preload -> src/entrypoints/cli.tsx -> src/main.tsx -> --version
```

Then expand only one boundary at a time:

```text
--help
print mode
interactive TUI startup
authentication/config discovery
single prompt request
basic tool execution
```

Each expansion should have a small command that proves the boundary works.

Current verified boundaries:

```bash
./bin/claude --version
./bin/claude --help
bun -e "await import('./src/cli/print.ts'); console.log('print import ok')"
env -u NO_COLOR FORCE_COLOR=1 bun -e "await import('./src/screens/REPL.tsx'); console.log('REPL imported')"
./bin/claude --bare -p --max-turns 1 'Respond exactly: RESTORED_OK'
```

The first three commands complete locally. The print-mode command now reaches
the real `/v1/messages` request path. In the latest local run, the runtime
started, loaded zero repo-local plugins, imported `src/cli/print.ts`, entered
`runHeadless`, issued a request to the provider configured by `.claude`
settings, and returned `RESTORED_OK` on stdout.

Interactive REPL/TUI has also been verified through tmux. The prior apparent
trust-dialog hang was caused by `src/screens/REPL.tsx` failing during module
load because `src/commands/ultraplan.tsx` required the missing text resource
`src/utils/ultraplan/prompt.txt`. The restored tree now includes a narrow
placeholder for that resource so the command module can load without inventing
the unrecovered Ultraplan prompt. A tmux run using a fresh `CLAUDE_CONFIG_DIR`
successfully accepted onboarding and workspace trust, rendered the REPL prompt,
submitted `看看这个文件夹下有什么，简单概括一下，不要改文件。`, reached
`/anthropic/v1/messages`, ran directory-inspection tools, and returned a
visible directory summary in the TUI.

For shorter diagnostic runs without changing `.claude/settings.local.json`,
override only the timeout:

```bash
API_TIMEOUT_MS=30000 \
./bin/claude --bare -p --max-turns 1 'Respond exactly: RESTORED_OK'
```

## Comment Tags

Use consistent wording so restoration edits are searchable.

Recommended tags:

- `Restoration shim`: runtime support for local source execution.
- `Restoration placeholder`: missing non-code resource or type-only surface.
- `Restoration fallback`: optional dependency degradation.
- `Restoration stub`: unrecovered implementation that must fail fast.

Example:

```ts
/**
 * Restoration placeholder.
 *
 * The restored source imports this type-only module, but the original file was
 * not recovered. Keep this intentionally narrow; do not add runtime behavior
 * here.
 */
```

## Quality Bar

A restoration change is acceptable only if it answers these questions:

- What exact runtime or import failure does it fix?
- Is this needed for the primary CLI path?
- Is the implementation real, placeholder, fallback, or stub?
- If it is a stub, does it fail fast when executed?
- Is the comment clear enough that a future reader will not mistake it for
  original upstream code?
- Can it be verified with one small command?

## Non-Goals

Do not try to make every restored import "work" by default. A missing internal
module is useful evidence. The right behavior is often to preserve that evidence
and make the failure readable.

Do not use broad fallback chains to mask missing dependencies, network failures,
or feature-gate mistakes. Prefer a clear error at the first false assumption.

Do not copy a runnable fork wholesale. Use runnable forks as evidence for
failure points, then reimplement only the minimum restoration fix with explicit
labels.
