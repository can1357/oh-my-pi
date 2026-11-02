const REQUIRED_METHODS = [
	"click",
	"capture",
	"captureRegion",
	"cancel",
	"retire",
	"setRunDeadline",
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
	"axSelectText",
	"holdDisplayUntilReleased",
	"releaseDisplayAwake",
];

/** Getters the computer worker reads; without `escapeStops` it would read every run as stopped by the user's Escape. */
const REQUIRED_GETTERS = ["escapeStops"];

/** Require the current desktop ABI; partial legacy emulation cannot preserve input ownership. */
export function adaptDesktopSession(NativeDesktopSession) {
	const prototype = NativeDesktopSession?.prototype;
	const missing = [
		...REQUIRED_METHODS.filter(method => typeof prototype?.[method] !== "function"),
		...REQUIRED_GETTERS.filter(getter => !prototype || !(getter in prototype)),
	];
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
