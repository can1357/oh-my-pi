import { loadNative, missingNativeExportMessage } from "./loader-state.js";

let bindings;

/** Load the addon once; an addon built before these helpers existed fails with rebuild guidance. */
function nativePathFn(symbolName) {
	bindings ??= loadNative();
	const fn = bindings[symbolName];
	if (typeof fn !== "function") throw new Error(missingNativeExportMessage(symbolName));
	return fn;
}

/** Expand Windows 8.3 components without resolving symlinks or junctions. Load the addon only on Windows. */
export function expandWindowsLongPath(path) {
	return process.platform === "win32" ? nativePathFn("expandWindowsLongPath")(path) : path;
}

/** Get the existing Windows 8.3 spelling. Load the addon only on Windows; preserve paths on other platforms. */
export function getWindowsShortPath(path) {
	return process.platform === "win32" ? nativePathFn("getWindowsShortPath")(path) : path;
}
