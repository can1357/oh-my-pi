import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as logger from "../src/logger";
import { type RotatingFileBatchOptions, RotatingFileSink } from "../src/logger/rotating-file";
import { acquireProcessLogTarget, getProcessLogSink, onProcessLogTargetChanged } from "../src/logger/process-log";

const FLUSH_BYTES = 64 * 1024;

let dir: string;
let writeSpy: Mock<typeof fs.writeSync>;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-logger-batching-"));
	writeSpy = spyOn(fs, "writeSync");
});

afterEach(() => {
	vi.useRealTimers();
	writeSpy.mockRestore();
	logger.setTransports({ console: false, file: false });
	fs.rmSync(dir, { recursive: true, force: true });
});

/** Bytes passed to each `fs.writeSync` call so far. */
function writtenSizes(): number[] {
	// The spy's type follows writeSync's last (string) overload; the sink passes Buffers.
	return writeSpy.mock.calls.map(call => {
		const data: unknown = call[1];
		const offset: unknown = call[2];
		const size =
			typeof data === "string" ? Buffer.byteLength(data) : data instanceof Uint8Array ? data.byteLength : 0;
		return size - (typeof offset === "number" ? offset : 0);
	});
}

function readLines(directory: string): string[] {
	const names = fs.readdirSync(directory).sort();
	return names.flatMap(name =>
		fs
			.readFileSync(path.join(directory, name), "utf8")
			.split(os.EOL)
			.filter(line => line.length > 0),
	);
}

function messages(directory: string): string[] {
	return readLines(directory).map(line => {
		const entry: { message: string } = JSON.parse(line);
		return entry.message;
	});
}

describe("logger file batching", () => {
	test("buffers debug records and writes them in one call, creating the file only then", () => {
		logger.setTransports({ console: false, file: dir });
		for (let index = 0; index < 200; index++) logger.debug("batched-debug", { index });

		expect(writeSpy).not.toHaveBeenCalled();
		expect(fs.readdirSync(dir)).toEqual([]);

		logger.flush();
		expect(writeSpy).toHaveBeenCalledTimes(1);
		expect(readLines(dir)).toHaveLength(200);
	});

	test("the flush timer writes a pending batch once, one second after the first buffered record", () => {
		vi.useFakeTimers();
		logger.setTransports({ console: false, file: dir });
		for (let index = 0; index < 50; index++) logger.debug("timer-debug", { index });

		vi.advanceTimersByTime(999);
		expect(writeSpy).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(writeSpy).toHaveBeenCalledTimes(1);
		expect(readLines(dir)).toHaveLength(50);

		vi.advanceTimersByTime(5_000);
		expect(writeSpy).toHaveBeenCalledTimes(1);
	});

	test("a burst above the size threshold writes once per 64 KiB, not once per record", () => {
		logger.setTransports({ console: false, file: dir });
		const count = 5_000;
		for (let index = 0; index < count; index++) logger.debug("burst-debug", { index, padding: "p".repeat(64) });
		const burstWrites = writtenSizes();
		logger.flush();

		const fileBytes = fs.readdirSync(dir).reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
		expect(burstWrites.length).toBeGreaterThan(0);
		expect(burstWrites.length).toBeLessThanOrEqual(Math.floor(fileBytes / FLUSH_BYTES));
		for (const size of burstWrites) expect(size).toBeGreaterThanOrEqual(FLUSH_BYTES);
		expect(readLines(dir)).toHaveLength(count);
	});

	test("warn and error records reach disk at once, after the records buffered before them", () => {
		logger.setTransports({ console: false, file: dir });
		logger.debug("debug-1");
		logger.info("info-2");
		expect(writeSpy).not.toHaveBeenCalled();

		logger.warn("warn-3");
		expect(writeSpy).toHaveBeenCalledTimes(1);
		expect(messages(dir)).toEqual(["debug-1", "info-2", "warn-3"]);

		logger.debug("debug-4");
		logger.error("error-5");
		expect(writeSpy).toHaveBeenCalledTimes(2);
		expect(messages(dir)).toEqual(["debug-1", "info-2", "warn-3", "debug-4", "error-5"]);
	});

	test("closing the transport writes the pending records", () => {
		logger.setTransports({ console: false, file: dir });
		logger.debug("pending-1");
		logger.info("pending-2");
		expect(fs.readdirSync(dir)).toEqual([]);

		logger.setTransports({ console: false, file: false });
		expect(messages(dir)).toEqual(["pending-1", "pending-2"]);
	});
});

describe("canonical process log targets", () => {
	test("cold custom leases share a target, retain it through nested owners, and stop watching on final release", () => {
		vi.useFakeTimers();
		logger.setTransports({ file: dir });
		const first = acquireProcessLogTarget();
		const second = acquireProcessLogTarget();
		try {
			expect(path.dirname(first.path)).toBe(dir);
			expect(second.path).toBe(first.path);
			expect(fs.readFileSync(first.path, "utf8")).toBe("");
			first.release();
			first.release();
			fs.appendFileSync(second.path, "x".repeat(10 * 1024 * 1024 + 1));
			vi.advanceTimersByTime(1_100);
			expect(fs.existsSync(`${second.path}.1`)).toBe(true);
			second.release();
			fs.appendFileSync(`${second.path}.1`, "y".repeat(10 * 1024 * 1024 + 1));
			vi.advanceTimersByTime(2_000);
			expect(fs.existsSync(`${second.path}.2`)).toBe(false);
		} finally {
			first.release();
			second.release();
		}
	});

	test("live reconfiguration opens and announces the replacement before retiring the previous sink", () => {
		logger.setTransports({ file: dir });
		const first = acquireProcessLogTarget();
		const previous = getProcessLogSink();
		const destination = path.join(dir, "replacement");
		const notifications: string[] = [];
		let replacementWasOpen = false;
		onProcessLogTargetChanged(filePath => {
			if (path.dirname(filePath) !== destination) return;
			replacementWasOpen = fs.existsSync(filePath);
			// The old sink must still accept records during the handoff.
			previous.write("handoff-before-retire");
			notifications.push(filePath);
		});
		try {
			logger.setTransports({ file: destination });
			expect(replacementWasOpen).toBe(true);
			expect(notifications).toHaveLength(1);
			expect(fs.readFileSync(first.path, "utf8")).toBe(`handoff-before-retire${os.EOL}`);
			expect(fs.readFileSync(notifications[0], "utf8")).toBe("");
			logger.warn("replacement-record");
			expect(messages(destination)).toEqual(["replacement-record"]);
			const second = acquireProcessLogTarget();
			expect(second.path).toBe(notifications[0]);
			second.release();
		} finally {
			first.release();
		}
	});

	test("failed replacement preparation preserves the old configuration and leased target", () => {
		logger.setTransports({ file: dir });
		const first = acquireProcessLogTarget();
		const blocker = path.join(dir, "blocked");
		fs.writeFileSync(blocker, "not a directory");
		try {
			expect(() => logger.setTransports({ file: path.join(blocker, "child") })).toThrow();
			const second = acquireProcessLogTarget();
			expect(second.path).toBe(first.path);
			second.release();
			logger.warn("still-on-original");
			expect(JSON.parse(fs.readFileSync(first.path, "utf8")).message).toBe("still-on-original");
		} finally {
			first.release();
		}
	});

	test("a failed canonical rebind rolls earlier observers back and keeps the original sink writable", () => {
		vi.useFakeTimers();
		logger.setTransports({ file: dir });
		const first = acquireProcessLogTarget();
		const destination = path.join(dir, "rebind-failure");
		const replacementPath = path.join(destination, path.basename(first.path));
		const observed: string[] = [];
		onProcessLogTargetChanged(filePath => {
			if (filePath === first.path || path.dirname(filePath) === destination) observed.push(filePath);
		});
		onProcessLogTargetChanged(filePath => {
			if (path.dirname(filePath) === destination) throw new Error("canonical rebind failed");
		});
		try {
			expect(() => logger.setTransports({ file: destination })).toThrow("canonical rebind failed");
			expect(observed).toEqual([replacementPath, first.path]);
			const second = acquireProcessLogTarget();
			expect(second.path).toBe(first.path);
			second.release();
			logger.warn("survives-rebind-failure");
			expect(JSON.parse(fs.readFileSync(first.path, "utf8")).message).toBe("survives-rebind-failure");
			// Failed candidates cannot retain an idle rotation watch.
			fs.appendFileSync(replacementPath, "x".repeat(10 * 1024 * 1024 + 1));
			vi.advanceTimersByTime(1_100);
			expect(fs.existsSync(`${replacementPath}.1`)).toBe(false);
		} finally {
			first.release();
		}
	});
});

describe("RotatingFileSink batching", () => {
	test("failed external rotation retries the successor without losing the old target or buffered records", () => {
		vi.useFakeTimers();
		const rotations: string[] = [];
		const listenerSink = new RotatingFileSink({
			directory: dir,
			filenamePrefix: "retry",
			filenameSuffix: "1234",
			maxBytes: 10_000,
			maxFiles: 1,
			batch: { intervalMs: 300, maxBytes: FLUSH_BYTES },
			onRotate: filePath => rotations.push(filePath),
		});
		try {
			const first = listenerSink.openForExternalWrites();
			const next = `${first}.1`;
			fs.mkdirSync(next);
			listenerSink.write("buffered before failure");
			fs.appendFileSync(first, "x".repeat(10_001));
			vi.advanceTimersByTime(300);
			expect(rotations).toEqual([first]);
			expect(fs.readFileSync(first, "utf8")).toContain("buffered before failure");
			listenerSink.write("during blocked rollover", true);
			expect(fs.readFileSync(first, "utf8")).toContain(`during blocked rollover${os.EOL}`);
			fs.rmSync(next, { recursive: true });
			vi.advanceTimersByTime(300);
			expect(rotations).toEqual([first, next]);
			listenerSink.write("after retry", true);
			expect(fs.readFileSync(next, "utf8")).toBe(`after retry${os.EOL}`);
			expect(fs.existsSync(first)).toBe(false);
		} finally {
			listenerSink.close();
		}
	});

	test("external growth is watched without any logger record at all", () => {
		vi.useFakeTimers();
		try {
			const bareDir = path.join(dir, "bare");
			fs.mkdirSync(bareDir);
			const rotations: string[] = [];
			// External ownership eagerly opens the target before handing it to a guard.
			const sink = new RotatingFileSink({
				directory: bareDir,
				filenamePrefix: "omp",
				filenameSuffix: "1234",
				maxBytes: 1_000,
				maxFiles: 5,
				batch: { intervalMs: 300, maxBytes: FLUSH_BYTES },
				onRotate: p => rotations.push(path.basename(p)),
			});
			const target = sink.openForExternalWrites();
			expect(rotations).toEqual([path.basename(target)]);
			rotations.length = 0;
			fs.appendFileSync(target, "z".repeat(5_000));
			vi.advanceTimersByTime(700);
			expect(rotations).toEqual([`${path.basename(target)}.1`]);
			expect(fs.readdirSync(bareDir).sort()).toEqual([path.basename(target), `${path.basename(target)}.1`]);
			sink.close();
		} finally {
			vi.useRealTimers();
		}
	});

	test("an external owner follows midnight without a record or size overflow", () => {
		vi.useFakeTimers();
		try {
			const rolloverDir = path.join(dir, "rollover");
			fs.mkdirSync(rolloverDir);
			const rotations: string[] = [];
			const clock = { now: new Date(2026, 0, 1, 23, 59, 59).getTime() };
			const sink = new RotatingFileSink({
				directory: rolloverDir,
				filenamePrefix: "omp",
				filenameSuffix: "1234",
				maxBytes: 1_000,
				maxFiles: 5,
				batch: { intervalMs: 1_000, maxBytes: FLUSH_BYTES },
				now: () => new Date(clock.now),
				onRotate: p => rotations.push(path.basename(p)),
			});
			const first = sink.openForExternalWrites();
			fs.appendFileSync(first, "raw day one");
			expect(rotations).toEqual(["omp.2026-01-01.1234.log"]);
			rotations.length = 0;
			// Stay below maxBytes: only the calendar boundary can cause this change.
			clock.now = new Date(2026, 0, 2, 0, 0, 1).getTime();
			vi.advanceTimersByTime(1_100);
			expect(rotations).toEqual(["omp.2026-01-02.1234.log"]);
			expect(fs.readdirSync(rolloverDir).sort()).toEqual(["omp.2026-01-01.1234.log", "omp.2026-01-02.1234.log"]);
			expect(fs.readFileSync(path.join(rolloverDir, "omp.2026-01-02.1234.log"), "utf8")).toBe("");
			sink.close();
		} finally {
			vi.useRealTimers();
		}
	});

	test("external growth rotates on the watch cadence without further records", async () => {
		const watchDir = path.join(dir, "watch");
		fs.mkdirSync(watchDir);
		const sink = makeSink(watchDir, { intervalMs: 300, maxBytes: FLUSH_BYTES });
		sink.openForExternalWrites();
		sink.write("only record");
		sink.flush();
		const active = fs.readdirSync(watchDir).sort()[0];
		// An inherited child keeps appending through fd 1/2 with no logger
		// records in between; rotation must still happen on its own cadence.
		fs.appendFileSync(path.join(watchDir, active), "z".repeat(5_000));
		await Bun.sleep(800);
		const names = fs.readdirSync(watchDir);
		expect(names.length).toBeGreaterThanOrEqual(2);
		sink.close();
	});

	test("external file growth is sampled on a throttled cadence, not per record", async () => {
		const externalDir = path.join(dir, "external");
		fs.mkdirSync(externalDir);
		const rotations: string[] = [];
		const sink = new RotatingFileSink({
			directory: externalDir,
			filenamePrefix: "omp",
			filenameSuffix: "1234",
			maxBytes: 2_000,
			maxFiles: 5,
			batch: { intervalMs: 1_000, maxBytes: FLUSH_BYTES },
			onRotate: filePath => rotations.push(filePath),
		});
		sink.write("first record");
		sink.flush();
		const active = fs.readdirSync(externalDir).sort()[0];
		rotations.length = 0; // onRotate also fires on the initial open
		// An external writer (fd 1/2 redirected onto the log) pushes past the cap.
		fs.appendFileSync(path.join(externalDir, active), "y".repeat(5_000));
		// Steady-state records inside the throttle window must not rotate yet...
		for (let index = 0; index < 20; index++) sink.write(`record ${index}`);
		sink.flush();
		expect(rotations).toHaveLength(0);
		// ...and the next window still honors the external growth.
		await Bun.sleep(1_100);
		sink.write("after interval");
		sink.flush();
		expect(rotations).toHaveLength(1);
		sink.close();
	});

	test("counts a guard-created oversized base file toward retention before selecting its successor", () => {
		const clock = new Date(2026, 0, 1, 12);
		const base = "omp.2026-01-01.1234.log";
		fs.writeFileSync(path.join(dir, base), "x".repeat(1_001));
		const sink = new RotatingFileSink({
			directory: dir,
			filenamePrefix: "omp",
			filenameSuffix: "1234",
			maxBytes: 1_000,
			maxFiles: 5,
			now: () => clock,
		});
		try {
			for (let index = 0; index < 5; index++) sink.write("y".repeat(1_001));
			expect(fs.readdirSync(dir).sort()).toEqual([1, 2, 3, 4, 5].map(index => `${base}.${index}`));
			expect(fs.existsSync(path.join(dir, base))).toBe(false);
		} finally {
			sink.close();
		}
	});

	test("ordinary idle sinks and released external writers do not create next-day files", () => {
		vi.useFakeTimers();
		const clock = { now: new Date(2026, 0, 1, 23, 59, 59).getTime() };
		const rotations: string[] = [];
		const sink = new RotatingFileSink({
			directory: dir,
			filenamePrefix: "omp",
			filenameSuffix: "1234",
			maxBytes: 1_000,
			maxFiles: 5,
			now: () => new Date(clock.now),
			onRotate: filePath => rotations.push(path.basename(filePath)),
		});
		try {
			sink.write("first");
			const first = "omp.2026-01-01.1234.log";
			expect(fs.readdirSync(dir)).toEqual([first]);
			clock.now = new Date(2026, 0, 2, 0, 0, 1).getTime();
			vi.advanceTimersByTime(2_000);
			expect(fs.readdirSync(dir)).toEqual([first]);
			const second = sink.openForExternalWrites();
			expect(path.basename(second)).toBe("omp.2026-01-02.1234.log");
			sink.stopWatchingExternalWrites(true);
			rotations.length = 0;
			clock.now = new Date(2026, 0, 3, 0, 0, 1).getTime();
			vi.advanceTimersByTime(2_000);
			expect(rotations).toEqual([]);
			expect(fs.readdirSync(dir).sort()).toEqual([first, path.basename(second)]);
		} finally {
			sink.close();
			vi.useRealTimers();
		}
	});

	function makeSink(directory: string, batch?: RotatingFileBatchOptions): RotatingFileSink {
		return new RotatingFileSink({
			directory,
			filenamePrefix: "omp",
			filenameSuffix: "1234",
			maxBytes: 1_000,
			maxFiles: 5,
			batch,
		});
	}

	test("rotation honors maxBytes exactly as an unbatched sink does", () => {
		const unbatchedDir = path.join(dir, "unbatched");
		const batchedDir = path.join(dir, "batched");
		fs.mkdirSync(unbatchedDir);
		fs.mkdirSync(batchedDir);
		const unbatched = makeSink(unbatchedDir);
		const batched = makeSink(batchedDir, { intervalMs: 60_000, maxBytes: FLUSH_BYTES });
		const records = Array.from({ length: 10 }, (_, index) => `${index}`.padEnd(300, "x"));

		for (const record of records) unbatched.write(record);
		unbatched.close();
		const unbatchedWrites = writeSpy.mock.calls.length;
		writeSpy.mockClear();
		for (const record of records) batched.write(record);
		batched.close();

		const names = fs.readdirSync(batchedDir).sort();
		expect(names).toEqual(fs.readdirSync(unbatchedDir).sort());
		expect(names).toHaveLength(3);
		for (const name of names) {
			expect(fs.readFileSync(path.join(batchedDir, name), "utf8")).toBe(
				fs.readFileSync(path.join(unbatchedDir, name), "utf8"),
			);
		}
		expect(unbatchedWrites).toBe(records.length);
		// One write per rotated file instead of one per record.
		expect(writeSpy).toHaveBeenCalledTimes(names.length);
	});
});
