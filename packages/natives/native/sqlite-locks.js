import { loadNative, missingNativeExportMessage } from "./loader-state.js";

let bindings;

/**
 * Load the addon on first use, so importing this module (pi-utils' SQLite
 * helpers) costs nothing in processes that never open a database; an addon
 * built before these helpers existed fails with rebuild guidance.
 */
function native(symbolName) {
	bindings ??= loadNative();
	const value = bindings[symbolName];
	if (typeof value !== "function") throw new Error(missingNativeExportMessage(symbolName));
	return value;
}

/** See `installSqliteLockShim` in `index.d.ts`. */
export function installSqliteLockShim() {
	return native("installSqliteLockShim")();
}

/** See `heldFileKind` in `index.d.ts`. */
export function heldFileKind(path) {
	return native("heldFileKind")(path);
}
