import { afterEach, describe, expect, it, vi } from "bun:test";
import { adaptDesktopSession } from "../native/desktop-adapter.js";
import { desktopEscapeStops, forgetDesktopEscapeStops } from "../native/desktop.js";
import * as loaderState from "../native/loader-state.js";

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

	it("rejects an addon built before the turn-scoped display hold", () => {
		const Stale = adaptDesktopSession(class {});
		expect(() => new Stale({ display: "active" })).toThrow(/holdDisplayUntilReleased, releaseDisplayAwake/);
	});

	it("rejects an addon built before the Escape stop count", () => {
		// Every method is present, so only the getter decides; without it the worker reads each run as stopped.
		const methods = new Proxy(
			{},
			{
				get: () => () => {},
				has: (_target, key) => key !== "escapeStops",
			},
		);
		class NativeSession {}
		Object.setPrototypeOf(NativeSession.prototype, methods);
		class Current extends NativeSession {
			get escapeStops() {
				return 0;
			}
		}
		expect<unknown>(adaptDesktopSession(Current)).toBe(Current);
		class Stale extends NativeSession {}
		expect(() => new (adaptDesktopSession(Stale))({ display: "active" })).toThrow(
			/^Unsupported: .*\(missing escapeStops\)/,
		);
	});
});

describe("lazy desktop exports", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("report a stale addon's missing Escape exports with the stale-addon stub", () => {
		// A workspace addon built before the Escape exports, which the loader tolerates as stale.
		const missingNativeExport = loaderState.missingNativeExport;
		const stale = {
			path: "/w/packages/natives/native/pi_natives.darwin-arm64.node",
			version: "18.8.7",
			packageVersion: "18.12.1",
			stale: true,
		};
		vi.spyOn(loaderState, "loadNative").mockReturnValue({});
		vi.spyOn(loaderState, "missingNativeExport").mockImplementation(name => missingNativeExport(name, stale));
		for (const [name, call] of [
			["desktopEscapeStops", () => desktopEscapeStops("k")],
			["forgetDesktopEscapeStops", () => forgetDesktopEscapeStops("k")],
		] as const) {
			expect(call).toThrow(`\`${name}\` is missing`);
			expect(call).toThrow("bun run build:native");
		}
	});
});
