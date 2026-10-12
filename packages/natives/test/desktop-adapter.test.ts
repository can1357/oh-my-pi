import { describe, expect, it } from "bun:test";
import { adaptDesktopSession } from "../native/desktop-adapter.js";

describe("desktop native ABI requirements", () => {
	it("rejects a present class with an incomplete ABI when constructing a desktop session", () => {
		class NativeSession {
			click() {}
		}
		const DesktopSession = adaptDesktopSession(NativeSession);
		expect(() => new DesktopSession({ display: "active" })).toThrow(
			/^Unsupported: desktop native addon is outdated \(missing capture,/,
		);
	});
});
