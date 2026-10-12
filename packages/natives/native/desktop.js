import { adaptDesktopSession } from "./desktop-adapter.js";
import { loadNative } from "./loader-state.js";

let DesktopSession;

/**
 * Construct a desktop session without loading the native addon until the
 * computer worker receives its initialization message.
 */
export function createDesktopSession(options) {
	if (DesktopSession === undefined) {
		const NativeDesktopSession = loadNative().DesktopSession;
		if (NativeDesktopSession === undefined) {
			throw new Error("Unsupported: desktop sessions are not supported on this platform.");
		}
		DesktopSession = adaptDesktopSession(NativeDesktopSession);
	}
	return new DesktopSession(options);
}
