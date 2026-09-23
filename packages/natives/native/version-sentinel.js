/**
 * Version-sentinel helpers shared by the native loader and the embed pipeline.
 *
 * Kept in its own module so `scripts/embed-native.ts` can reuse the exact-match
 * logic without importing `loader-state.js` — which pulls in the generated
 * `embedded-addon.js` and its `with { type: "file" }` archive import. That
 * chain fails to resolve when the archive is missing, which would break
 * `gen:native:reset` on an inconsistent tree (populated manifest, deleted
 * archive) before it can restore the checked-in null stub.
 */

/**
 * Return the version sentinel exported by an addon built for `packageVersion`.
 * @param {string} packageVersion
 * @returns {string}
 */
export function versionSentinelFor(packageVersion) {
	return `__piNativesV${packageVersion.replace(/[^A-Za-z0-9]/g, "_")}`;
}

/**
 * Check for an exact version sentinel rather than a longer sentinel with the
 * expected value as its prefix (e.g. `__piNativesV18_1_10` must not satisfy a
 * lookup for `__piNativesV18_1_1`).
 * @param {Buffer} bytes
 * @param {string} expected
 * @returns {boolean}
 */
export function containsVersionSentinel(bytes, expected) {
	if (expected.length === 0) return false;
	let offset = 0;
	while (offset < bytes.length) {
		const index = bytes.indexOf(expected, offset);
		if (index === -1) return false;
		const next = bytes[index + expected.length];
		const isIdentifierByte =
			next === 95 || (next >= 48 && next <= 57) || (next >= 65 && next <= 90) || (next >= 97 && next <= 122);
		if (!isIdentifierByte) return true;
		offset = index + expected.length;
	}
	return false;
}
