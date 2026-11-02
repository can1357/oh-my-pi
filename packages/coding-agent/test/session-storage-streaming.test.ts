import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("FileSessionStorage streamed rewrite durability", () => {
	it("preserves the saved transcript when a pending write later fails with ENOSPC", async () => {
		using tempDir = TempDir.createSync("omp-streamed-rewrite-");
		const sessionPath = path.join(tempDir.path(), "session.jsonl");
		const storage = new FileSessionStorage();
		const saved = '{"type":"session","id":"saved"}\n{"type":"message","text":"durable history"}\n';
		storage.writeTextSync(sessionPath, saved);
		const diskFull = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
		const writeStarted = Promise.withResolvers<void>();
		const completeWrite = Promise.withResolvers<number>();
		const createFile = Bun.file;

		vi.spyOn(Bun, "file").mockImplementation((input, options) => {
			const file =
				typeof input === "number"
					? createFile(input, options)
					: typeof input === "string" || input instanceof URL
						? createFile(input, options)
						: createFile(input, options);
			if (typeof input !== "string" || path.dirname(input) !== tempDir.path() || !input.endsWith(".tmp")) {
				return file;
			}
			const createWriter = file.writer.bind(file);
			vi.spyOn(file, "writer").mockImplementation(writerOptions => {
				const sink = createWriter(writerOptions);
				const write = sink.write.bind(sink);
				vi.spyOn(sink, "write").mockImplementationOnce(chunk => {
					const pending = Promise.resolve(write(chunk)).then(() => completeWrite.promise);
					// Keep the deliberately ignored pre-fix promise from poisoning other tests.
					// The public rewrite must still reject and preserve the saved transcript.
					void pending.catch(() => {});
					writeStarted.resolve();
					return pending;
				});
				return sink;
			});
			return file;
		});

		const rewrite = storage.writeLinesAtomic(sessionPath, [
			'{"type":"session","id":"replacement"}\n',
			'{"type":"message","text":"not durably saved"}\n',
		]);
		const outcome = rewrite.then(
			() => null,
			error => error,
		);
		await writeStarted.promise;
		completeWrite.reject(diskFull);
		const error = await outcome;

		expect(await Bun.file(sessionPath).text()).toBe(saved);
		expect(error).toMatchObject({ code: "ENOSPC" });
	});
});
