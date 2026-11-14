import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createLspWritethrough } from "@oh-my-pi/pi-coding-agent/lsp";
import { FileFormatResult } from "@oh-my-pi/pi-tui/tools/lsp";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import type { LinterClient, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { DeferredDiagnosticsEntry, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { addFileWriteFallback } from "@oh-my-pi/pi-coding-agent/tools/file-write-fallback";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
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

		expect(firstResult.finalContent).toBe("const a = 1;\n");
		expect(getServersSpy).toHaveBeenCalledTimes(0);
		expect(loadConfigSpy).toHaveBeenCalledTimes(0);
		expect(await Bun.file(fileA).text()).toBe("const a = 1;\n");

		const secondResult = await writethrough(fileB, "const b = 2;\n", undefined, undefined, {
			id: batchId,
			flush: true,
		});

		expect(secondResult.finalContent).toBe("const b = 2;\n");
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
		const result = await writethrough(fileB, "const other=1\n", undefined, undefined, {
			id: batchId,
			flush: true,
		});
		expect(result.finalContent).toBe("const other = 1;\n");

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

		expect(result.diagnostics?.formatter).toBe(FileFormatResult.FAILED);
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

		expect(result.finalContent).toBe("const single = true;\n");
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

/** A Python script whose leading shebang makes `write` add execute bits. */
const SHEBANG_SCRIPT = "#!/usr/bin/env python3\nprint('ok')\n";

/** One lint: the linted file's name and the permission bits the linter read from disk. */
interface LintedMode {
	file: string;
	mode: number;
}

// POSIX execute bits: Windows accepts chmod but keeps no execute bits.
describe.skipIf(process.platform === "win32")("write tool shebang execute bits under LSP diagnostics", () => {
	let tempDir: TempDir;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let linted: LintedMode[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-lsp-shebang-");
		sessionManager = SessionManager.inMemory(tempDir.path());
		authStorage = await AuthStorage.create(":memory:");
		linted = [];
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		authStorage.close();
		await sessionManager.close();
		tempDir.removeSync();
	});

	/**
	 * Diagnose `.py` writes with a linter that reads the file mode when it lints, as Ruff's
	 * EXE001 does: a file that starts with a shebang but has no execute bit is reported.
	 * `linted` records each mode read; `format` serves `lsp.formatOnWrite`.
	 */
	function useModeCheckingLinter(format: LinterClient["format"] = async (_filePath, content) => content): void {
		const linter: ServerConfig = {
			command: "test-mode-linter",
			fileTypes: ["py"],
			rootMarkers: [],
			createClient: () =>
				({
					format,
					lint: async filePath => {
						const mode = (await fs.stat(filePath)).mode & 0o777;
						linted.push({ file: path.basename(filePath), mode });
						if ((mode & 0o111) !== 0 || !(await Bun.file(filePath).text()).startsWith("#!")) return [];
						return [
							{
								message: "Shebang is present but file is not executable",
								code: "EXE001",
								severity: 2,
								range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
							},
						];
					},
				}) satisfies LinterClient,
		};
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["mode-linter", linter]]);
	}

	function createSession(
		settings: Record<string, unknown> = {},
		queueDeferredDiagnostics?: (entry: DeferredDiagnosticsEntry) => void,
	): ToolSession {
		return {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			// Deduplication drops a clean late result, which the deferred test reads.
			settings: Settings.isolated({
				"lsp.diagnosticsOnWrite": true,
				"lsp.diagnosticsDeduplicate": false,
				...settings,
			}),
			enableLsp: true,
			queueDeferredDiagnostics,
		};
	}

	/** An existing script without execute bits, which a shebang write must add. */
	async function existingScript(name: string): Promise<string> {
		const filePath = path.join(tempDir.path(), name);
		await Bun.write(filePath, "print('old')\n");
		await fs.chmod(filePath, 0o644);
		return filePath;
	}

	it("lints a shebang write with the execute bits its notice reports", async () => {
		useModeCheckingLinter();
		const filePath = await existingScript("run.py");

		const result = await new WriteTool(createSession()).execute("write", { path: filePath, content: SHEBANG_SCRIPT });

		// A lint before the chmod reports EXE001 in the same result as the chmod notice.
		expect(result.details?.madeExecutable).toBe(true);
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining("[Notice: Made executable via chmod +x]"),
		});
		expect(result.details?.diagnostics?.messages).toEqual([]);
		expect(linted).toEqual([{ file: "run.py", mode: 0o755 }]);
	});

	it("lints a formatted shebang write with its execute bits", async () => {
		useModeCheckingLinter(async (_filePath, content) => content.replace("print( 'ok' )", "print('ok')"));
		const filePath = await existingScript("formatted.py");

		const result = await new WriteTool(createSession({ "lsp.formatOnWrite": true })).execute("write", {
			path: filePath,
			content: "#!/usr/bin/env python3\nprint( 'ok' )\n",
		});

		expect(await Bun.file(filePath).text()).toBe(SHEBANG_SCRIPT);
		expect(result.details?.madeExecutable).toBe(true);
		expect(result.details?.diagnostics?.messages).toEqual([]);
		expect(linted).toEqual([{ file: "formatted.py", mode: 0o755 }]);
	});

	it("lints the final write of a batch with its execute bits", async () => {
		useModeCheckingLinter();
		const first = await existingScript("first.py");
		const last = await existingScript("last.py");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const context: AgentToolContext = {
			sessionManager,
			modelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};
		const batch = {
			batchId: `shebang-batch-${Date.now()}`,
			total: 2,
			toolCalls: [
				{ id: "first", name: "write" },
				{ id: "last", name: "write" },
			],
		};
		const tool = new WriteTool(createSession());

		const unflushed = await tool.execute("first", { path: first, content: SHEBANG_SCRIPT }, undefined, undefined, {
			...context,
			toolCall: { ...batch, index: 0 },
		});
		const flushed = await tool.execute("last", { path: last, content: SHEBANG_SCRIPT }, undefined, undefined, {
			...context,
			toolCall: { ...batch, index: 1 },
		});

		// The flush lints both entries; the earlier one set its bits during its own call.
		expect(unflushed.details?.madeExecutable).toBe(true);
		expect(flushed.details?.madeExecutable).toBe(true);
		expect(flushed.details?.diagnostics?.messages).toEqual([]);
		expect(linted).toEqual([
			{ file: "first.py", mode: 0o755 },
			{ file: "last.py", mode: 0o755 },
		]);
	});

	it("sets the execute bits before late diagnostics of a write that outran its budget", async () => {
		// `runLspWritethrough`'s 5s operation budget: the formatter ends it and never answers.
		const budget = new AbortController();
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => (ms === 5_000 ? budget.signal : realTimeout(ms)));
		useModeCheckingLinter(() => {
			budget.abort();
			return Promise.withResolvers<string>().promise;
		});
		const filePath = await existingScript("slow.py");
		const late = Promise.withResolvers<DeferredDiagnosticsEntry>();

		const result = await new WriteTool(
			createSession({ "lsp.formatOnWrite": true }, entry => late.resolve(entry)),
		).execute("write", { path: filePath, content: SHEBANG_SCRIPT });

		expect(result.details?.diagnostics).toBeUndefined();
		expect(result.details?.madeExecutable).toBe(true);
		expect((await late.promise).messages).toEqual([]);
		expect(linted).toEqual([{ file: "slow.py", mode: 0o755 }]);
	});
});
