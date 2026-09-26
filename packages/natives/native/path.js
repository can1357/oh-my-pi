import { loadNative } from "./loader-state.js";

/** Expand Windows 8.3 components without resolving symlinks or junctions. Load the addon only on Windows. */
export function expandWindowsLongPath(path) {
	return process.platform === "win32" ? loadNative().expandWindowsLongPath(path) : path;
}

/** Get the existing Windows 8.3 spelling. Load the addon only on Windows; preserve paths on other platforms. */
export function getWindowsShortPath(path) {
	return process.platform === "win32" ? loadNative().getWindowsShortPath(path) : path;
}
