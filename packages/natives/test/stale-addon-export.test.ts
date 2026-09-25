/**
 * A workspace tree that pulls a release newer than its last
 * `bun run build:native` keeps loading the previous addon: the loader tolerates
 * the sentinel mismatch by design, so every symbol added after that build is
 * absent. The contract pinned here is how that absence surfaces — a bare
 * `undefined` export turned into `<symbol> is not a function` inside whichever
 * tool used it first (every `write` call, after the read-projection guard
 * landed), with nothing naming the stale addon.
 *
 * `missingNativeExport` closes that gap on the stale path only. On a current
 * addon an absent export is not version drift, and callers use exactly that
 * absence as a capability probe, so it must stay `undefined`.
 */
import { describe, expect, it } from "bun:test";
// Side-effect import: loads the real addon, so `nativeAddonStatus()` below
// reflects this tree's build rather than an injected fixture.
import "../native";
import type { NativeAddonStatus } from "../native/loader-state.js";
import { missingNativeExport, missingNativeExportMessage, nativeAddonStatus } from "../native/loader-state.js";

const addonPath = "/w/packages/natives/native/pi_natives.linux-x64-modern.node";

function status(overrides: Partial<NativeAddonStatus> = {}): NativeAddonStatus {
	return {
		path: addonPath,
		sentinel: "__piNativesV18_1_18",
		expectedSentinel: "__piNativesV18_2_6",
		packageVersion: "18.2.6",
		stale: true,
		...overrides,
	};
}

describe("native exports missing from a stale addon", () => {
	it("throws a stub naming the symbol, the addon, both releases, and the rebuild", () => {
		const stub = missingNativeExport("hashlineIsReadTruncationNotice", status());
		expect(typeof stub).toBe("function");
		for (const expected of [
			"hashlineIsReadTruncationNotice",
			addonPath,
			"18.1.18",
			"18.2.6",
			"__piNativesV18_2_6",
			"bun run build:native",
		]) {
			expect(() => stub?.()).toThrow(expected);
		}
	});

	it("reports a pre-sentinel addon without inventing a version", () => {
		const message = missingNativeExportMessage("search", status({ sentinel: null }));
		expect(message).toContain("built before version sentinels existed");
		expect(message).toContain("bun run build:native");
	});

	it("keeps the absence a plain undefined on a current addon", () => {
		const current = status({ sentinel: "__piNativesV18_2_6", stale: false });
		expect(missingNativeExport("macOSSpellCheckerAvailable", current)).toBeUndefined();
		expect(missingNativeExportMessage("macOSSpellCheckerAvailable", current)).toContain(addonPath);
	});

	it("reports the addon it actually loaded, not an assumed one", () => {
		const loaded = nativeAddonStatus();
		expect(loaded).not.toBeNull();
		expect(loaded?.path.endsWith(".node")).toBe(true);
		expect(loaded?.expectedSentinel).toBe(`__piNativesV${loaded?.packageVersion.replace(/[^A-Za-z0-9]/g, "_")}`);
		// Whatever the tree's build state, the flag the stubs branch on must be
		// the one the sentinels imply.
		expect(loaded?.stale).toBe(loaded?.sentinel !== loaded?.expectedSentinel);
	});
});
