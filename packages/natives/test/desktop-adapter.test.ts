import { describe, expect, it } from "bun:test";
import { adaptDesktopSession } from "../native/desktop-adapter.js";

describe("desktop native ABI requirements", () => {
	it.each([
		["missing desktop export", undefined],
		[
			"legacy execute ABI",
			class {
				execute() {}
			},
		],
		[
			"pre-zoom ABI",
			class {
				click() {}
				cancel() {}
			},
		],
		[
			"uncancellable ABI",
			class {
				click() {}
				captureRegion() {}
			},
		],
	])("defers rejection of %s until desktop use without constructing the addon", (_label, NativeSession) => {
		// Importing the shared native module must remain safe for non-desktop tools.
		const DesktopSession = adaptDesktopSession(NativeSession);
		expect(() => new DesktopSession({ display: "active" })).toThrow(/^Unsupported:/);
	});

	it("rejects an addon built before axSelectText by name", () => {
		const NativeSession = class {};
		for (const method of [
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
		]) {
			Object.defineProperty(NativeSession.prototype, method, { value() {} });
		}
		const DesktopSession = adaptDesktopSession(NativeSession);
		expect(() => new DesktopSession({ display: "active" })).toThrow("missing axSelectText");
	});
});
