/**
 * Restoration shim.
 *
 * The real REPLTool is ant-only and was tree-shaken out of the sourcemap this
 * tree was restored from; only constants.ts and primitiveTools.ts survived.
 * src/tools.ts pulls this module in through a runtime `require` gated on
 * `process.env.USER_TYPE === 'ant'`, so without this file any `USER_TYPE=ant`
 * launch dies at module-evaluation time with "Cannot find module".
 *
 * Exporting null keeps the gate honest: the tool is simply absent from the
 * tool list (see the `process.env.USER_TYPE === 'ant' && REPLTool` spread in
 * src/tools.ts), which is what a build without it would look like anyway.
 */
export const REPLTool = null
