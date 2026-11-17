import { loadNative } from "./loader-state.js";

let bindings;

/**
 * Load the addon on first use, so importing this module (pi-utils' SQLite
 * helpers) costs nothing in processes that never open a database. An addon
 * built before these exports existed (a stale local build, or PR CI, which
 * tests against main's newest addon) yields `undefined`: the store still opens,
 * unprotected, and `ensureSqliteLockShim` reports it.
 */
function native(symbolName) {
	bindings ??= loadNative();
	const value = bindings[symbolName];
	return typeof value === "function" ? value : undefined;
}

/** See `installSqliteLockShim` in `index.d.ts`; `false` from an addon predating it. */
export function installSqliteLockShim() {
	return native("installSqliteLockShim")?.() ?? false;
}

/** See `heldFileKind` in `index.d.ts`; `null` from an addon predating it. */
export function heldFileKind(path) {
	return native("heldFileKind")?.(path) ?? null;
}
