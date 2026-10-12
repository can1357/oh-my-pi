const REQUIRED_METHODS = [
	"click",
	"capture",
	"captureRegion",
	"cancel",
	"retire",
	"observe",
	"listApplications",
	"openApplication",
	"menuItems",
	"menuSelect",
	"holdKeys",
	"holdMouse",
	"acquireControl",
	"releaseControl",
	"controlState",
	"bringToCurrentSpace",
];

/** Reject incomplete native ABIs on first desktop use without unsafe fallbacks. */
export function adaptDesktopSession(NativeDesktopSession) {
	if (NativeDesktopSession === undefined) {
		return undefined;
	}
	const prototype = NativeDesktopSession?.prototype;
	const missing = REQUIRED_METHODS.filter(method => typeof prototype?.[method] !== "function");
	if (missing.length === 0) {
		return NativeDesktopSession;
	}
	// The shared native entrypoint is also imported by non-desktop tools. Keep
	// their imports usable, but never emulate the new ABI with unsafe fallbacks.
	return class UnsupportedDesktopSession {
		constructor() {
			throw new Error(
				`Unsupported: desktop native addon is outdated (missing ${missing.join(", ")}). Update the native addon or run bun run build:native from the repository root.`,
			);
		}
	};
}
