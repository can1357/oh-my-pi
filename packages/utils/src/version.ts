const DIGITS = /^\d+$/;

/**
 * Compare two version strings.
 *
 * Canonical comparator that supersedes the historical in-repo copies
 * (update-cli, hackage scraper, release scripts):
 * - inputs are trimmed and at most one leading `v`/`V` is stripped
 * - dot-separated segments are compared numerically, missing trailing
 *   segments count as 0, so `1.2` === `1.2.0` and any segment count works
 * - a SemVer-2.0 prerelease suffix sorts before the plain release
 *   (`1.0.0-beta` < `1.0.0`); prerelease identifiers follow SemVer order
 *   (numeric < alphanumeric, numeric compared by value, alphanumeric
 *   compared lexically, longer sets of equal fields win)
 * - SemVer build metadata begins at the first `+` and does not participate
 *   in precedence; it is stripped before core/prerelease parsing
 * - malformed numeric segments compare as 0 (`1.2.x` === `1.2.0`)
 * - never throws; returns only -1 | 0 | 1
 */
export function compareVersions(a: string, b: string): number {
	const pa = parseVersion(a);
	const pb = parseVersion(b);

	const core = compareNumericParts(pa.core, pb.core);
	if (core !== 0) return core;

	return comparePrerelease(pa.prerelease, pb.prerelease);
}

interface ParsedVersion {
	core: string[];
	prerelease: string[] | null;
}

function parseVersion(version: string): ParsedVersion {
	const trimmed = version.trim();
	const stripped = trimmed.startsWith("v") || trimmed.startsWith("V") ? trimmed.slice(1) : trimmed;
	const plusIndex = stripped.indexOf("+");
	const withoutBuild = plusIndex === -1 ? stripped : stripped.slice(0, plusIndex);
	const dashIndex = withoutBuild.indexOf("-");
	if (dashIndex === -1) {
		return { core: withoutBuild.split("."), prerelease: null };
	}
	return {
		core: withoutBuild.slice(0, dashIndex).split("."),
		prerelease: withoutBuild.slice(dashIndex + 1).split("."),
	};
}

/** Compare dot-separated numeric segments; missing/malformed segments count as 0. */
function compareNumericParts(a: string[], b: string[]): number {
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i++) {
		// Missing or malformed segments compare as 0.
		const sa = a[i];
		const sb = b[i];
		const result = compareDigits(
			sa !== undefined && DIGITS.test(sa) ? sa : "0",
			sb !== undefined && DIGITS.test(sb) ? sb : "0",
		);
		if (result !== 0) return result;
	}
	return 0;
}

/** Exact integer comparison of digit strings, avoiding float overflow. */
function compareDigits(a: string, b: string): number {
	const na = a.replace(/^0+/, "") || "0";
	const nb = b.replace(/^0+/, "") || "0";
	if (na.length !== nb.length) return na.length < nb.length ? -1 : 1;
	if (na < nb) return -1;
	if (na > nb) return 1;
	return 0;
}

/** SemVer-2.0 prerelease ordering; null means a plain release, which wins. */
function comparePrerelease(a: string[] | null, b: string[] | null): number {
	if (a === null || b === null) {
		return a === b ? 0 : a === null ? 1 : -1;
	}
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i++) {
		const ia = a[i];
		const ib = b[i];
		if (ia === undefined) return -1;
		if (ib === undefined) return 1;
		const aNumeric = DIGITS.test(ia);
		const bNumeric = DIGITS.test(ib);
		if (aNumeric && bNumeric) {
			const result = compareDigits(ia, ib);
			if (result !== 0) return result;
		} else if (aNumeric !== bNumeric) {
			return aNumeric ? -1 : 1;
		} else if (ia !== ib) {
			return ia < ib ? -1 : 1;
		}
	}
	return 0;
}
