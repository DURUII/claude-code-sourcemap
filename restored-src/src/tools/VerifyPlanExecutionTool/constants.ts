/**
 * Restoration shim.
 *
 * The real constants module travels with the ant-only VerifyPlanExecutionTool,
 * which was tree-shaken out of the sourcemap this tree was restored from.
 * src/utils/permissions/classifierDecision.ts `require`s this module when
 * `process.env.USER_TYPE === 'ant'`, so a `USER_TYPE=ant` launch dies at
 * module-evaluation time without it.
 *
 * The tool itself is absent (src/tools.ts only registers it when
 * CLAUDE_CODE_VERIFY_PLAN === 'true' *and* the real module exists, and it does
 * not), so this name is only ever used as a string to match against — it can
 * never appear in a live tool list.
 */
export const VERIFY_PLAN_EXECUTION_TOOL_NAME = 'VerifyPlanExecution'
