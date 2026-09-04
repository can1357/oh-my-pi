import { describe, expect, test } from "bun:test";
import type { DaemonSnapshot } from "../../src/launch/protocol";
import { isDeadDaemonRecord, sharedBrowserDaemonName } from "../../src/tools/browser/shared-daemon";

function snapshot(state: DaemonSnapshot["state"], overrides: Partial<DaemonSnapshot> = {}): DaemonSnapshot {
	return {
		name: "omp.browser.headless",
		id: "daemon-1",
		state,
		createdAt: 0,
		startedAt: 0,
		restartCount: 0,
		outputBytes: 0,
		persist: false,
		detached: false,
		...overrides,
	};
}

describe("shared browser daemon records", () => {
	test("attachable states are never reclaimed", () => {
		for (const state of ["starting", "running", "ready", "restarting", "stopping"] as const) {
			expect(isDeadDaemonRecord(snapshot(state))).toBe(false);
		}
	});

	test("terminal records are reclaimed before a replacement start", () => {
		expect(isDeadDaemonRecord(snapshot("exited"))).toBe(true);
		// The Windows leak in issue #7900: the broker reports `failed` with exit
		// code 255 shortly after a successful start, while the Chromium tree it
		// launched is still alive and must be stopped before the next start.
		expect(isDeadDaemonRecord(snapshot("failed", { exitCode: 255, readyAt: 1 }))).toBe(true);
	});

	test("daemon name is stable per headless mode", () => {
		expect(sharedBrowserDaemonName(true)).toBe("omp.browser.headless");
		expect(sharedBrowserDaemonName(false)).toBe("omp.browser.headed");
	});
});
