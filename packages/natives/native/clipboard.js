import { loadNative } from "./loader-state.js";

/** Copy text to the clipboard, loading the native addon on first use. */
export function copyToClipboard(text) {
	return loadNative().copyToClipboard(text);
}

/** Read an image from the clipboard, loading the native addon on first use. */
export function readImageFromClipboard() {
	return loadNative().readImageFromClipboard();
}
