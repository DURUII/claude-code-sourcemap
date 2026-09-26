/**
 * Restoration shim.
 *
 * The real `agentsPlatform` slash command is ant-only and was tree-shaken out
 * of the sourcemap this tree was restored from — the whole directory is
 * absent. src/commands.ts pulls it in through a runtime `require` gated on
 * `process.env.USER_TYPE === 'ant'`, so without this file any `USER_TYPE=ant`
 * launch dies at module-evaluation time with "Cannot find module".
 *
 * `export default null` is what the command list already expects: the
 * destructured value lands in a `[...].filter(Boolean)` array (src/commands.ts),
 * so a null default simply leaves the command unregistered.
 */
export default null
