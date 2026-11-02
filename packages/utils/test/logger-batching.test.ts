import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as logger from "../src/logger";
import { type RotatingFileBatchOptions, RotatingFileSink } from "../src/logger/rotating-file";

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

describe("RotatingFileSink batching", () => {
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
