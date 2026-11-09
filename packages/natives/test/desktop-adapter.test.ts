import { afterEach, describe, expect, it, vi } from "bun:test";
import { adaptDesktopSession } from "../native/desktop-adapter.js";
import { desktopEscapeStops, forgetDesktopEscapeStops } from "../native/desktop.js";
import * as loaderState from "../native/loader-state.js";

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

	it("rejects an addon built before the turn-scoped display hold", () => {
		const Stale = adaptDesktopSession(class {});
		expect(() => new Stale({ display: "active" })).toThrow(/holdDisplayUntilReleased, releaseDisplayAwake/);
	});

	it("rejects an addon built before the Escape stop count", () => {
		// Every method present, so only the getter can decide; without it the worker reads each run as stopped.
		const prototype = (escapeStops: boolean) =>
			new Proxy(
				{},
				{
					get: () => () => {},
					has: (_target, key) => escapeStops || key !== "escapeStops",
				},
			);
		const Current = { prototype: prototype(true) };
		expect<unknown>(adaptDesktopSession(Current)).toBe(Current);
		const Stale = adaptDesktopSession({ prototype: prototype(false) });
		expect(() => new Stale({ display: "active" })).toThrow(/^Unsupported: .*\(missing escapeStops\)/);
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
