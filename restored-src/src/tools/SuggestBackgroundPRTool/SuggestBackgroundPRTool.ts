/**
 * Restoration shim.
 *
 * SuggestBackgroundPRTool is ant-only and was tree-shaken out of the sourcemap
 * this tree was restored from — the whole directory is absent. src/tools.ts
 * pulls it in through a runtime `require` gated on
 * `process.env.USER_TYPE === 'ant'`, so without this file any `USER_TYPE=ant`
 * launch dies at module-evaluation time with "Cannot find module".
 *
 * Exporting null keeps the gate honest: the tool is simply absent from the
 * tool list (see the `SuggestBackgroundPRTool ? [...] : []` spread in
 * src/tools.ts).
 */
export const SuggestBackgroundPRTool = null
