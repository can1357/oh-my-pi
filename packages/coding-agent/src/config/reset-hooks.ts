/**
 * Reset hooks for modules that pin their own reference to the `Settings`
 * singleton.
 *
 * Clearing the singleton is not enough on its own: a module that captured the
 * old object keeps reading from it forever. `capability/index.ts` does exactly
 * that via `initializeWithSettings`, so a test that disabled an extension leaked
 * its `disabledExtensions` filter into every later file in the same process —
 * and test buckets share one process.
 *
 * This module deliberately imports NOTHING. `config/settings.ts` and
 * `capability/index.ts` both depend on it, and a direct edge between those two
 * is a cycle: `capability/index` → `config/settings` → … → `capability/settings`
 * → `capability/index`, which trips a TDZ `ReferenceError: Cannot access
 * 'capabilities' before initialization` at import time. Routing through a leaf
 * module keeps the graph acyclic.
 */

const settingsResetHooks = new Set<() => void>();

/** Register a callback invoked whenever the settings singleton is reset for tests. */
export function registerSettingsResetHook(hook: () => void): void {
	settingsResetHooks.add(hook);
}

/** Invoke every registered reset hook. Called by `resetSettingsForTest()`. */
export function runSettingsResetHooks(): void {
	for (const hook of settingsResetHooks) {
		hook();
	}
}
