/**
 * Resolves the scanner's process exit code. Errors outrank changes.
 *
 * Exit-code contract: 1 = a site errored or an import failed (a real failure);
 * 3 = a subsite changed but nothing errored (review needed); 0 = clean.
 * --no-fail-on-change downgrades the changes-only case to 0 so CI fails only
 * on real errors.
 *
 * @param {{ errored: boolean, changed: boolean, noFailOnChange: boolean }} state
 * @returns {0|1|3} 1 = errored, 3 = changed-only, 0 = clean (or change suppressed).
 */
export function exitCodeFor( { errored, changed, noFailOnChange } ) {
	if ( errored ) {
		return 1;
	}
	if ( changed ) {
		return noFailOnChange ? 0 : 3;
	}
	return 0;
}
