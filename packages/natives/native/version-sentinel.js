/**
 * Addon release-identity helpers shared by the native loader, the embed
 * pipeline, and the post-link stamp tool (`scripts/stamp-native-version.ts`).
 *
 * Kept in its own module so `scripts/embed-native.ts` can reuse them without
 * importing `loader-state.js` — which pulls in the generated
 * `embedded-addon.js` and its `with { type: "file" }` archive import. That
 * chain fails to resolve when the archive is missing, which would break
 * `gen:native:reset` on an inconsistent tree (populated manifest, deleted
 * archive) before it can restore the checked-in null stub.
 *
 * Current addons carry a fixed-size stamp slot (`VERSION_STAMP_MAGIC` + the
 * release version + NUL padding) written after linking and reported by
 * `__piNativesBuildVersion()`. Addons published before that exported a
 * per-release `__piNativesV{major}_{minor}_{patch}` function instead; those
 * are still recognized so an old module resident across an in-place upgrade
 * is diagnosed correctly.
 */

/** Prefix of the stamp slot linked into every addon (`crates/pi-natives/src/lib.rs`). */
export const VERSION_STAMP_MAGIC = "PI_NATIVES_VERSION_STAMP:";

/** Total stamp slot size in bytes: magic, version, NUL padding. */
export const VERSION_STAMP_SIZE = 64;

/** Export names of pre-stamp releases (`__piNativesV18_3_2`). */
const LEGACY_SENTINEL_RE = /^__piNativesV([A-Za-z0-9_]+)$/;

/**
 * Check whether addon bytes carry the stamp for exactly `version` (a stamp for
 * `18.1.10` must not satisfy a lookup for `18.1.1`, so the version must be
 * followed by the slot's NUL padding).
 * @param {Uint8Array} bytes
 * @param {string} version
 * @returns {boolean}
 */
export function containsVersionStamp(bytes, version) {
	if (version.length === 0) return false;
	const needle = Buffer.from(`${VERSION_STAMP_MAGIC}${version}\0`, "utf8");
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(needle) !== -1;
}

/**
 * Release version a loaded addon reports: the post-link stamp for current
 * addons, the legacy sentinel export name for pre-stamp releases, `null` for
 * unstamped builds and addons that predate both.
 * @param {Record<string, unknown>} bindings
 * @returns {string | null}
 */
export function bindingsReleaseVersion(bindings) {
	const report = bindings.__piNativesBuildVersion;
	if (typeof report === "function") {
		try {
			const version = report();
			return typeof version === "string" && version.length > 0 ? version : null;
		} catch {
			return null;
		}
	}
	for (const key of Object.keys(bindings)) {
		const match = LEGACY_SENTINEL_RE.exec(key);
		if (match) return match[1].replace(/_/g, ".");
	}
	return null;
}

/**
 * True when the bindings identify their release at all (stamp reader or
 * legacy sentinel), i.e. they are not a pre-sentinel addon.
 * @param {Record<string, unknown>} bindings
 * @returns {boolean}
 */
export function bindingsHaveReleaseIdentity(bindings) {
	return (
		typeof bindings.__piNativesBuildVersion === "function" ||
		Object.keys(bindings).some(key => LEGACY_SENTINEL_RE.test(key))
	);
}
