/**
 * A workspace tree that pulls a release newer than its last
 * `bun run build:native` keeps loading the previous addon: the loader tolerates
 * the release mismatch by design, so every symbol added after that build is
 * absent. The contract pinned here is how that absence surfaces — a bare
 * `undefined` export turned into `<symbol> is not a function` inside whichever
 * tool used it first (every `write` call, after the read-projection guard
 * landed), with nothing naming the stale addon.
 *
 * `missingNativeExport` closes that gap for functions and `missingNativeClass`
 * for classes — a class was exported bare, so `new Thing(...)` threw
 * `undefined is not a constructor` from the caller's own file. Both on the
 * stale path only: on a current addon an absent export is not version drift,
 * and callers use exactly that absence as a capability probe, so it must stay
 * `undefined`.
 *
 * `staleWorkspaceAddonNotice` covers what no per-symbol stub can — a symbol
 * the old addon *does* have, running that release's behaviour.
 */
import { describe, expect, it } from "bun:test";
// Side-effect import: loads the real addon, so `nativeAddonStatus()` below
// reflects this tree's build rather than an injected fixture.
import "../native";
import type { NativeAddonStatus } from "../native/loader-state.js";
import {
	missingNativeClass,
	missingNativeExport,
	missingNativeExportMessage,
	nativeAddonStatus,
	staleWorkspaceAddonNotice,
} from "../native/loader-state.js";

const addonPath = "/w/packages/natives/native/pi_natives.linux-x64-modern.node";

function status(overrides: Partial<NativeAddonStatus> = {}): NativeAddonStatus {
	return {
		path: addonPath,
		version: "18.1.18",
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
			"bun run build:native",
		]) {
			expect(() => stub?.()).toThrow(expected);
		}
	});

	it("reports an unidentified addon without inventing a version", () => {
		const message = missingNativeExportMessage("search", status({ version: null }));
		expect(message).toContain("an addon without a release stamp");
		expect(message).toContain("bun run build:native");
	});

	it("keeps the absence a plain undefined on a current addon", () => {
		const current = status({ version: "18.2.6", stale: false });
		expect(missingNativeExport("macOSSpellCheckerAvailable", current)).toBeUndefined();
		expect(missingNativeExportMessage("macOSSpellCheckerAvailable", current)).toContain(addonPath);
	});

	it("reports the addon it actually loaded, not an assumed one", () => {
		const loaded = nativeAddonStatus();
		expect(loaded).not.toBeNull();
		expect(loaded?.path.endsWith(".node")).toBe(true);
		// Whatever the tree's build state, the flag the stubs branch on must be
		// the one the reported release implies.
		expect(loaded?.stale).toBe(loaded?.version !== loaded?.packageVersion);
	});

	// The class half of the same surface. `RunTrace` landed in the addon after
	// 18.1.18; against that stale addon `native/index.js` exported it as
	// `undefined`, so `new RunTrace(cmd)` in `bash-executor.ts` threw
	// `undefined is not a constructor` pointing at the executor — every
	// shell-driven test then failed for a reason that named neither the addon
	// nor the rebuild.
	it("throws from the constructor naming the class, the addon, both releases, and the rebuild", () => {
		const Stub = missingNativeClass("RunTrace", status());
		expect(typeof Stub).toBe("function");
		for (const expected of ["RunTrace", addonPath, "18.1.18", "18.2.6", "bun run build:native"]) {
			expect(() => new Stub!("echo hi")).toThrow(expected);
		}
		expect(() => new Stub!("echo hi")).not.toThrow("is not a constructor");
	});

	it("keeps a class absence a plain undefined on a current addon", () => {
		expect(missingNativeClass("MacOSFrontApp", status({ version: "18.2.6", stale: false }))).toBeUndefined();
	});
});

// Symbols the stale addon predates are only half the damage: a shared symbol
// it does have runs that release's behaviour, and those failures carry no
// marker at all. The load-time notice is what gives them provenance.
describe("stale workspace addon notice", () => {
	it("names the addon, both releases, and the rebuild", () => {
		const notice = staleWorkspaceAddonNotice(status());
		expect(notice).toContain(addonPath);
		expect(notice).toContain("@oh-my-pi/pi-natives@18.1.18");
		expect(notice).toContain("@18.2.6");
		expect(notice).toContain("bun run build:native");
		expect(notice.endsWith("\n")).toBe(true);
	});

	it("does not invent a release for an unstamped addon", () => {
		const notice = staleWorkspaceAddonNotice(status({ version: null }));
		expect(notice).toContain("an addon without a release stamp");
		expect(notice).not.toContain("@oh-my-pi/pi-natives@null");
	});
});
