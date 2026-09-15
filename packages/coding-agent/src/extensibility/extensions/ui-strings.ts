/**
 * Process-wide registry for extension-provided UI string overrides.
 *
 * Extensions call `registerUiStrings` at load time to provide
 * localized labels, descriptions, tab labels, group names, and
 * chrome strings. The registry is cleared on extension reload or
 * disable so stale strings never persist.
 *
 * All methods are synchronous and thread-safe for single-threaded
 * Node.js use.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single localized string mapped to a stable key. */
export interface UiStringEntry {
	/** Stable key; must not be empty. */
	key: string;
	/** Localized string; empty strings are rejected. */
	value: string;
}

/** Set of overrides submitted by one extension. */
export type UiStringMap = Record<string, string>;

/** Shape of the `registerUiStrings` payload. */
export interface UiStringsRegistration {
	/** Free-form key-value pairs for setting label / description / chrome. */
	strings: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Internal registry
// ---------------------------------------------------------------------------

/** Flat map of every registered override: `key → value`.
 *  When multiple extensions register the same key, the last one wins. */
const registry = new Map<string, string>();

/** Per-extension tracking so we can flush one extension at a time. */
const tracked = new Map</* extensionPath */ string, Set<string>>();

/** Reverse map: key → owners (extensions that registered this key).
 *  Used by clearUiStringsFor to avoid deleting a key that another
 *  extension still owns. */
const keyOwners = new Map<string, Set<string>>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register UI string overrides.
 *
 * @param entry - Map of string keys to localized values.
 * @param extensionPath - Identifies the caller for lifecycle management.
 *
 * Keys must be non-empty, values must not be empty (empty is silently
 * skipped rather than rejected — this lets partial registrations work).
 * Later registrations overwrite earlier ones for the same key.
 */
export function registerUiStrings(
	entry: UiStringsRegistration,
	extensionPath: string,
): void {
	if (!entry || typeof entry !== "object") return;
	const strings = entry.strings;
	if (!strings || typeof strings !== "object") return;

	const keys = tracked.get(extensionPath) ?? new Set<string>();
	let dirty = false;

	for (const [key, value] of Object.entries(strings)) {
		// Skip empty keys and empty values — partial registration is OK.
		if (!key || typeof key !== "string" || key.trim() === "") continue;
		if (value == null || (typeof value === "string" && value.trim() === "")) continue;

		registry.set(key, value);
		keys.add(key);

		// Track ownership: add this extension to the key's owner set.
		let owners = keyOwners.get(key);
		if (!owners) {
			owners = new Set<string>();
			keyOwners.set(key, owners);
		}
		owners.add(extensionPath);

		dirty = true;
	}

	if (dirty) {
		tracked.set(extensionPath, keys);
	}
}

/**
 * Clear all UI strings registered by the given extension.
 * Called when an extension is disabled, unloaded, or reloaded.
 *
 * Only removes keys that are exclusively owned by this extension.
 * If another extension also claimed the same key, the value persists
 * (the other extension's registration is preserved).
 */
export function clearUiStringsFor(extensionPath: string): void {
	const keys = tracked.get(extensionPath);
	if (!keys) return;

	for (const key of keys) {
		// Remove this extension from the owner set.
		const owners = keyOwners.get(key);
		if (owners) {
			owners.delete(extensionPath);
			// Only delete from registry if no one else owns it.
			if (owners.size === 0) {
				registry.delete(key);
				keyOwners.delete(key);
			}
		} else {
			// Unreachable: if key is in tracked, it must be in keyOwners.
			registry.delete(key);
		}
	}

	tracked.delete(extensionPath);
}

/**
 * Clear the entire registry. Used during global teardown.
 */
export function clearAll(): void {
	registry.clear();
	tracked.clear();
	keyOwners.clear();
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a UI string: look up the override first, fall back to `fallback`.
 *
 * This function is the single accessor consumed by `settings-defs.ts` and
 * `settings-selector.ts`. When no override is registered for `key`, the
 * original `fallback` value is returned unchanged.
 */
export function resolveUiString(key: string, fallback: string): string {
	const override = registry.get(key);
	return override ?? fallback;
}
