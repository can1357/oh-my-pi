import { adaptDesktopSession } from "./desktop-adapter.js";
import { loadNative, missingNativeExport } from "./loader-state.js";

let DesktopSession;

/**
 * Construct a desktop session without loading the native addon until the
 * computer worker receives its initialization message.
 */
export function createDesktopSession(options) {
	DesktopSession ??= adaptDesktopSession(loadNative().DesktopSession);
	return new DesktopSession(options);
}

// A stale workspace addon lacks the Escape exports; fall back to the stub
// `native/index.js` exports in their place, which names the rebuild.

/** Physical-Escape stops counted under `key`, loading the native addon on first use. */
export function desktopEscapeStops(key) {
	return (loadNative().desktopEscapeStops ?? missingNativeExport("desktopEscapeStops"))(key);
}

/** Drop the stop count kept under `key`. */
export function forgetDesktopEscapeStops(key) {
	(loadNative().forgetDesktopEscapeStops ?? missingNativeExport("forgetDesktopEscapeStops"))(key);
}

/** Invalidate this process's event taps before it exits (see the native doc). A stale
 * workspace addon without the export holds no such taps. */
export function closeDesktopEventTaps() {
	loadNative().closeDesktopEventTaps?.();
}
