import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLspWritethrough, FileFormatResult } from "@oh-my-pi/pi-coding-agent/lsp";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import type { LinterClient, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { addFileWriteFallback } from "@oh-my-pi/pi-coding-agent/tools/file-write-fallback";
import { TempDir } from "@oh-my-pi/pi-utils";

function createFormatter(format: (filePath: string, content: string) => Promise<string>): ServerConfig {
	return {
		command: "test-formatter",
		fileTypes: ["ts"],
		rootMarkers: [],
		createClient: () =>
			({
				format,
				lint: async () => [],
			}) satisfies LinterClient,
	};
}

describe("createLspWritethrough batching", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-lsp-batch-");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	it("defers LSP work until the batch flush", async () => {
		const loadConfigSpy = vi
			.spyOn(lspConfig, "loadConfig")
			.mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		const getServersSpy = vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([]);
		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: true, enableDiagnostics: true });

		const fileA = path.join(tempDir.path(), "a.ts");
		const fileB = path.join(tempDir.path(), "b.ts");
		const batchId = `batch-${Date.now()}`;

		const firstResult = await writethrough(fileA, "const a = 1;\n", undefined, undefined, {
			id: batchId,
			flush: false,
		});

		expect(firstResult).toBeUndefined();
		expect(getServersSpy).toHaveBeenCalledTimes(0);
		expect(loadConfigSpy).toHaveBeenCalledTimes(0);
		expect(await Bun.file(fileA).text()).toBe("const a = 1;\n");

		const secondResult = await writethrough(fileB, "const b = 2;\n", undefined, undefined, {
			id: batchId,
			flush: true,
		});

		expect(secondResult).toBeUndefined();
		expect(getServersSpy).toHaveBeenCalledTimes(2);
		expect(loadConfigSpy).toHaveBeenCalledTimes(1);
		expect(await Bun.file(fileA).text()).toBe("const a = 1;\n");
		expect(await Bun.file(fileB).text()).toBe("const b = 2;\n");
	});

	it("preserves a newer external change made before the batch flush", async () => {
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([]);
		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: true, enableDiagnostics: true });

		const fileA = path.join(tempDir.path(), "a.ts");
		const fileB = path.join(tempDir.path(), "b.ts");
		const batchId = `external-change-${Date.now()}`;
		await writethrough(fileA, "const value = 'tool';\n", undefined, undefined, {
			id: batchId,
			flush: false,
		});

		await Bun.write(fileA, "const value = 'external';\n");
		await writethrough(fileB, "const other = true;\n", undefined, undefined, {
			id: batchId,
			flush: true,
		});

		expect(await Bun.file(fileA).text()).toBe("const value = 'external';\n");
		expect(await Bun.file(fileB).text()).toBe("const other = true;\n");
	});

	it("does not recreate a file deleted before the batch flush", async () => {
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([]);
		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: true, enableDiagnostics: true });

		const fileA = path.join(tempDir.path(), "a.ts");
		const fileB = path.join(tempDir.path(), "b.ts");
		const batchId = `external-delete-${Date.now()}`;
		await writethrough(fileA, "const removed = true;\n", undefined, undefined, {
			id: batchId,
			flush: false,
		});

		await Bun.file(fileA).unlink();
		await writethrough(fileB, "const survivor = true;\n", undefined, undefined, {
			id: batchId,
			flush: true,
		});

		expect(await Bun.file(fileA).exists()).toBe(false);
		expect(await Bun.file(fileB).text()).toBe("const survivor = true;\n");
	});

	it("preserves a UTF-8 BOM when batch formatting changes content", async () => {
		const formatter = createFormatter(async (_filePath, content) => content.replace("=1", " = 1;"));
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["formatter", formatter]]);
		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: true,
			enableDiagnostics: false,
		});

		const fileA = path.join(tempDir.path(), "a.ts");
		const fileB = path.join(tempDir.path(), "b.ts");
		const batchId = `bom-${Date.now()}`;
		await writethrough(fileA, "\uFEFFconst value=1\n", undefined, undefined, {
			id: batchId,
			flush: false,
		});
		await writethrough(fileB, "const other=1\n", undefined, undefined, {
			id: batchId,
			flush: true,
		});

		const bytes = new Uint8Array(await Bun.file(fileA).arrayBuffer());
		expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		expect(Buffer.from(bytes).toString("utf8")).toBe("\uFEFFconst value = 1;\n");
	});
	it("preserves formatter failures when merging batch results", async () => {
		const formatter = createFormatter(async () => {
			throw new Error("formatter crashed");
		});
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["broken-formatter", formatter]]);
		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: true,
			enableDiagnostics: false,
		});

		const batchId = "formatter-failure";
		await writethrough(path.join(tempDir.path(), "a.ts"), "const a=1\n", undefined, undefined, {
			id: batchId,
			flush: false,
		});
		const result = await writethrough(path.join(tempDir.path(), "b.ts"), "const b=1\n", undefined, undefined, {
			id: batchId,
			flush: true,
		});

		expect(result?.formatter).toBe(FileFormatResult.FAILED);
	});

	it("flushes earlier entries when the final batch write fails", async () => {
		const loadConfigSpy = vi
			.spyOn(lspConfig, "loadConfig")
			.mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		const getServersSpy = vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([]);
		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: true, enableDiagnostics: true });

		const fileA = path.join(tempDir.path(), "a.ts");
		const fileB = path.join(tempDir.path(), "b.ts");
		const batchId = `final-write-failure-${Date.now()}`;
		await writethrough(fileA, "const applied = true;\n", undefined, undefined, {
			id: batchId,
			flush: false,
		});
		vi.spyOn(Bun, "write").mockRejectedValueOnce(new Error("ENOSPC"));

		await expect(
			writethrough(fileB, "const failed = true;\n", undefined, undefined, {
				id: batchId,
				flush: true,
			}),
		).rejects.toThrow("ENOSPC");

		expect(getServersSpy).toHaveBeenCalledTimes(1);
		expect(loadConfigSpy).toHaveBeenCalledTimes(1);
		expect(await Bun.file(fileA).text()).toBe("const applied = true;\n");
		expect(await Bun.file(fileB).exists()).toBe(false);
	});

	it("runs LSP immediately when no batch is provided", async () => {
		const loadConfigSpy = vi
			.spyOn(lspConfig, "loadConfig")
			.mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		const getServersSpy = vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([]);
		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: true, enableDiagnostics: true });

		const filePath = path.join(tempDir.path(), "single.ts");
		const result = await writethrough(filePath, "const single = true;\n");

		expect(result).toBeUndefined();
		expect(getServersSpy).toHaveBeenCalledTimes(1);
		expect(loadConfigSpy).toHaveBeenCalledTimes(1);
		expect(await Bun.file(filePath).text()).toBe("const single = true;\n");
	});
});

// A privileged user is not constrained by mode bits: a 0o000 file stays both
// writable and readable, so the write would never be denied and the seam under
// test would never engage.
describe.skipIf(process.getuid?.() === 0)("createLspWritethrough batching with a brokered write", () => {
	let tempDir: TempDir;
	let root = "";
	const disposers: Array<() => void> = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-lsp-batch-broker-");
		// The seam hands handlers a symlink-resolved path and `os.tmpdir()` sits
		// under `/var` — itself a link — on macOS, so a lexical fixture root would
		// differ from the brokered path for a reason unrelated to this test.
		root = await fs.realpath(tempDir.path());
	});

	afterEach(async () => {
		for (const dispose of disposers.splice(0)) dispose();
		vi.restoreAllMocks();
		await fs.chmod(path.join(root, "opaque.ts"), 0o600).catch(() => {});
		tempDir.removeSync();
	});

	it("flushes a batch whose brokered destination cannot be read back", async () => {
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([]);
		const writethrough = createLspWritethrough(root, { enableFormat: true, enableDiagnostics: true });

		// Denied for writing and for reading at once, which is what a sandbox that
		// hides a path produces: the direct write fails, a privileged helper lands
		// the bytes, and this process still cannot read them back.
		const opaque = path.join(root, "opaque.ts");
		await Bun.write(opaque, "const before = true;\n");
		await fs.chmod(opaque, 0o000);

		const brokered: Array<{ dst: string; content: string }> = [];
		disposers.push(
			addFileWriteFallback(async req => {
				brokered.push({ dst: req.dst, content: req.content });
				await fs.chmod(req.dst, 0o600);
				await Bun.write(req.dst, req.content);
				await fs.chmod(req.dst, 0o000);
				return true;
			}),
		);

		const sibling = path.join(root, "sibling.ts");
		const batchId = `brokered-${Date.now()}`;
		await writethrough(opaque, "const after = true;\n", undefined, undefined, { id: batchId, flush: false });
		await writethrough(sibling, "const other = true;\n", undefined, undefined, { id: batchId, flush: true });

		expect(brokered).toEqual([{ dst: opaque, content: "const after = true;\n" }]);
		expect(await Bun.file(sibling).text()).toBe("const other = true;\n");
		await fs.chmod(opaque, 0o400);
		expect(await Bun.file(opaque).text()).toBe("const after = true;\n");
	});
});
