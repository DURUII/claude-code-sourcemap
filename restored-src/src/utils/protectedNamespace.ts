/**
 * Restoration shim.
 *
 * The real module carries Anthropic's internal namespace allowlist and was
 * DCE'd out of external builds — the sourcemap this tree was restored from is
 * effectively an external build, so it never made it across.
 *
 * src/utils/envUtils.ts:isInProtectedNamespace() `require`s this module when
 * `process.env.USER_TYPE === 'ant'`, so a `USER_TYPE=ant` launch dies at the
 * first call without it.
 *
 * Returning false is the external-build answer and the correct one for a
 * laptop: protected namespaces are Anthropic's CI/dev containers, recognised
 * via k8s/COO signals that a local machine does not have. See the doc comment
 * on isInProtectedNamespace() in src/utils/envUtils.ts for the full criteria.
 */
export function checkProtectedNamespace(): boolean {
  return false
}
