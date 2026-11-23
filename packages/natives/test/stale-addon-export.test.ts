/**
 * A workspace tree that pulls a release newer than its last
 * `bun run build:native` keeps loading the previous addon: the loader tolerates
 * the release mismatch by design, so every symbol added after that build is
 * absent. The contract pinned here is how that absence surfaces — a bare
 * `undefined` export turned into `<symbol> is not a function` inside whichever
 * tool used it first (every `write` call, after the read-projection guard
 * landed), with nothing naming the stale addon.
 *
 * `missingNativeExport` covers functions and `missingNativeClass` classes,
 * both on the stale path only: on a current addon an absent export is not
 * version drift, and callers use exactly that absence as a capability probe,
 * so it must stay `undefined`.
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

	// A bare `undefined` class export reaches `new RunTrace(cmd)` in
	// `bash-executor.ts` as `undefined is not a constructor`, a stack that
	// names the executor and nothing about the addon.
	it("throws from the constructor naming the class, the addon, both releases, and the rebuild", () => {
		const Stub = missingNativeClass("RunTrace", status());
		expect(typeof Stub).toBe("function");
		for (const expected of ["RunTrace", addonPath, "18.1.18", "18.2.6", "bun run build:native"]) {
			expect(() => new Stub!("echo hi")).toThrow(expected);
		}
		expect(() => new Stub!("echo hi")).not.toThrow("is not a constructor");
	});

	// `FileLock.tryAcquire`, `IpcServer.listen` and `Process.fromPid` are
	// entered through a static, which never runs a constructor.
	it("answers a static entrypoint with the same diagnostic as the constructor", () => {
		const Stub = missingNativeClass("FileLock", status()) as unknown as { tryAcquire: () => void };
		expect(() => Stub.tryAcquire()).toThrow("FileLock.tryAcquire");
		expect(() => Stub.tryAcquire()).toThrow("bun run build:native");
	});

	it("keeps a class absence a plain undefined on a current addon", () => {
		expect(missingNativeClass("MacOSFrontApp", status({ version: "18.2.6", stale: false }))).toBeUndefined();
	});
});
