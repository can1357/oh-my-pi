import { loadNative } from "./loader-state.js";

/** Copy text to the clipboard, loading the native addon on first use. */
export function copyToClipboard(text) {
	return loadNative().copyToClipboard(text);
}

/** Copy text and keep serving it until clipboard ownership changes. */
export function copyToClipboardPersistent(text) {
	/** @type {{ copyToClipboardPersistent(text: string): void }} */
	const native = loadNative();
	native.copyToClipboardPersistent(text);
}

/** Read an image from the clipboard, loading the native addon on first use. */
export function readImageFromClipboard() {
	return loadNative().readImageFromClipboard();
}
