import { describe, expect, it } from "bun:test";
import {
	type AutoUpdateState,
	describeAutoUpdate,
	RETRY_AFTER_MS,
	shouldStartWorker,
} from "@oh-my-pi/pi-coding-agent/cli/auto-update";
import { VERSION } from "@oh-my-pi/pi-utils";

/** A version newer than the running build. */
const NEWER = "999.0.0";

describe("auto-update retry hold-off", () => {
	const finished: AutoUpdateState = { phase: "failed", target: NEWER, at: 1_000 };

	it("starts a worker without a previous run or for a newly offered version", () => {
		expect(shouldStartWorker(undefined, NEWER, 1_000)).toBe(true);
		expect(shouldStartWorker(finished, "999.0.1", 1_001)).toBe(true);
	});

	it("holds off the same version until the previous attempt is RETRY_AFTER_MS old", () => {
		expect(shouldStartWorker(finished, NEWER, 1_000 + RETRY_AFTER_MS - 1)).toBe(false);
		expect(shouldStartWorker(finished, NEWER, 1_000 + RETRY_AFTER_MS)).toBe(true);
	});
});

describe("auto-update banner status", () => {
	it("maps worker phases to the version indicator", () => {
		const at = Date.now();
		expect(describeAutoUpdate({ phase: "checking", target: NEWER, at })).toEqual({
			phase: "updating",
			version: NEWER,
		});
		expect(describeAutoUpdate({ phase: "downloading", version: NEWER, received: 25, total: 100, at })).toEqual({
			phase: "updating",
			version: NEWER,
			fraction: 0.25,
		});
		expect(describeAutoUpdate({ phase: "failed", target: NEWER, at })).toEqual({ phase: "failed", version: NEWER });
		expect(describeAutoUpdate({ phase: "current", target: NEWER, at })).toBeNull();
	});

	it("calls an install ready only when it is newer than the running build", () => {
		const at = Date.now();
		expect(describeAutoUpdate({ phase: "done", version: NEWER, at })).toEqual({ phase: "ready", version: NEWER });
		expect(describeAutoUpdate({ phase: "done", version: VERSION, at })).toBeNull();
	});

	it("shows nothing for a run that names no version", () => {
		expect(describeAutoUpdate({ phase: "checking", at: Date.now() })).toBeNull();
	});
});
