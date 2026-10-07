import { describe, expect, it } from "bun:test";
import { adaptDesktopSession } from "../native/desktop-adapter.js";

describe("desktop native ABI requirements", () => {
	it("leaves an absent desktop export unavailable", () => {
		expect(adaptDesktopSession(undefined)).toBeUndefined();
	});

	it.each([
		["null desktop export", null],
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
	])("defers rejection of stale %s until desktop use without constructing the addon", (_label, NativeSession) => {
		const DesktopSession = adaptDesktopSession(NativeSession);
		expect(DesktopSession).toBeDefined();
		if (DesktopSession === undefined) throw new Error("stale desktop exports must not be bypassed");
		expect(() => new DesktopSession({ display: "active" })).toThrow(/^Unsupported:/);
	});
});
