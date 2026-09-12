import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { OutputSink } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import { bashToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { formatOutputNotice, outputMeta } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { removeWithRetries, sanitizeText } from "@oh-my-pi/pi-utils";

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

/** Substitute only this artifact's writer, retaining real file/descriptor behavior. */
function instrumentArtifact(artifactPath: string): Bun.FileSink {
	const file = Bun.file(artifactPath);
	const writer = file.writer();
	vi.spyOn(file, "writer").mockReturnValue(writer);
	const realFile = Bun.file.bind(Bun);
	vi.spyOn(Bun, "file").mockImplementation((source, options) => {
		if (source === artifactPath) return file;
		return realFile(source as string, options);
	});
	return writer;
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

	test("dispose() preserves cancellation cleanup when capped tail replay fails", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "capped.txt");
		const writer = instrumentArtifact(artifactPath);
		const write = writer.write.bind(writer);
		vi.spyOn(writer, "write").mockImplementation(chunk => {
			if (typeof chunk === "string" && chunk.includes("[ARTIFACT TRUNCATED")) {
				throw new Error("simulated disk write failure");
			}
			return write(chunk);
		});
		const end = vi.spyOn(writer, "end");
		const sink = new OutputSink({
			artifactPath,
			artifactId: "capped",
			spillThreshold: 16,
			artifactMaxBytes: 40,
			artifactHeadBytes: 20,
		});
		sink.push("h".repeat(30));
		sink.push("t".repeat(60));
		await sink.dispose();
		await sink.dispose();
		sink.push("late callback");

		const summary = await sink.dump();
		expect(summary.output).toBe("t".repeat(16));
		expect(summary.artifactId).toBeUndefined();
		expect(summary.artifactError).toBe("flush");
		expect(end).toHaveBeenCalledTimes(1);
		expect(await Bun.file(artifactPath).text()).toBe("h".repeat(20));
		expect(formatOutputNotice(outputMeta().truncationFromSummary(summary, { direction: "tail" }).get())).toContain(
			"not saved completely",
		);
	});

	test("an artifact open failure is terminal even when its target becomes writable", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "blocked");
		await fs.mkdir(artifactPath);
		const sink = new OutputSink({ artifactPath, artifactId: "incomplete", spillThreshold: 4 });
		sink.push("lost-before-failure");
		await fs.rmdir(artifactPath);
		sink.push("tail");
		const summary = await sink.dump();
		const notice = formatOutputNotice(outputMeta().truncationFromSummary(summary, { direction: "tail" }).get());

		expect(summary.output).toBe("tail");
		expect(summary.artifactError).toBe("open");
		expect(summary.artifactId).toBeUndefined();
		expect(notice).toContain("not saved completely");
		expect(notice).not.toContain("artifact://");
		expect(await Bun.file(artifactPath).exists()).toBe(false);
	});

	test("a write failure preserves bounded output and stops subsequent capture writes", async () => {
		const dir = await createTempDir();
		const writer = instrumentArtifact(path.join(dir, "write.txt"));
		const sink = new OutputSink({
			artifactPath: path.join(dir, "write.txt"),
			artifactId: "write",
			spillThreshold: 4,
		});
		sink.push("prefix");
		const write = vi.spyOn(writer, "write").mockImplementation(() => {
			throw new Error("write failed");
		});
		const end = vi.spyOn(writer, "end");
		sink.push("failed");
		sink.push("tail");
		const summary = await sink.dump();
		await sink.dispose();

		expect(summary.output).toBe("tail");
		expect(summary.totalBytes).toBe(16);
		expect(summary.artifactError).toBe("write");
		expect(summary.artifactId).toBeUndefined();
		expect(write).toHaveBeenCalledTimes(1);
		expect(end).toHaveBeenCalledTimes(1);
		expect(await Bun.file(path.join(dir, "write.txt")).text()).toBe("prefix");
	});

	test("dump waits for rejected asynchronous writes before reporting recovery availability", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "async.txt");
		const writer = instrumentArtifact(artifactPath);
		const pendingWrite = Promise.withResolvers<number>();
		vi.spyOn(writer, "write").mockReturnValue(pendingWrite.promise);
		const end = vi.spyOn(writer, "end");
		const sink = new OutputSink({ artifactPath, artifactId: "async", spillThreshold: 4 });
		sink.push("prefix");
		const dumping = sink.dump();
		pendingWrite.reject(new Error("asynchronous write failed"));
		const summary = await dumping;

		expect(summary.output).toBe("efix");
		expect(summary.artifactError).toBe("write");
		expect(summary.artifactId).toBeUndefined();
		expect(end).toHaveBeenCalledTimes(1);
	});

	test("flush failure still closes the writer and is surfaced without a recovery link", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "flush.txt");
		const writer = instrumentArtifact(artifactPath);
		vi.spyOn(writer, "flush").mockImplementation(() => {
			throw new Error("flush failed");
		});
		const end = vi.spyOn(writer, "end");
		const sink = new OutputSink({ artifactPath, artifactId: "flush", spillThreshold: 4 });
		sink.push("prefix");
		const summary = await sink.dump();
		await sink.dispose();

		expect(summary.artifactError).toBe("flush");
		expect(summary.artifactId).toBeUndefined();
		expect(end).toHaveBeenCalledTimes(1);
		expect(formatOutputNotice(outputMeta().truncationFromSummary(summary, { direction: "tail" }).get())).toContain(
			"not saved completely",
		);
	});

	test("concurrent finalization waits for end failure even after output was minimized", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "end.txt");
		const writer = instrumentArtifact(artifactPath);
		const close = writer.end.bind(writer);
		const closing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const end = vi.spyOn(writer, "end").mockImplementation(async () => {
			await close();
			closing.resolve();
			await release.promise;
			throw new Error("end failed");
		});
		const sink = new OutputSink({ artifactPath, artifactId: "end", spillThreshold: 4 });
		sink.push("prefix");
		sink.replace("ok");
		const disposing = sink.dispose();
		await closing.promise;
		const dumping = sink.dump();
		release.resolve();
		await disposing;
		const summary = await dumping;
		await sink.dispose();
		const notice = formatOutputNotice(outputMeta().truncationFromSummary(summary, { direction: "tail" }).get());

		expect(summary.output).toBe("ok");
		expect(summary.truncated).toBe(false);
		expect(summary.artifactError).toBe("end");
		expect(summary.artifactId).toBeUndefined();
		expect(notice).toContain("not saved completely");
		expect(notice).not.toContain("artifact://");
		expect(end).toHaveBeenCalledTimes(1);
		expect(await Bun.file(artifactPath).text()).toBe("prefix");
		const meta = outputMeta().truncationFromSummary(summary, { direction: "tail" }).get();
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("Expected dark theme");
		const component = bashToolRenderer.renderResult(
			{ content: [{ type: "text", text: summary.output + notice }], details: { meta }, isError: false },
			{ expanded: true, isPartial: false, renderContext: { isFullOutput: true } },
			uiTheme,
			{ command: "printf ok" },
		);
		const rendered = sanitizeText(component.render(160).join("\n"));
		expect(rendered).toContain("not saved completely");
		expect(rendered).not.toContain("artifact://");
	});
});
