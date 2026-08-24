import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OutputSink } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const createdTempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "output-sink-fd-"));
	createdTempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of createdTempDirs.splice(0)) {
		await removeWithRetries(dir);
	}
});

// Force a spill on the first push: a tiny threshold plus a chunk larger than it
// kicks off the async artifact `Bun.FileSink` creation. dump()/dispose() both
// await that in-flight creation internally, so no wall-clock wait is needed to
// observe the fd being opened and then closed.
function spill(sink: OutputSink): void {
	sink.push(`${"x".repeat(64)}\n`);
}

function installArtifactSink(artifactPath: string, sink: Bun.FileSink): void {
	const fd = fs.openSync(artifactPath, "w", 0o600);
	vi.spyOn(fs, "openSync").mockImplementation(((source: fs.PathLike) => {
		if (source !== artifactPath) throw new Error(`Unexpected artifact path: ${String(source)}`);
		return fd;
	}) as typeof fs.openSync);
	const fakeFile = { writer: () => sink } as unknown as Bun.BunFile;
	const realFile = Bun.file.bind(Bun);
	vi.spyOn(Bun, "file").mockImplementation((source, options) => {
		if (source === fd) return fakeFile;
		return realFile(source as string, options);
	});
}

describe("OutputSink fd lifecycle", () => {
	test("dispose() releases the spill descriptor on error/abort paths that skip dump()", async () => {
		const dir = await createTempDir();
		const skill = path.join(dir, "SKILL.md");
		await Bun.write(skill, "# skill\n");

		// Cross the 64-descriptor limit used by the leak repro. More iterations do
		// not strengthen that boundary and only multiply serial file I/O.
		for (let i = 0; i < 72; i++) {
			const artifactPath = path.join(dir, `spill-${i}.txt`);
			const sink = new OutputSink({ artifactPath, artifactId: `art-${i}`, spillThreshold: 16 });
			spill(sink);
			// Error/abort path: bail without dump().
			await sink.dispose();
			// Descriptor released → the artifact is closed, complete, and readable,
			// and the unrelated skill read never hits EMFILE.
			const content = await Bun.file(artifactPath).text();
			expect(content).toContain("x".repeat(64));
			await Bun.file(skill).text();
		}
	});

	test("dump() then dispose() closes the sink exactly once", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "spill.txt");
		const sink = new OutputSink({ artifactPath, artifactId: "once", spillThreshold: 16 });
		spill(sink);

		const summary = await sink.dump();
		expect(summary.artifactId).toBe("once");
		expect(summary.truncated).toBe(true);

		// dispose() after dump() must be a harmless idempotent no-op — no throw
		// from double-closing the underlying FileSink.
		await sink.dispose();

		const content = await Bun.file(artifactPath).text();
		expect(content).toContain("x".repeat(64));
	});

	test("push() after finalize is dropped and never resurrects the descriptor", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "spill.txt");
		const sink = new OutputSink({ artifactPath, artifactId: "drop", spillThreshold: 16 });
		spill(sink);
		await sink.dispose();

		// A late chunk (e.g. a native callback firing after the error path tore
		// down) must not reopen a fresh spill sink.
		sink.push(`${"y".repeat(64)}\n`);
		await sink.dispose();

		const content = await Bun.file(artifactPath).text();
		expect(content).not.toContain("y".repeat(64));
	});

	test("a fresh sink truncates an existing capture at its path before mirroring", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "fresh.txt");
		await Bun.write(artifactPath, "prior capture tail\n");
		const sink = new OutputSink({ artifactPath, artifactId: "fresh", artifactWriteMode: "mirror" });
		sink.push("new\n");
		await sink.flushArtifact();
		// Bun.file(path).writer() overwrites in place without truncating; a
		// shorter capture must not keep the old capture's tail behind it.
		expect(await Bun.file(artifactPath).text()).toBe("new\n");

		await sink.dispose();
		expect(await Bun.file(artifactPath).text()).toBe("new\n");
	});

	test("dispose() closes the descriptor even when the capped tail replay write throws", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "capped.txt");

		let ended = false;
		// Mock FileSink: head bytes ("h") write fine; the tail replay (the
		// `[ARTIFACT TRUNCATED …]` notice + "t" ring) throws, mirroring a disk
		// write error while closing a capped artifact. Cast to the sink type — a
		// full FileSink has methods OutputSink never calls.
		const fakeSink = {
			write(chunk: string): number {
				if (chunk.includes("[ARTIFACT TRUNCATED") || chunk.includes("t")) {
					throw new Error("simulated disk write failure");
				}
				return Buffer.byteLength(chunk, "utf-8");
			},
			end(): Promise<number> {
				ended = true;
				return Promise.resolve(0);
			},
		} as unknown as Bun.FileSink;
		installArtifactSink(artifactPath, fakeSink);

		// Small on-disk cap so head fills, the rest overflows into the tail ring,
		// and #flushArtifactTailIfCapped replays a truncation notice on close.
		const sink = new OutputSink({
			artifactPath,
			artifactId: "capped",
			spillThreshold: 16,
			artifactMaxBytes: 40,
			artifactHeadBytes: 20,
		});
		sink.push("h".repeat(30));
		sink.push("t".repeat(60));

		// The tail replay throws, but dispose() must still close the sink and must
		// not surface the replay error (it would mask the original tool error).
		await expect(sink.dispose()).resolves.toBeUndefined();
		expect(ended).toBe(true);
	});

	test("surfaces an artifact open failure without losing inline output or advertising the artifact", async () => {
		const artifactPath = await createTempDir();
		const sink = new OutputSink({
			artifactPath,
			artifactId: "unavailable-open",
			artifactWriteMode: "mirror",
			artifactAppend: true,
		});
		sink.push("terminal output survives");

		let openFailure: unknown;
		try {
			await sink.flushArtifact();
		} catch (error) {
			openFailure = error;
		}
		expect(openFailure).toBeDefined();
		await expect(sink.flushArtifact()).rejects.toBe(openFailure);

		const summary = await sink.dump();
		expect(summary.output).toBe("terminal output survives");
		expect(summary.artifactId).toBeUndefined();
		await expect(sink.dispose()).resolves.toBeUndefined();
	});

	test("surfaces the first synchronous artifact write failure from flushArtifact", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "write-failure.txt");
		const writeFailure = new Error("simulated artifact write failure");
		const fakeSink = {
			write(): number {
				throw writeFailure;
			},
			flush(): Promise<number> {
				throw new Error("later flush failure");
			},
			end(): Promise<number> {
				return Promise.resolve(0);
			},
		} as unknown as Bun.FileSink;
		installArtifactSink(artifactPath, fakeSink);

		const sink = new OutputSink({
			artifactPath,
			artifactId: "unavailable-write",
			artifactWriteMode: "mirror",
		});
		sink.push("raw output survives");

		await expect(sink.flushArtifact()).rejects.toBe(writeFailure);
		const summary = await sink.dump();
		expect(summary.output).toBe("raw output survives");
		expect(summary.artifactId).toBeUndefined();
	});

	test("surfaces an artifact flush failure and never advertises the failed capture", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "flush-failure.txt");
		const flushFailure = new Error("simulated artifact flush failure");
		const fakeSink = {
			write(chunk: string): number {
				return Buffer.byteLength(chunk, "utf-8");
			},
			flush(): Promise<number> {
				return Promise.reject(flushFailure);
			},
			end(): Promise<number> {
				return Promise.resolve(0);
			},
		} as unknown as Bun.FileSink;
		installArtifactSink(artifactPath, fakeSink);

		const sink = new OutputSink({
			artifactPath,
			artifactId: "unavailable-flush",
			artifactWriteMode: "mirror",
		});
		sink.push("inline output survives");

		await expect(sink.flushArtifact()).rejects.toBe(flushFailure);
		const summary = await sink.dump();
		expect(summary.output).toBe("inline output survives");
		expect(summary.artifactId).toBeUndefined();
		await expect(sink.dispose()).resolves.toBeUndefined();
	});

	// Append-mode sinks own a raw descriptor that Bun's fd writer never closes.
	// These assert the descriptor is really gone (fstat → EBADF), not merely
	// that dispose() resolved.
	function captureAppendFd(): { fd: () => number } {
		let opened: number | undefined;
		const realOpenSync = fs.openSync;
		vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
			const fd = realOpenSync(...args);
			if (args[1] === "a") opened = fd;
			return fd;
		});
		return {
			fd: () => {
				if (opened === undefined) throw new Error("append descriptor was never opened");
				return opened;
			},
		};
	}

	function expectClosed(fd: number): void {
		let code: string | undefined;
		try {
			fs.fstatSync(fd);
		} catch (error) {
			code = (error as NodeJS.ErrnoException).code;
		}
		expect(code).toBe("EBADF");
	}

	test("dispose() closes the append-mode descriptor after a successful capture", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "append.txt");
		await Bun.write(artifactPath, "prior\n");
		const opened = captureAppendFd();
		const sink = new OutputSink({
			artifactPath,
			artifactId: "append",
			artifactWriteMode: "mirror",
			artifactAppend: true,
		});
		sink.push("later\n");
		await sink.flushArtifact();
		expect(sink.artifactBytes).toBe("later\n".length);
		expect(fs.fstatSync(opened.fd()).isFile()).toBeTrue();

		await sink.dispose();
		expectClosed(opened.fd());
		expect(await Bun.file(artifactPath).text()).toBe("prior\nlater\n");
	});

	test("dispose() closes the append-mode descriptor when ending the writer fails", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "append-end-failure.txt");
		const opened = captureAppendFd();
		const fakeSink = {
			write(chunk: string): number {
				return Buffer.byteLength(chunk, "utf-8");
			},
			flush(): Promise<number> {
				return Promise.resolve(0);
			},
			end(): Promise<number> {
				return Promise.reject(new Error("simulated close failure"));
			},
		} as unknown as Bun.FileSink;
		const realFile = Bun.file.bind(Bun);
		vi.spyOn(Bun, "file").mockImplementation((source, options) => {
			if (typeof source === "number") return { writer: () => fakeSink } as unknown as Bun.BunFile;
			return realFile(source as string, options);
		});

		const sink = new OutputSink({
			artifactPath,
			artifactId: "append-end",
			artifactWriteMode: "mirror",
			artifactAppend: true,
		});
		sink.push("captured\n");
		await sink.flushArtifact();

		await expect(sink.dispose()).resolves.toBeUndefined();
		expectClosed(opened.fd());
		// A capture whose close failed is never advertised as complete.
		expect((await sink.dump()).artifactId).toBeUndefined();
	});

	test("a failed append-mode writer never leaks the descriptor it was opened on", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "append-writer-failure.txt");
		const opened = captureAppendFd();
		const realFile = Bun.file.bind(Bun);
		vi.spyOn(Bun, "file").mockImplementation((source, options) => {
			if (typeof source === "number") {
				return {
					writer: () => {
						throw new Error("simulated writer failure");
					},
				} as unknown as Bun.BunFile;
			}
			return realFile(source as string, options);
		});

		const sink = new OutputSink({
			artifactPath,
			artifactId: "append-writer",
			artifactWriteMode: "mirror",
			artifactAppend: true,
		});
		sink.push("lost to the failure\n");
		await expect(sink.flushArtifact()).rejects.toThrow("simulated writer failure");
		expectClosed(opened.fd());
		await expect(sink.dispose()).resolves.toBeUndefined();
		expectClosed(opened.fd());
	});
});
