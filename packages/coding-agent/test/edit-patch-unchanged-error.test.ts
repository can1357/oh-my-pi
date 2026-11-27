import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import * as lsp from "@oh-my-pi/pi-coding-agent/lsp";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import type { LinterClient, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as fileWriteFallback from "@oh-my-pi/pi-coding-agent/tools/file-write-fallback";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function makeSession(
	cwd: string,
	options: { enableLsp?: boolean; settings?: Record<string, unknown> } = {},
): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: options.enableLsp ?? false,
		settings: Settings.isolated({ "edit.mode": "patch", ...options.settings }),
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as ToolSession;
}

function createFormatter(
	fileTypes: string[],
	format: (filePath: string, content: string) => Promise<string>,
): ServerConfig {
	return {
		command: "test-formatter",
		fileTypes,
		rootMarkers: [],
		createClient: () =>
			({
				format,
				lint: async () => [],
			}) satisfies LinterClient,
	};
}

let tempDir: string;

beforeEach(async () => {
	resetSettingsForTest();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-patch-unchanged-"));
	await Settings.init({ inMemory: true, cwd: tempDir });
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	await removeWithRetries(tempDir);
});

describe("EditTool patch post-write verification", () => {
	test("returns the caller-facing path when a reported write leaves disk unchanged", async () => {
		const relPath = "deep/nested/foo.txt";
		await fs.mkdir(path.join(tempDir, "deep", "nested"), { recursive: true });
		await fs.writeFile(path.join(tempDir, relPath), "a\n");

		vi.spyOn(lsp, "writethroughNoop").mockImplementation(async () => ({ finalContent: "" }));
		const result = await new EditTool(makeSession(tempDir), "patch").execute("unchanged", {
			path: relPath,
			edits: [{ op: "update", diff: "@@\n-a\n+b" }],
		});
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

		expect(result.isError).toBe(true);
		expect(text).toContain(`edit appeared successful but file content did not change on disk: ${relPath}`);
		expect(text).not.toContain(tempDir);
		expect(await Bun.file(path.join(tempDir, relPath)).text()).toBe("a\n");
	});

	test("accepts a formatter restoring the pre-write content", async () => {
		const relPath = "example.py";
		const original = "def run():\n    pass\n";
		const absolutePath = path.join(tempDir, relPath);
		await fs.writeFile(absolutePath, original);

		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([
			["formatter", createFormatter(["py"], async () => original)],
		]);
		vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();

		const session = makeSession(tempDir, {
			enableLsp: true,
			settings: { "lsp.formatOnWrite": true, "lsp.diagnosticsOnEdit": false },
		});
		const result = await new EditTool(session, "patch").execute("formatted-unchanged", {
			path: relPath,
			edits: [{ op: "update", diff: "@@\n def run():\n+    print('running')\n     pass" }],
		});

		expect(result.isError).not.toBe(true);
		expect(await Bun.file(absolutePath).text()).toBe(original);
		expect(result.details).toMatchObject({
			newText: original,
			diagnostics: { formatter: lsp.FileFormatResult.FORMATTED },
		});
	});

	test("accepts a formatter restoring the pre-write content when the LSP budget expires afterward", async () => {
		const relPath = "example.py";
		const original = "def run():\n    pass\n";
		const absolutePath = path.join(tempDir, relPath);
		await fs.writeFile(absolutePath, original);

		const budget = new AbortController();
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => (ms === 5_000 ? budget.signal : realTimeout(ms)));
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([
			["formatter", createFormatter(["py"], async () => original)],
		]);
		vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockImplementation(async (_cwd, _changes, notifySignal) => {
			if (notifySignal) {
				budget.abort();
				notifySignal.throwIfAborted();
			}
		});

		const session = makeSession(tempDir, {
			enableLsp: true,
			settings: { "lsp.formatOnWrite": true, "lsp.diagnosticsOnEdit": false },
		});
		const result = await new EditTool(session, "patch").execute("formatted-timeout", {
			path: relPath,
			edits: [{ op: "update", diff: "@@\n def run():\n+    print('running')\n     pass" }],
		});

		expect(result.isError).not.toBe(true);
		expect(await Bun.file(absolutePath).text()).toBe(original);
		expect(result.details?.diagnostics).toBeUndefined();
		expect(result.details?.newText).toBe(original);
	});

	test("scopes formatter outcomes per file when flushing a multi-edit LSP batch", async () => {
		const firstRel = "first.ts";
		const secondRel = "second.ts";
		const thirdRel = "third.ts";
		const firstPath = path.join(tempDir, firstRel);
		const secondPath = path.join(tempDir, secondRel);
		const thirdPath = path.join(tempDir, thirdRel);
		await fs.writeFile(firstPath, "export const a = 1;\n");
		await fs.writeFile(secondPath, "export const b = 1;\n");
		await fs.writeFile(thirdPath, "export const c = 1;\n");

		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([
			["formatter", createFormatter(["ts"], async (_filePath, content) => content.replace(/  +/g, " "))],
		]);
		vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();
		const realWrite = fileWriteFallback.writeFileWithFallback;
		vi.spyOn(fileWriteFallback, "writeFileWithFallback").mockImplementation(async (dst, content, file, signal) => {
			if (dst === secondPath) return;
			await realWrite(dst, content, file, signal);
		});

		const session = makeSession(tempDir, {
			enableLsp: true,
			settings: { "lsp.formatOnWrite": true, "lsp.diagnosticsOnEdit": false },
		});
		const tool = new EditTool(session, "patch");
		const lostBatchId = `edit-batch-lost-${Date.now()}`;
		const twoCalls = [
			{ id: "first", name: "edit" },
			{ id: "second", name: "edit" },
		];

		const firstResult = await tool.execute(
			"first",
			{ path: firstRel, edits: [{ op: "update", diff: "@@\n-export const a = 1;\n+export const a =  2;" }] },
			undefined,
			undefined,
			{ toolCall: { batchId: lostBatchId, index: 0, total: 2, toolCalls: twoCalls } } as AgentToolContext,
		);
		expect(firstResult.isError).not.toBe(true);

		const secondResult = await tool.execute(
			"second",
			{ path: secondRel, edits: [{ op: "update", diff: "@@\n-export const b = 1;\n+export const b = 2;" }] },
			undefined,
			undefined,
			{ toolCall: { batchId: lostBatchId, index: 1, total: 2, toolCalls: twoCalls } } as AgentToolContext,
		);
		const secondText = secondResult.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

		expect(secondResult.isError).toBe(true);
		expect(secondText).toContain(`edit appeared successful but file content did not change on disk: ${secondRel}`);
		expect(await Bun.file(firstPath).text()).toBe("export const a = 2;\n");
		expect(await Bun.file(secondPath).text()).toBe("export const b = 1;\n");

		const okBatchId = `edit-batch-ok-${Date.now()}`;
		await tool.execute(
			"first",
			{ path: firstRel, edits: [{ op: "update", diff: "@@\n-export const a = 2;\n+export const a = 3;" }] },
			undefined,
			undefined,
			{ toolCall: { batchId: okBatchId, index: 0, total: 2, toolCalls: twoCalls } } as AgentToolContext,
		);
		const thirdResult = await tool.execute(
			"second",
			{ path: thirdRel, edits: [{ op: "update", diff: "@@\n-export const c = 1;\n+export const c =  1;" }] },
			undefined,
			undefined,
			{ toolCall: { batchId: okBatchId, index: 1, total: 2, toolCalls: twoCalls } } as AgentToolContext,
		);

		expect(thirdResult.isError).not.toBe(true);
		expect(await Bun.file(thirdPath).text()).toBe("export const c = 1;\n");
		expect(thirdResult.details?.newText).toBe("export const c = 1;\n");
	});
});
