/**
 * Order-sensitive equality for optional string arrays, treating `undefined`
 * and `[]` as distinct.
 *
 * Used where a rule/setting field is compared across a reload to decide whether
 * anything actually moved: the arrays are rebuilt by the reload, so an identity
 * compare reports a change every time.
 */
export function stringArrayEqual(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.length !== b.length) return false;
	return a.every((value, index) => value === b[index]);
}
