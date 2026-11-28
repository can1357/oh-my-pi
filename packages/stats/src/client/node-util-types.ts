/**
 * `node:util/types`' checks pi-utils reads, for the browser bundles that show
 * the dashboard client's code or pi-utils' JSON helpers, which
 * `client-bundle.ts` resolves `node:util/types` to: Bun's browser target gives
 * that module no exports. pi-utils' JSON writer (`stringifyDeepJson`, which
 * the client uses to show a transcript entry of any depth) tells a boxed
 * number, string, boolean or bigint apart by the boxed checks, and its depth
 * check (`nestsDeeperThan`) skips a proxy by {@link isProxy}. Each boxed check
 * reads the internal slot as Node's does, by calling the type's own `valueOf`
 * on the value, so a box from another realm, or one whose prototype changed,
 * is still a box, and any other object is not.
 */

function hasSlot(value: unknown, valueOf: (this: unknown) => unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	try {
		valueOf.call(value);
		return true;
	} catch {
		return false;
	}
}

export function isNumberObject(value: unknown): boolean {
	return hasSlot(value, Number.prototype.valueOf);
}

export function isStringObject(value: unknown): boolean {
	return hasSlot(value, String.prototype.valueOf);
}

export function isBooleanObject(value: unknown): boolean {
	return hasSlot(value, Boolean.prototype.valueOf);
}

export function isBigIntObject(value: unknown): boolean {
	return hasSlot(value, BigInt.prototype.valueOf);
}

/** Always false: a browser has no way to tell a proxy from its target, so the depth check walks it as it walks the target. */
export function isProxy(_value: unknown): boolean {
	return false;
}
