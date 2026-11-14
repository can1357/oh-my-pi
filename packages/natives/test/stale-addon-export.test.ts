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
	reportStaleWorkspaceAddon,
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

	// `loadNative()` is not a startup-only call: `native/clipboard.js` and the
	// other lazy entrypoints call it on every invocation, so an unlatched
	// notice would repaint under a running TUI on every clipboard copy.
	it("emits at most once against a given latch", () => {
		const written: string[] = [];
		const state = { reported: false };
		const deps = { write: (text: string) => written.push(text), state };
		expect(reportStaleWorkspaceAddon({ isWorkspaceLoad: true }, status(), deps)).toBe(true);
		expect(reportStaleWorkspaceAddon({ isWorkspaceLoad: true }, status(), deps)).toBe(false);
		expect(written).toHaveLength(1);
		expect(written[0]).toContain(addonPath);
	});

	// `validateLoadedBindings` also returns successfully for a pre-sentinel
	// addon on an installed load; that addon reports no release, so it is
	// `stale`, and telling its user to run a repository build would be wrong.
	it("stays silent outside a workspace load", () => {
		const written: string[] = [];
		const deps = { write: (text: string) => written.push(text), state: { reported: false } };
		expect(reportStaleWorkspaceAddon({ isWorkspaceLoad: false }, status({ version: null }), deps)).toBe(false);
		expect(written).toHaveLength(0);
	});

	it("stays silent for a current addon", () => {
		const written: string[] = [];
		const deps = { write: (text: string) => written.push(text), state: { reported: false } };
		const current = status({ version: "18.2.6", stale: false });
		expect(reportStaleWorkspaceAddon({ isWorkspaceLoad: true }, current, deps)).toBe(false);
		expect(written).toHaveLength(0);
	});

	// fd 2 is shared, and the subagent, JS-eval and tab workers all start after
	// interactive mode owns the terminal, so a worker that writes the notice
	// paints into a rendered frame. Driven in a real worker rather than behind
	// a seam: the guard reads thread identity, so only a thread can prove it.
	it("stays silent in a worker thread while its missing-symbol diagnostic survives", async () => {
		const worker = new Worker(new URL("./fixtures/stale-notice-worker.ts", import.meta.url).href, {
			type: "module",
		});
		const { promise, resolve, reject } = Promise.withResolvers<{
			wrote: boolean;
			writes: number;
			symbolDiagnostic: string;
		}>();
		worker.addEventListener("message", event => resolve(event.data));
		worker.addEventListener("error", event => reject(new Error(String(event.message ?? event))));
		const reply = await promise;
		worker.terminate();
		expect(reply.wrote).toBe(false);
		expect(reply.writes).toBe(0);
		// The notice is a display courtesy; the per-symbol diagnostic is the
		// contract, and a worker needs it as much as the main thread.
		expect(reply.symbolDiagnostic).toContain("RunTrace");
		expect(reply.symbolDiagnostic).toContain("bun run build:native");
	});
});
