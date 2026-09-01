import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OutputSink } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const createdTempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "output-sink-fd-"));
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
		const fakeFile = { writer: () => fakeSink } as unknown as Bun.BunFile;

		const realFile = Bun.file.bind(Bun);
		vi.spyOn(Bun, "file").mockImplementation((source, options) => {
			if (source === artifactPath) return fakeFile;
			return realFile(source as string, options);
		});

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
});
