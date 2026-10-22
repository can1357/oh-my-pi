import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import type { Diagnostic, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { LspToolDetails } from "@oh-my-pi/pi-tui/tools/lsp";
import { TempDir } from "@oh-my-pi/pi-utils";
import { installHandshakeLsp } from "../helpers/fake-lsp";

const realImmediate = globalThis.setImmediate;
const CLEAN = "pub fn value() -> u32 { 1 }\n";
const BROKEN = 'pub fn value() -> u32 { "wrong" }\n';
const MISMATCH: Diagnostic = {
	message: "mismatched types: expected `u32`, found `&str`",
	code: "E0308",
	severity: 1,
	source: "rust-analyzer",
	range: { start: { line: 0, character: 24 }, end: { line: 0, character: 31 } },
};

class DiagnosticClock {
	now = 1_000_000;
	#sleepers = 0;

	install(): void {
		vi.useFakeTimers();
		vi.spyOn(Date, "now").mockImplementation(() => this.now);
		vi.spyOn(Bun, "sleep").mockImplementation(((ms: number) => {
			this.#sleepers++;
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(() => {
				this.#sleepers--;
				resolve();
			}, ms);
			return promise;
		}) as typeof Bun.sleep);
	}

	async drive<T>(operation: Promise<T>, caller: AbortController, budgetMs: number): Promise<T> {
		const deadline = this.now + budgetMs;
		let done = false;
		const settled = operation.finally(() => {
			done = true;
		});
		const pump = async () => {
			while (!done) {
				// Drain filesystem I/O and framed RPC before advancing virtual analysis time.
				const { promise, resolve } = Promise.withResolvers<void>();
				realImmediate(resolve);
				await promise;
				if (done) return;
				if (this.#sleepers > 0 || caller.signal.aborted) {
					this.now += 25;
					vi.advanceTimersByTime(25);
					if (this.now >= deadline) caller.abort(new ToolAbortError());
				}
			}
		};
		const pumping = pump();
		try {
			return await Promise.race([settled, pumping.then(() => settled)]);
		} finally {
			done = true;
			caller.abort();
			await pumping;
		}
	}
}

/** Rust diagnostic responses layered on the shared in-memory LSP transport. */
class CancellingRustServer {
	cancellationsRemaining = 0;
	cancellationData: { retriggerRequest: boolean } | undefined;
	publishOnCancellation: Diagnostic[] | undefined;
	cancelledPulls = 0;
	#documents = new Map<string, string>();

	install(): void {
		installHandshakeLsp(
			(message, server) => {
				if (message.method === "initialize") {
					for (const kind of ["begin", "end"]) {
						server.send({
							jsonrpc: "2.0",
							method: "$/progress",
							params: { token: "workspace", value: { kind } },
						});
					}
				} else if (message.method === "rust-analyzer/analyzerStatus") {
					server.send({ jsonrpc: "2.0", id: message.id, result: "Workspace loaded: 1 crate" });
				} else if (message.method === "textDocument/didOpen") {
					const { textDocument } = message.params as { textDocument: { uri: string; text: string } };
					this.#documents.set(textDocument.uri, textDocument.text);
				} else if (message.method === "textDocument/diagnostic") {
					const { textDocument } = message.params as { textDocument: { uri: string } };
					if (this.cancellationsRemaining > 0) {
						this.cancellationsRemaining--;
						this.cancelledPulls++;
						server.send({
							jsonrpc: "2.0",
							id: message.id,
							error: { code: -32802, message: "server cancelled the request", data: this.cancellationData },
						});
						const diagnostics = this.publishOnCancellation;
						if (diagnostics) {
							setTimeout(
								() =>
									server.send({
										jsonrpc: "2.0",
										method: "textDocument/publishDiagnostics",
										params: { uri: textDocument.uri, diagnostics },
									}),
								250,
							);
						}
						return;
					}
					const content = this.#documents.get(textDocument.uri) ?? "";
					setTimeout(() => {
						server.send({
							jsonrpc: "2.0",
							id: message.id,
							result: { kind: "full", items: content.includes('"wrong"') ? [MISMATCH] : [] },
						});
					}, 75);
				}
			},
			{ diagnosticProvider: true },
		);
	}
}

function textResult(result: AgentToolResult<LspToolDetails>): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

describe("Server-cancelled document diagnostics", () => {
	let tempDir: TempDir;
	let clock: DiagnosticClock;
	let server: CancellingRustServer;
	let tool: LspTool;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-lsp-cancelled-diagnostics-");
		await initTheme();
		await Bun.write(
			path.join(tempDir.path(), "Cargo.toml"),
			'[package]\nname = "cancelled_diagnostics"\nversion = "0.1.0"\nedition = "2021"\n',
		);
		await Bun.write(path.join(tempDir.path(), "src", "lib.rs"), CLEAN);
		const config: ServerConfig = {
			command: "rust-analyzer",
			fileTypes: ["rs"],
			rootMarkers: ["Cargo.toml"],
			workspaceReadyTimings: { settleMs: 0 },
		};
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
			servers: { "rust-analyzer": config },
			idleTimeoutMs: undefined,
		});
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["rust-analyzer", config]]);
		clock = new DiagnosticClock();
		clock.install();
		server = new CancellingRustServer();
		server.install();
		tool = new LspTool({
			cwd: tempDir.path(),
			settings: Settings.isolated({ "lsp.requestTimeout": 5 }),
		} as ToolSession);
	});

	afterEach(async () => {
		await lspClient.shutdownAll();
		vi.restoreAllMocks();
		vi.useRealTimers();
		tempDir.removeSync();
	});

	async function diagnostics(callerBudgetMs = 6_000) {
		const caller = new AbortController();
		return clock.drive(
			tool.execute("cancelled-diagnostics", { action: "diagnostics", file: "src/lib.rs" }, caller.signal),
			caller,
			callerBudgetMs,
		);
	}

	it("returns E0308 after the server cancels the first document pull", async () => {
		server.cancellationsRemaining = 1;
		await Bun.write(path.join(tempDir.path(), "src", "lib.rs"), BROKEN);
		const result = await diagnostics();
		expect(result.details?.success).toBe(true);
		expect(textResult(result)).toContain("E0308");
	});

	it("honors caller cancellation while the server repeatedly cancels document pulls", async () => {
		server.cancellationsRemaining = Infinity;
		const started = clock.now;
		await expect(diagnostics(300)).rejects.toBeInstanceOf(ToolAbortError);
		expect(server.cancelledPulls).toBeGreaterThan(1);
		expect(clock.now - started).toBeLessThanOrEqual(500);
	});

	it("keeps repeated server cancellations within the original diagnostics deadline", async () => {
		server.cancellationsRemaining = Infinity;
		const started = clock.now;
		const result = await diagnostics();
		expect(result.details?.success).toBe(false);
		expect(server.cancelledPulls).toBeGreaterThan(1);
		expect(clock.now - started).toBeLessThanOrEqual(5_250);
	});

	it("preserves a later published E0308 when retriggerRequest is false", async () => {
		server.cancellationsRemaining = 1;
		server.cancellationData = { retriggerRequest: false };
		server.publishOnCancellation = [MISMATCH];
		const result = await diagnostics();
		expect(result.details?.success).toBe(true);
		expect(textResult(result)).toContain("E0308");
	});
});
