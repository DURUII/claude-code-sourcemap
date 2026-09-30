/**
 * Architecture constraints for the restored Claude Code v2.1.88 source snapshot.
 *
 * This config is a RATCHET, not a clean bill of health. Each rule records the
 * violation count measured on 2026-09-30:
 *
 *   severity "error" -> count is 0 today, CI blocks any regression
 *   severity "warn"  -> count is large, CI stays green, baseline must go down
 *
 * Verify with:
 *   npx depcruise src                    # human summary, exit 0 if no errors
 *   npx depcruise --output-type json src # full machine readable graph
 *
 * Measured 2026-09-30 on dependency-cruiser 18.4.0: 2445 modules, 17054
 * dependencies cruised, 7424 warnings, 0 errors, exit code 0.
 *
 * Rationale for every rule, and the numbers, live in tmp/ARCH-RULES.md.
 */
module.exports = {
  forbidden: [
    /* ------------------------------------------------------------------ *
     * L1. No circular dependencies between modules.
     *
     * Why: 52 of the 54 top-level nodes under src/ (37 directories plus the
     * 17 root level modules) sit in a single strongly connected component
     * holding 1941 of 1993 files, i.e. 97.5% of the source. File level cycles
     * are the atoms of that directory level cycle, and a module in a cycle
     * cannot be understood, tested or replaced on its own.
     *
     * Note: dependency-cruiser evaluates rules on the module graph, and its
     * --collapse flag only affects reporters, so a literal "no cycles between
     * directories" rule is not expressible here. File level is the closest
     * enforceable proxy.
     *
     * Status: warn. Baseline 2026-09-30 = 6633 cyclic edges, covering 1254
     * distinct modules (63% of the 1983 cruised under src/). Target: monotone
     * decrease. Cannot become "error" until the graph is a DAG.
     * ------------------------------------------------------------------ */
    {
      name: 'no-circular',
      severity: 'warn',
      comment:
        'Cycle between modules. Baseline 2026-09-30: 6633 cyclic edges over ' +
        '1254 modules. Target: monotone decrease.',

      from: { path: '^src/' },
      to: { circular: true },
    },

    /* ------------------------------------------------------------------ *
     * L2. src/tests is a leaf; production code must not import it.
     *
     * Why: test fixtures are not shipped. A production import of a test
     * helper means the helper is in the wrong place, or the production path
     * is only exercised by tests.
     *
     * Status: error. Baseline 2026-09-30 = 0.
     * ------------------------------------------------------------------ */
    {
      name: 'no-src-to-tests',
      severity: 'error',
      comment:
        'Production code must not import src/tests. Baseline 2026-09-30: 0.',
      from: { path: '^src/', pathNot: '^src/tests/' },
      to: { path: '^src/tests/' },
    },

    /* ------------------------------------------------------------------ *
     * L3. src/utils is a leaf layer, not a hub.
     *
     * Why: src/utils is the most depended-on directory in the repo
     * (components -> utils 731, tools -> utils 645, services -> utils 647).
     * If utils also imports those layers back, no module in the repository
     * is buildable, mockable or reason-about-able in isolation. This is the
     * God Module inversion.
     *
     * Status: warn. Baseline 2026-09-30 = 488, of which 230 go to
     * src/services and 192 to src/tools. Target: 0. Those two are the
     * tractable half; the natural seam is inverting them behind a callback
     * or an event registered by the feature layer at startup.
     * ------------------------------------------------------------------ */
    {
      name: 'utils-not-to-feature-layers',
      severity: 'warn',
      comment:
        'src/utils must not import the feature layers that depend on it. ' +
        'Baseline 2026-09-30: 488. Target: 0.',

      from: { path: '^src/utils/' },
      to: {
        path: '^src/(services|tools|components|commands|screens|coordinator|tasks|bridge|entrypoints)/',
      },
    },

    /* ------------------------------------------------------------------ *
     * L4. The view layer must not reach into the execution layer.
     *
     * Why: src/components is the Ink/React view layer. Importing src/tools or
     * src/services from a component welds the UI to the execution engine, so
     * a component cannot be rendered in a test without the whole agent
     * runtime behind it, and a tool cannot be reused on a different surface.
     *
     * Status: warn. Baseline 2026-09-30 = 303, of which 139 go to
     * src/services, 113 to src/tools and 43 to src/tasks. Target: 0. Start
     * with components -> tools, which has a natural seam in the tool
     * registry: a component should receive a tool's UI metadata through
     * props, not import the tool module.
     * ------------------------------------------------------------------ */
    {
      name: 'components-not-to-execution',
      severity: 'warn',
      comment:
        'src/components must not import src/tools or src/services. ' +
        'Baseline 2026-09-30: 303. Target: 0.',
      from: { path: '^src/components/' },
      to: { path: '^src/(tools|services|coordinator|tasks|bridge)/' },
    },

    /* ------------------------------------------------------------------ *
     * L5. No orphan modules (dead code).
     *
     * Why: a module with no dependencies and no dependents is either dead or
     * reachable only through a dynamic mechanism nobody can grep for. Both
     * are worth a conversation.
     *
     * Status: error, count 0, once the two known non-orphans below are
     * excluded:
     *  - src/entrypoints/** are process entry points, nothing imports them
     *  - src/tools/WorkflowTool/bundled/** are esbuild artifacts, they are
     *    loaded by path at runtime, not by import
     * ------------------------------------------------------------------ */
    {
      name: 'no-orphans',
      severity: 'error',
      comment:
        'Orphan module (no dependencies, no dependents). Excludes process ' +
        'entrypoints and bundled artifacts, which are loaded by path. ' +
        'Baseline 2026-09-30: 0.',
      from: {
        orphan: true,
        path: '^src/',
        pathNot: ['^src/entrypoints/', '^src/tools/WorkflowTool/bundled/'],
      },
      to: {},
    },

    /* ------------------------------------------------------------------ *
     * L6. A package must not be both a prod and a dev dependency.
     *
     * Why: it makes the shipped dependency set ambiguous and makes
     * `npm prune --production` behaviour depend on install order.
     *
     * Status: error. Baseline 2026-09-30 = 0.
     * ------------------------------------------------------------------ */
    {
      name: 'no-duplicate-dep-types',
      severity: 'error',
      comment:
        'Dependency listed as both prod and dev type. Baseline 2026-09-30: 0.',
      from: {},
      to: { moreThanOneDependencyType: true, dependencyTypesNot: ['type-only'] },
    },
  ],

  options: {
    /*
     * tsconfig.json carries the `src/*`, `@ant/*` and `color-diff-napi` path
     * aliases, and moduleResolution "Bundler". Without it:
     *   - 879 `src/...` specifiers never resolve (every path rule below then
     *     silently matches nothing, which is the dangerous failure mode)
     *   - the TypeScript `.js` -> `.ts` import convention never resolves
     * Measured: unresolved import instances drop 1323 -> 449 by adding this.
     */
    tsConfig: { fileName: './tsconfig.json' },

    /*
     * Count type-only (`import type`) edges as dependencies.
     *
     * Default is false, which drops every import TypeScript would elide.
     * With false, src/components/CustomSelect/option-map.ts looks like dead
     * code even though use-select-navigation.ts imports it, because the
     * import is only used in type position. Type coupling is still coupling:
     * it constrains compilation order and it is what makes cycles.
     * Measured effect: deps 14912 -> 17054, orphans 5 -> 1.
     */
    tsPreCompilationDeps: true,

    // Do not walk into node_modules, but do keep the edges to it.
    doNotFollow: { path: 'node_modules' },

    /*
     * enhanced-resolve default in dependency-cruiser is `exportsFields: []`
     * (legacy main-fields behaviour). Honouring the `exports` map together
     * with a realistic condition list is what resolves the 26
     * `@modelcontextprotocol/sdk/*.js` subpath imports.
     * Measured: unresolved drops 250 -> 217 with these two options.
     */
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },

    /*
     * `bundle` is a virtual module injected by the original esbuild build
     * step; it does not exist on disk. Declaring it as a built-in removes
     * 197 spurious "unresolvable" reports.
     */
    builtInModules: { add: ['bundle'] },
  },
};
