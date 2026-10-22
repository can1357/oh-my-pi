import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import type { Diagnostic, LspClient, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { fileToUri } from "@oh-my-pi/pi-coding-agent/lsp/utils";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import * as piUtils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";

interface RpcMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: {
		textDocument?: { uri: string };
		token?: string;
		value?: { kind: string };
	};
	result?: unknown;
	error?: { code: number; message: string };
}

const WORKSPACE_STATUS = "Workspaces:\nLoaded 1 package across 1 workspace.";
const ATTACHED_STATUS = `${WORKSPACE_STATUS}\nCrates for file: coverage_fixture`;
const UNATTACHED_STATUS = `${WORKSPACE_STATUS}\nDoes not belong to any crate`;

const FINDING: Diagnostic = {
	range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
	severity: 1,
	message: "expected u32, found str",
};

interface AnalyzerOptions {
	diagnostics?: Diagnostic[];
	diagnosticError?: string;
	documentStatusError?: string;
	onUnansweredDocumentStatus?: () => void;
}

// Replace only the subprocess, retaining the JSON-RPC client and diagnostics collector.
function createAnalyzer(unattachedUri: string, options: AnalyzerOptions): LspClient["proc"] {
	const encoder = new TextEncoder();
	let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			stdoutController = controller;
		},
	});
	const { promise: exited, resolve: resolveExited } = Promise.withResolvers<number>();
	let exitCode: number | null = null;
	let pendingBytes = Buffer.alloc(0);
	const send = (message: RpcMessage): void => {
		const body = JSON.stringify(message);
		stdoutController.enqueue(encoder.encode(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
	};
	const exit = (): void => {
		if (exitCode !== null) return;
		exitCode = 0;
		stdoutController.close();
		resolveExited(0);
	};
	const handle = (message: RpcMessage): void => {
		if (message.method === "initialize") {
			send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { diagnosticProvider: true } } });
			send({
				jsonrpc: "2.0",
				method: "$/progress",
				params: { token: "workspace", value: { kind: "begin" } },
			});
			send({
				jsonrpc: "2.0",
				method: "$/progress",
				params: { token: "workspace", value: { kind: "end" } },
			});
		} else if (message.method === "rust-analyzer/analyzerStatus") {
			const uri = message.params?.textDocument?.uri;
			if (uri !== undefined) {
				if (options.onUnansweredDocumentStatus) {
					options.onUnansweredDocumentStatus();
					return;
				}
				if (options.documentStatusError) {
					send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: options.documentStatusError } });
					return;
				}
			}
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: uri === undefined ? WORKSPACE_STATUS : uri === unattachedUri ? UNATTACHED_STATUS : ATTACHED_STATUS,
			});
		} else if (message.method === "textDocument/diagnostic") {
			if (options.diagnosticError) {
				send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: options.diagnosticError } });
			} else {
				send({ jsonrpc: "2.0", id: message.id, result: { kind: "full", items: options.diagnostics ?? [] } });
			}
		} else if (message.method === "shutdown") {
			send({ jsonrpc: "2.0", id: message.id, result: null });
		} else if (message.method === "exit") {
			exit();
		} else if (message.id !== undefined) {
			send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
		}
	};
	const proc = {
		get exited() {
			return exited;
		},
		get exitCode() {
			return exitCode;
		},
		stdout,
		stdin: {
			write(raw: string | Uint8Array) {
				const chunk = typeof raw === "string" ? Buffer.from(raw, "utf-8") : Buffer.from(raw);
				pendingBytes = pendingBytes.length === 0 ? chunk : Buffer.concat([pendingBytes, chunk]);
				while (true) {
					const headerEnd = pendingBytes.indexOf("\r\n\r\n");
					if (headerEnd === -1) break;
					const length = /Content-Length: (\d+)/i.exec(pendingBytes.toString("utf-8", 0, headerEnd));
					if (!length) throw new Error("Missing LSP Content-Length");
					const start = headerEnd + 4;
					const end = start + Number(length[1]);
					if (pendingBytes.length < end) break;
					const message = JSON.parse(pendingBytes.toString("utf-8", start, end)) as RpcMessage;
					pendingBytes = pendingBytes.subarray(end);
					handle(message);
				}
				return chunk.byteLength;
			},
			flush: async () => 0,
			end: async () => 0,
		},
		peekStderr: () => "",
		kill: exit,
	} as unknown as LspClient["proc"];
	return proc;
}

function installRustAnalyzer(
	unattachedUri: string,
	options: AnalyzerOptions = {},
	secondary: AnalyzerOptions = {},
): void {
	const spawn = ((argv: string[]) =>
		createAnalyzer(
			unattachedUri,
			argv.includes("--secondary") ? secondary : options,
		)) as unknown as typeof piUtils.ptree.spawn;
	vi.spyOn(piUtils.ptree, "spawn").mockImplementation(spawn);
}

function resultText(result: AgentToolResult): string {
	return result.content.flatMap(content => (content.type === "text" ? [content.text] : [])).join("\n");
}

function installVirtualTime(): void {
	let now = Date.now();
	vi.spyOn(Date, "now").mockImplementation(() => now);
	vi.spyOn(Bun, "sleep").mockImplementation(((ms: number) => {
		now += ms;
		return Promise.resolve();
	}) as typeof Bun.sleep);
}

describe("Rust explicit diagnostics document coverage", () => {
	let tempDir: TempDir;
	let workspace: string;
	let attachedFile: string;
	let unattachedFile: string;
	let tool: LspTool;
	let serverConfig: ServerConfig;

	function configureSecondary(first: boolean): void {
		const secondaryConfig: ServerConfig = {
			...serverConfig,
			command: "secondary-rust",
			args: ["--secondary"],
		};
		const primary: [string, ServerConfig] = ["rust-analyzer", serverConfig];
		const secondary: [string, ServerConfig] = ["secondary-rust", secondaryConfig];
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue(first ? [secondary, primary] : [primary, secondary]);
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-lsp-rust-coverage-");
		workspace = path.join(tempDir.path(), "workspace");
		attachedFile = path.join(workspace, "src", "main.rs");
		unattachedFile = path.join(tempDir.path(), "external", "detached.rs");
		await Bun.write(path.join(workspace, "Cargo.toml"), '[package]\nname = "coverage_fixture"\nversion = "0.0.0"\n');
		await Bun.write(attachedFile, "fn main() {}\n");
		await Bun.write(unattachedFile, 'const BAD: u32 = "wrong";\n');
		await initTheme();
		installVirtualTime();
		serverConfig = {
			command: "rust-analyzer",
			resolvedCommand: process.execPath,
			fileTypes: ["rs"],
			rootMarkers: ["Cargo.toml"],
			workspaceReadyTimings: { settleMs: 0 },
		};
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
			servers: { "rust-analyzer": serverConfig },
			idleTimeoutMs: undefined,
		});
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["rust-analyzer", serverConfig]]);
		tool = new LspTool({ cwd: workspace, settings: Settings.isolated() } as ToolSession);
	});

	afterEach(async () => {
		await lspClient.shutdownAll();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	it("reports analysis unavailable for an unattached file despite a usable workspace and full-empty report", async () => {
		installRustAnalyzer(fileToUri(unattachedFile));
		const attached = await tool.execute("attached-before-external", {
			action: "diagnostics",
			file: attachedFile,
			timeout: 5,
		});
		expect(attached.details?.success).toBe(true);

		const result = await tool.execute("unattached-rust", {
			action: "diagnostics",
			file: unattachedFile,
			timeout: 5,
		});

		expect(result.details?.success).toBe(false);
		expect(result.content.some(content => content.type === "text" && /unavailable/i.test(content.text))).toBe(true);
		expect(result.content.some(content => content.type === "text" && /crate/i.test(content.text))).toBe(true);
	});

	it("accepts a full-empty report for an attached crate root", async () => {
		installRustAnalyzer(fileToUri(unattachedFile));
		const result = await tool.execute("attached-clean-rust", {
			action: "diagnostics",
			file: attachedFile,
			timeout: 5,
		});

		expect(result.details?.success).toBe(true);
	});

	it("preserves non-empty Rust diagnostics when document status would fail", async () => {
		installRustAnalyzer(fileToUri(unattachedFile), {
			diagnostics: [FINDING],
			documentStatusError: "document status failed",
		});
		const result = await tool.execute("rust-findings-status-error", {
			action: "diagnostics",
			file: unattachedFile,
			timeout: 5,
		});

		expect(result.details?.success).toBe(true);
		expect(resultText(result)).toContain(FINDING.message);
	});

	it("returns non-empty Rust diagnostics without waiting for an unanswered document status", async () => {
		const statusRequested = Promise.withResolvers<"blocked">();
		const controller = new AbortController();
		installRustAnalyzer(fileToUri(unattachedFile), {
			diagnostics: [FINDING],
			onUnansweredDocumentStatus: () => statusRequested.resolve("blocked"),
		});
		const pending = tool.execute(
			"rust-findings-status-unanswered",
			{ action: "diagnostics", file: unattachedFile, timeout: 5 },
			controller.signal,
		);
		const outcome = pending.then(
			result => ({ result }),
			error => ({ error }),
		);
		try {
			const first = await Promise.race([outcome, statusRequested.promise]);
			expect(first).not.toBe("blocked");
			if (first === "blocked") return;
			if ("error" in first) throw first.error;
			expect(first.result.details?.success).toBe(true);
			expect(resultText(first.result)).toContain(FINDING.message);
		} finally {
			controller.abort();
			await outcome;
		}
	});

	it.each([false, true])(
		"does not accept another server's empty result as crate coverage (secondary first: %s)",
		async secondaryFirst => {
			configureSecondary(secondaryFirst);
			installRustAnalyzer(fileToUri(unattachedFile));
			const result = await tool.execute("mixed-empty-unattached", {
				action: "diagnostics",
				file: unattachedFile,
				timeout: 5,
			});

			expect(result.details?.success).toBe(false);
			expect(resultText(result)).toMatch(/unavailable/i);
			expect(resultText(result)).toMatch(/crate/i);
			expect(resultText(result)).not.toMatch(/^OK\b/);
		},
	);

	it("preserves another server's findings while reporting unavailable Rust crate coverage", async () => {
		configureSecondary(false);
		installRustAnalyzer(fileToUri(unattachedFile), {}, { diagnostics: [FINDING] });
		const result = await tool.execute("mixed-findings-unattached", {
			action: "diagnostics",
			file: unattachedFile,
			timeout: 5,
		});

		expect(result.details?.success).toBe(false);
		expect(resultText(result)).toContain(FINDING.message);
		expect(resultText(result)).toMatch(/unavailable/i);
	});

	it("preserves secondary findings when empty Rust diagnostics have an unanswered membership lookup", async () => {
		configureSecondary(true);
		const realSetImmediate = globalThis.setImmediate;
		vi.useFakeTimers();
		const statusRequested = Promise.withResolvers<void>();
		const controller = new AbortController();
		installRustAnalyzer(
			fileToUri(unattachedFile),
			{ onUnansweredDocumentStatus: () => statusRequested.resolve() },
			{ diagnostics: [FINDING] },
		);
		const pending = tool.execute(
			"mixed-findings-status-unanswered",
			{ action: "diagnostics", file: unattachedFile, timeout: 5 },
			controller.signal,
		);
		const outcome = pending.then(
			result => ({ result }),
			error => ({ error }),
		);
		try {
			await statusRequested.promise;
			vi.advanceTimersByTime(4_999);
			const fence = Promise.withResolvers<"blocked">();
			realSetImmediate(() => fence.resolve("blocked"));
			const first = await Promise.race([outcome, fence.promise]);

			expect(first).not.toBe("blocked");
			if (first === "blocked") return;
			if ("error" in first) throw first.error;
			expect(first.result.details?.success).toBe(false);
			expect(resultText(first.result)).toContain(FINDING.message);
			expect(resultText(first.result)).toMatch(/unavailable/i);
		} finally {
			controller.abort();
			await outcome;
			vi.useRealTimers();
		}
	});

	it("keeps a multi-file result unavailable when another target has a valid empty Rust report", async () => {
		installRustAnalyzer(fileToUri(unattachedFile));
		const result = await tool.execute("batch-unattached-rust", {
			action: "diagnostics",
			file: path.join(tempDir.path(), "**", "*.rs"),
			timeout: 5,
		});

		expect(result.details?.success).toBe(false);
		expect(resultText(result)).toMatch(/main\.rs: no issues/);
		expect(resultText(result)).toMatch(/detached\.rs.*unavailable/i);
		expect(resultText(result)).not.toMatch(/detached\.rs: no issues/);
	});

	it("preserves multi-file findings without labeling unattached Rust targets clean", async () => {
		configureSecondary(true);
		installRustAnalyzer(fileToUri(unattachedFile), {}, { diagnostics: [FINDING] });
		const result = await tool.execute("batch-mixed-findings", {
			action: "diagnostics",
			file: path.join(tempDir.path(), "**", "*.rs"),
			timeout: 5,
		});

		expect(result.details?.success).toBe(false);
		expect(resultText(result)).toContain(FINDING.message);
		expect(resultText(result)).toMatch(/detached\.rs.*unavailable/i);
	});

	it("does not expose hostile status errors and retains an understandable crate-verification reason", async () => {
		configureSecondary(false);
		const hostile = `\t\u001b[31m/private/secret.rs ${process.env.HOME}/secret.rs ${"x".repeat(10_000)}`;
		installRustAnalyzer(fileToUri(unattachedFile), { documentStatusError: hostile });
		const result = await tool.execute("hostile-status-error", {
			action: "diagnostics",
			file: unattachedFile,
			timeout: 5,
		});

		expect(result.details?.success).toBe(false);
		const text = resultText(result);
		expect(text).toMatch(/unavailable/i);
		expect(text).toMatch(/crate/i);
		expect(text).not.toMatch(/[\t\u001b]/);
		expect(text).not.toContain("/private/secret.rs");
		expect(text).not.toContain(`${process.env.HOME}/secret.rs`);
		expect(text.length).toBeLessThan(1_000);
	});

	it.each([
		{ branch: "single total failure", batch: false, secondary: false, findings: false },
		{ branch: "single partial empty", batch: false, secondary: true, findings: false },
		{ branch: "single partial findings", batch: false, secondary: true, findings: true },
		{ branch: "batch total failure", batch: true, secondary: false, findings: false },
		{ branch: "batch partial empty", batch: true, secondary: true, findings: false },
		{ branch: "batch partial findings", batch: true, secondary: true, findings: true },
	])("keeps arbitrary RPC failure text out of $branch output", async ({ batch, secondary, findings }) => {
		if (secondary) configureSecondary(false);
		const hostile = `\t\u001b[31m/private/secret.rs ${process.env.HOME}/secret.rs ${"x".repeat(10_000)}`;
		installRustAnalyzer(
			fileToUri(unattachedFile),
			{ diagnosticError: hostile },
			{ diagnostics: findings ? [FINDING] : [] },
		);
		const result = await tool.execute("hostile-diagnostic-error", {
			action: "diagnostics",
			file: batch ? path.join(tempDir.path(), "**", "*.rs") : unattachedFile,
			timeout: 5,
		});

		const text = resultText(result);
		expect(text).not.toMatch(/[\t\u001b]/);
		expect(text).not.toContain("/private/secret.rs");
		expect(text).not.toContain(`${process.env.HOME}/secret.rs`);
		expect(text.length).toBeLessThan(1_000);
		if (findings) expect(text).toContain(FINDING.message);
	});
});
