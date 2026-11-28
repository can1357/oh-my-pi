import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { moduleLoadBuffer } from "@oh-my-pi/pi-utils/timing-buffer";

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

describe("startup wall-clock accounting", () => {
	it("clips detached work at its parent's end and counts overlapping and unfinished work once at the snapshot", async () => {
		let now = 10;
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		const reports: string[] = [];
		const sink = spyOn(console, "error").mockImplementation(text => reports.push(String(text)));
		const gate = Promise.withResolvers<void>();
		let tail: Promise<void> | undefined;
		logger.startTiming();
		try {
			now = 15;
			logger.time("parent", () => {
				now = 17;
				tail = logger.time("detached", () => gate.promise);
				now = 25;
			});
			now = 30;
			logger.time("next", () => {
				now = 40;
			});
			now = 50;
			logger.printTimings();
			const report = reports[0];
			expect(report).toContain("parent: 10.0ms (2.0ms outside child spans)");
			expect(report).toContain("detached: 33.0ms [open at snapshot]");
			expect(report).toContain("next: 10.0ms @30.0ms");
			expect(report).toContain("App timing window: 40.0ms (35.0ms in spans; 5.0ms unmarked)");
			expect(report).toContain("Total: 50.0ms");
		} finally {
			gate.resolve();
			await tail;
			logger.endTiming();
			sink.mockRestore();
			clock.mockRestore();
		}
	});

	it("keeps module observations out of app accounting and excludes gaps between reads and evaluations", async () => {
		let now = 50;
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		const reports: string[] = [];
		const sink = spyOn(console, "error").mockImplementation(text => reports.push(String(text)));
		const gate = Promise.withResolvers<void>();
		logger.startTiming();
		try {
			now = 60;
			const first = logger.time("first", () => gate.promise);
			now = 65;
			logger.time("second", () => {
				now = 70;
			});
			now = 75;
			gate.resolve();
			await first;
			now = 80;
			logger.time("last", () => {
				now = 85;
			});
			moduleLoadBuffer().push(
				{ path: "a.ts", readStart: 2, readEnd: 3, bodyStart: 20, bodyEnd: 25 },
				{ path: "b.ts", readStart: 60, readEnd: 62, bodyStart: 82, bodyEnd: 86 },
				{ path: "c.ts", readStart: 62, readEnd: 63, bodyStart: 83, bodyEnd: 85 },
			);
			now = 100;
			logger.printTimings();
			const report = reports[0];
			expect(report).toContain("first: 15.0ms [overlaps sibling]");
			expect(report).toContain("second: 5.0ms [overlaps sibling]");
			expect(report).toContain("last: 5.0ms @80.0ms");
			expect(report).toContain("App timing window: 50.0ms (20.0ms in spans; 30.0ms unmarked)");
			expect(report).toContain("Source reads: 4.0ms covered; evaluation including top-level await: 9.0ms covered");
			expect(report).toContain("Total: 100.0ms");
		} finally {
			gate.resolve();
			logger.endTiming();
			sink.mockRestore();
			clock.mockRestore();
		}
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
