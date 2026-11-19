import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as logger from "@oh-my-pi/pi-utils/logger";

/** Run `fn` with PI_DEBUG_STARTUP set, capturing `[startup]` stderr markers. */
function withMarkerCapture<T>(fn: () => T): { result: T; markers: string[] } {
	const prev = process.env.PI_DEBUG_STARTUP;
	process.env.PI_DEBUG_STARTUP = "1";
	const markers: string[] = [];
	const writeSpy = spyOn(fs, "writeSync").mockImplementation(((_fd: number, data: string) => {
		const text = String(data);
		if (text.startsWith("[startup]")) markers.push(text.trimEnd());
		return text.length;
	}) as typeof fs.writeSync);
	try {
		return { result: fn(), markers };
	} finally {
		writeSpy.mockRestore();
		if (prev === undefined) {
			delete process.env.PI_DEBUG_STARTUP;
		} else {
			process.env.PI_DEBUG_STARTUP = prev;
		}
	}
}

describe("PI_DEBUG_STARTUP streaming markers", () => {
	// Contract: with PI_DEBUG_STARTUP set, every logger.time phase leaves a
	// synchronous `:start` marker before running — so a phase that hangs the
	// process forever is still identified by the last marker on stderr. This
	// must work without startTiming() (markers are independent of PI_TIMING).
	it("brackets a phase with start/done markers", () => {
		const { result, markers } = withMarkerCapture(() => logger.time("phase:test", () => 42));
		expect(result).toBe(42);
		expect(markers).toEqual(["[startup] phase:test:start", "[startup] phase:test:done"]);
	});

	it("marks a throwing phase as failed and rethrows", () => {
		const { markers } = withMarkerCapture(() => {
			expect(() =>
				logger.time("phase:boom", () => {
					throw new Error("boom");
				}),
			).toThrow("boom");
		});
		expect(markers).toEqual(["[startup] phase:boom:start", "[startup] phase:boom:fail"]);
	});

	it("emits a single marker for point spans", () => {
		const { markers } = withMarkerCapture(() => logger.time("phase:point"));
		expect(markers).toEqual(["[startup] phase:point"]);
	});

	it("emits nothing when PI_DEBUG_STARTUP is unset", () => {
		const prev = process.env.PI_DEBUG_STARTUP;
		delete process.env.PI_DEBUG_STARTUP;
		const writes: string[] = [];
		const writeSpy = spyOn(fs, "writeSync").mockImplementation(((_fd: number, data: string) => {
			writes.push(String(data));
			return String(data).length;
		}) as typeof fs.writeSync);
		try {
			expect(logger.time("phase:silent", () => "ok")).toBe("ok");
		} finally {
			writeSpy.mockRestore();
			if (prev !== undefined) process.env.PI_DEBUG_STARTUP = prev;
		}
		expect(writes.filter(w => w.startsWith("[startup]"))).toEqual([]);
	});
});

describe("openSpanPath", () => {
	// Contract: while a startup phase is in flight, openSpanPath names the
	// chain root → deepest open span. The startup watchdog prints this to tell
	// the user which phase a stalled startup is stuck in.
	it("names the deepest in-flight span and clears once settled", async () => {
		logger.startTiming();
		try {
			const gate = Promise.withResolvers<void>();
			const running = logger.time("outer", async () => {
				await logger.time("inner", () => gate.promise);
			});
			expect(logger.openSpanPath()).toEqual(["outer", "inner"]);
			gate.resolve();
			await running;
			expect(logger.openSpanPath()).toEqual([]);
		} finally {
			logger.endTiming();
		}
	});

	it("returns empty when timing is not recording", () => {
		expect(logger.openSpanPath()).toEqual([]);
	});
});
