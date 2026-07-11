import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RenderResultOptions } from "@pk-nerdsaver-ai/pi-agent-core";
import { preloadPluginRoots } from "@pk-nerdsaver-ai/pi-coding-agent/discovery/helpers";
import { LspTool } from "@pk-nerdsaver-ai/pi-coding-agent/lsp";
import * as lspClient from "@pk-nerdsaver-ai/pi-coding-agent/lsp/client";
import * as lspConfig from "@pk-nerdsaver-ai/pi-coding-agent/lsp/config";
import { getServersForFile, type LspConfig, loadConfig } from "@pk-nerdsaver-ai/pi-coding-agent/lsp/config";
import { applyTextEditsToString, applyWorkspaceEdit } from "@pk-nerdsaver-ai/pi-coding-agent/lsp/edits";
import { renderCall, renderResult } from "@pk-nerdsaver-ai/pi-coding-agent/lsp/render";
import type {
	CodeAction,
	CreateFile,
	DeleteFile,
	Diagnostic,
	LspClient,
	RenameFile,
	ServerConfig,
	SymbolInformation,
	TextDocumentEdit,
	WorkspaceEdit,
} from "@pk-nerdsaver-ai/pi-coding-agent/lsp/types";
import {
	applyCodeAction,
	collectGlobMatches,
	dedupeWorkspaceSymbols,
	detectLanguageId,
	fileToUri,
	filterWorkspaceSymbols,
	hasGlobPattern,
	resolveDiagnosticTargets,
	resolveSymbolColumn,
	uriToFile,
} from "@pk-nerdsaver-ai/pi-coding-agent/lsp/utils";
import { getThemeByName } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { clampTimeout } from "@pk-nerdsaver-ai/pi-coding-agent/tools/tool-timeouts";
import * as piUtils from "@pk-nerdsaver-ai/pi-utils";
import { sanitizeText, TempDir } from "@pk-nerdsaver-ai/pi-utils";
import DEFAULTS from "../../src/lsp/defaults.json" with { type: "json" };
import { getLanguageFromPath } from "../../src/utils/lang-from-path";

interface RpcMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message?: string };
}

interface FakeLspServer {
	/** Parsed JSON-RPC messages the client wrote to the server, in arrival order. */
	readonly received: RpcMessage[];
	/** Server -> client: frame and enqueue a JSON-RPC message onto stdout. */
	send(message: RpcMessage): void;
	/** Resolve the process `exited` promise and close stdout. */
	exit(code?: number): void;
	/** Whether the client invoked `proc.kill()` (production's hard-kill fallback). */
	readonly killed: boolean;
	/** Resolve once a received message matches `predicate` (already-seen or future). */
	waitFor(predicate: (message: RpcMessage) => boolean, timeoutMs?: number): Promise<RpcMessage>;
}

type FakeLspHandler = (message: RpcMessage, server: FakeLspServer) => void | Promise<void>;

// In-memory LSP transport fake. Replaces the real subprocess (`ptree.spawn`)
// with an in-process JSON-RPC peer so the initialize / shutdown / exit and
// workspace-folder handshakes resolve deterministically -- no subprocess spawn,
// no real-clock latency. Installed by spying on the shared `ptree` namespace
// object (NOT `mock.module`, which would leak across files); the suite's
// `afterEach` `vi.restoreAllMocks()` removes it.
function installFakeLsp(handler: FakeLspHandler): FakeLspServer {
	const encoder = new TextEncoder();
	const received: RpcMessage[] = [];
	const waiters: Array<{
		predicate: (message: RpcMessage) => boolean;
		resolve: (message: RpcMessage) => void;
		timer: Timer;
	}> = [];
	let exitCode: number | null = null;
	let killed = false;
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	const { promise: exited, resolve: resolveExited } = Promise.withResolvers<number>();

	const frame = (message: RpcMessage): Uint8Array => {
		const content = JSON.stringify(message);
		return encoder.encode(`Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n${content}`);
	};

	const stdout = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});

	const server: FakeLspServer = {
		received,
		send(message) {
			if (controller && exitCode === null) controller.enqueue(frame(message));
		},
		exit(code = 0) {
			if (exitCode !== null) return;
			exitCode = code;
			controller?.close();
			resolveExited(code);
		},
		get killed() {
			return killed;
		},
		waitFor(predicate, timeoutMs = 1_000) {
			const existing = received.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise<RpcMessage>((resolve, reject) => {
				const timer = setTimeout(() => {
					const index = waiters.findIndex(entry => entry.timer === timer);
					if (index >= 0) waiters.splice(index, 1);
					reject(new Error("FakeLspServer.waitFor: timed out"));
				}, timeoutMs);
				waiters.push({ predicate, resolve, timer });
			});
		},
	};

	// Frame + dispatch the client -> server byte stream. The chain serialises
	// handler runs so message ordering mirrors the wire.
	let pendingBytes = Buffer.alloc(0);
	let chain: Promise<void> = Promise.resolve();
	const feed = (raw: string | Uint8Array): void => {
		const chunk = typeof raw === "string" ? Buffer.from(raw, "utf-8") : Buffer.from(raw);
		pendingBytes = pendingBytes.length === 0 ? chunk : Buffer.concat([pendingBytes, chunk]);
		chain = chain.then(async () => {
			while (true) {
				const headerEnd = pendingBytes.indexOf("\r\n\r\n");
				if (headerEnd === -1) break;
				const match = /Content-Length: (\d+)/i.exec(pendingBytes.toString("utf-8", 0, headerEnd));
				if (!match) {
					pendingBytes = pendingBytes.subarray(headerEnd + 4);
					continue;
				}
				const start = headerEnd + 4;
				const end = start + Number(match[1]);
				if (pendingBytes.length < end) break;
				const message = JSON.parse(pendingBytes.toString("utf-8", start, end)) as RpcMessage;
				pendingBytes = pendingBytes.subarray(end);
				received.push(message);
				for (let i = waiters.length - 1; i >= 0; i--) {
					if (waiters[i].predicate(message)) {
						clearTimeout(waiters[i].timer);
						waiters[i].resolve(message);
						waiters.splice(i, 1);
					}
				}
				await handler(message, server);
			}
		});
	};

	const proc = {
		get exited() {
			return exited;
		},
		get exitCode() {
			return exitCode;
		},
		stdin: {
			write(chunk: string | Uint8Array) {
				feed(chunk);
				return typeof chunk === "string" ? Buffer.byteLength(chunk, "utf-8") : chunk.byteLength;
			},
			flush: async () => 0,
			end: async () => 0,
		},
		stdout,
		peekStderr: () => "",
		kill() {
			killed = true;
			server.exit(0);
		},
	} as unknown as LspClient["proc"];

	vi.spyOn(piUtils.ptree, "spawn").mockReturnValue(proc);
	return server;
}

describe("lsp regressions", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("detects bracket-style glob patterns", () => {
		expect(hasGlobPattern("src/[ab].ts")).toBe(true);
		expect(hasGlobPattern("src/**/*.ts")).toBe(true);
		expect(hasGlobPattern("src/main.ts")).toBe(false);
	});

	it("clamps LSP timeout to configured bounds", () => {
		expect(clampTimeout("lsp")).toBe(20);
		expect(clampTimeout("lsp", 1)).toBe(5);
		expect(clampTimeout("lsp", 1000)).toBe(60);
	});

	it("sends the LSP exit notification after shutdown completes", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-shutdown-");
		try {
			const server = installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});

			const config: ServerConfig = {
				command: "fake-lsp",
				fileTypes: ["ts"],
				rootMarkers: [],
			};

			await lspClient.getOrCreateClient(config, tempDir.path(), 1_000);
			await lspClient.shutdownAll();

			// Graceful handshake: the client sends `shutdown`, waits for its reply,
			// then sends the `exit` notification -- and never resorts to the hard
			// `proc.kill()` (production's SIGTERM fallback) because the server exits
			// cleanly on `exit`.
			const methods = server.received.map(message => message.method);
			const shutdownIndex = methods.indexOf("shutdown");
			const exitIndex = methods.indexOf("exit");
			expect(shutdownIndex).toBeGreaterThanOrEqual(0);
			expect(exitIndex).toBeGreaterThan(shutdownIndex);
			expect(server.killed).toBe(false);
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("advertises workspace folder support during LSP initialization", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-workspace-folders-");
		try {
			const server = installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});

			const config: ServerConfig = {
				command: "fake-lsp",
				fileTypes: ["rs"],
				rootMarkers: [],
			};

			await lspClient.getOrCreateClient(config, tempDir.path(), 1_000);

			const init = server.received.find(message => message.method === "initialize");
			const params = init?.params as {
				capabilities?: { workspace?: { workspaceFolders?: unknown } };
				workspaceFolders?: unknown;
			};

			expect(params.capabilities?.workspace?.workspaceFolders).toBe(true);
			expect(params.workspaceFolders).toEqual([
				{ uri: fileToUri(tempDir.path()), name: path.basename(tempDir.path()) },
			]);
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("answers workspace/workspaceFolders requests with the current folder set", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-workspace-folders-request-");
		try {
			const server = installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
					// Server-initiated request: the client must answer with the folder set.
					srv.send({ jsonrpc: "2.0", id: 9001, method: "workspace/workspaceFolders" });
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});

			const config: ServerConfig = {
				command: "fake-lsp",
				fileTypes: ["rs"],
				rootMarkers: [],
			};

			await lspClient.getOrCreateClient(config, tempDir.path(), 1_000);
			const response = await server.waitFor(message => message.id === 9001 && message.method === undefined);

			expect(response.error).toBeUndefined();
			expect(response.result).toEqual([{ uri: fileToUri(tempDir.path()), name: path.basename(tempDir.path()) }]);
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("accepts dynamic capability registration before semantic requests", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-dynamic-registration-");
		try {
			let dynamicRegistrationAccepted = false;
			const server = installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { hoverProvider: true } } });
				} else if (message.method === "initialized") {
					srv.send({
						jsonrpc: "2.0",
						id: 9002,
						method: "client/registerCapability",
						params: {
							registrations: [
								{
									id: "-42",
									method: "workspace/didChangeWatchedFiles",
									registerOptions: {
										watchers: [{ globPattern: "**/mix.lock" }, { globPattern: "**/*.{ex,exs}" }],
									},
								},
							],
						},
					});
					srv.send({
						jsonrpc: "2.0",
						id: "expert-unregister-1",
						method: "client/unregisterCapability",
						params: { unregisterations: [{ id: "-42", method: "workspace/didChangeWatchedFiles" }] },
					});
				} else if (message.id === 9002 && message.method === undefined) {
					dynamicRegistrationAccepted = message.error === undefined;
				} else if (message.method === "textDocument/hover" && dynamicRegistrationAccepted) {
					srv.send({ jsonrpc: "2.0", id: message.id, result: { contents: "Atas.version()" } });
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});

			const config: ServerConfig = {
				command: "fake-lsp",
				fileTypes: ["ex"],
				rootMarkers: [],
			};

			const client = await lspClient.getOrCreateClient(config, tempDir.path(), 1_000);
			const registerResponse = await server.waitFor(message => message.id === 9002 && message.method === undefined);
			const unregisterResponse = await server.waitFor(
				message => message.id === "expert-unregister-1" && message.method === undefined,
			);
			expect(registerResponse.error).toBeUndefined();
			expect(unregisterResponse.error).toBeUndefined();
			const result = await lspClient.sendRequest(
				client,
				"textDocument/hover",
				{
					textDocument: { uri: fileToUri(path.join(tempDir.path(), "lib", "atas.ex")) },
					position: { line: 0, character: 0 },
				},
				undefined,
				50,
			);

			expect(result).toEqual({ contents: "Atas.version()" });
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("drains every workspace/configuration pull during lazy cold start when a pull id collides with an in-flight request", async () => {
		// #3001: basedpyright/pyright pull `workspace/configuration` repeatedly
		// during cold start and gate document analysis on every pull being
		// answered. Their pull ids live in the server's own id space and routinely
		// coincide with the client's in-flight request ids. The reader must route a
		// message by its `method` (a server-initiated request) BEFORE matching it
		// against pending client requests by id -- otherwise a colliding config
		// pull is swallowed as a bogus response, never answered, and the server
		// wedges (the lazy `lsp symbols` call returns nothing and hangs). The
		// eager warmup/reload path escapes this only because it issues no
		// concurrent semantic request while the cold-start pulls drain.
		const tempDir = TempDir.createSync("@omp-lsp-lazy-config-drain-");
		try {
			const symbols = [
				{
					name: "main",
					kind: 12,
					location: {
						uri: fileToUri(path.join(tempDir.path(), "main.py")),
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
					},
				},
			];

			// Pulls the server still awaits an answer for. The gated documentSymbol
			// response is withheld until this set drains, mirroring pyright.
			const unansweredConfigPulls = new Set<number | string>();
			let symbolReqId: number | string | undefined;
			let symbolsSent = false;

			installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					srv.send({
						jsonrpc: "2.0",
						id: message.id,
						result: { capabilities: { documentSymbolProvider: true } },
					});
					return;
				}
				if (message.method === "textDocument/documentSymbol") {
					symbolReqId = message.id;
					// Cold-start config storm issued while the request is in flight.
					// One pull uses a fresh server id; the other reuses the request's
					// own id (server + client id counters collide) and pulls the bare
					// `<server>` section the report flags as dropped.
					const pulls: Array<{ id: number | string; items: Array<{ section?: string }> }> = [
						{ id: 8200, items: [{ section: "basedpyright" }] },
						{ id: message.id as number, items: [{}] },
					];
					for (const pull of pulls) {
						unansweredConfigPulls.add(pull.id);
						srv.send({
							jsonrpc: "2.0",
							id: pull.id,
							method: "workspace/configuration",
							params: { items: pull.items },
						});
					}
					return;
				}
				// Client -> server config responses: an id + result, no method.
				if (message.method === undefined && message.id !== undefined && unansweredConfigPulls.has(message.id)) {
					unansweredConfigPulls.delete(message.id);
					if (unansweredConfigPulls.size === 0 && !symbolsSent && symbolReqId !== undefined) {
						symbolsSent = true;
						srv.send({ jsonrpc: "2.0", id: symbolReqId, result: symbols });
					}
					return;
				}
				if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});

			const config: ServerConfig = {
				command: "fake-lsp",
				fileTypes: ["py"],
				rootMarkers: [],
			};

			const client = await lspClient.getOrCreateClient(config, tempDir.path(), 1_000);
			const result = await lspClient.sendRequest(
				client,
				"textDocument/documentSymbol",
				{ textDocument: { uri: fileToUri(path.join(tempDir.path(), "main.py")) } },
				undefined,
				2_000,
			);

			// The gated request resolves with the server's real symbols only once the
			// client has answered every config pull -- including the one whose id
			// collided with this request. On baseline the colliding pull is
			// mis-routed as the documentSymbol response (resolving it with
			// `undefined`), so the pull is never answered and the server wedges.
			expect(result).toEqual(symbols);
			expect(unansweredConfigPulls.size).toBe(0);
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("answers defined server→client requests with spec no-op results", async () => {
		// Same failure class as #3029: a defined server→client request
		// (window/showMessage{Request}, window/showDocument, workspace/*/refresh)
		// must receive a spec-shaped reply, not a -32601. Headless omp can't
		// surface UI prompts but still owes a defined no-op.
		const tempDir = TempDir.createSync("@omp-lsp-server-requests-");
		try {
			const server = installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
				} else if (message.method === "initialized") {
					srv.send({
						jsonrpc: "2.0",
						id: 9101,
						method: "window/showMessageRequest",
						params: { type: 1, message: "x", actions: [{ title: "Cancel" }] },
					});
					srv.send({
						jsonrpc: "2.0",
						id: 9102,
						method: "window/showDocument",
						params: { uri: "file:///tmp/a.md" },
					});
					srv.send({ jsonrpc: "2.0", id: 9103, method: "workspace/semanticTokens/refresh" });
					srv.send({ jsonrpc: "2.0", id: 9104, method: "workspace/inlayHint/refresh" });
					srv.send({ jsonrpc: "2.0", id: 9105, method: "workspace/codeLens/refresh" });
					srv.send({ jsonrpc: "2.0", id: 9106, method: "workspace/diagnostic/refresh" });
					srv.send({ jsonrpc: "2.0", id: 9107, method: "workspace/inlineValue/refresh" });
					srv.send({ jsonrpc: "2.0", id: 9108, method: "workspace/foldingRange/refresh" });
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});

			const config: ServerConfig = {
				command: "fake-lsp",
				fileTypes: ["rs"],
				rootMarkers: [],
			};

			await lspClient.getOrCreateClient(config, tempDir.path(), 1_000);

			const showMessage = await server.waitFor(message => message.id === 9101 && message.method === undefined);
			expect(showMessage.error).toBeUndefined();
			expect(showMessage.result).toBeNull();

			const showDocument = await server.waitFor(message => message.id === 9102 && message.method === undefined);
			expect(showDocument.error).toBeUndefined();
			expect(showDocument.result).toEqual({ success: false });

			for (const id of [9103, 9104, 9105, 9106, 9107, 9108]) {
				const refresh = await server.waitFor(message => message.id === id && message.method === undefined);
				expect(refresh.error).toBeUndefined();
				expect(refresh.result).toBeNull();
			}
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("opens rust-analyzer Cargo workspace files before polling workspace readiness", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rust-workspace-");
		try {
			const sourcePath = path.join(tempDir.path(), "src", "main.rs");
			await Bun.write(path.join(tempDir.path(), "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.0.0"\n');
			await Bun.write(sourcePath, "fn greet() {}\nfn main() { greet(); }\n");

			const events: string[] = [];
			let statusRequests = 0;
			installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { definitionProvider: true } } });
					srv.send({
						jsonrpc: "2.0",
						method: "$/progress",
						params: { token: "workspace", value: { kind: "begin" } },
					});
					srv.send({
						jsonrpc: "2.0",
						method: "$/progress",
						params: { token: "workspace", value: { kind: "end" } },
					});
				} else if (message.method === "rust-analyzer/analyzerStatus") {
					statusRequests++;
					events.push("status");
					// The first status request is intentionally dropped so the client
					// must treat the request timeout as a retry signal
					// (deadline-as-signal), then keep polling through "No workspaces"
					// until the workspace reports ready.
					if (statusRequests === 1) return;
					const ready = statusRequests >= 3;
					srv.send({
						jsonrpc: "2.0",
						id: message.id,
						result: ready ? "Workspaces:\nLoaded 1 package across 1 workspace." : "No workspaces",
					});
				} else if (message.method === "textDocument/didOpen") {
					events.push("open");
				} else if (message.method === "textDocument/definition") {
					srv.send({
						jsonrpc: "2.0",
						id: message.id,
						result: [
							{
								uri: fileToUri(sourcePath),
								range: { start: { line: 0, character: 3 }, end: { line: 0, character: 8 } },
							},
						],
					});
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});

			const server: ServerConfig = {
				command: "rust-analyzer",
				resolvedCommand: process.execPath,
				fileTypes: ["rs"],
				rootMarkers: [],
				// Drive the timeout -> retry -> ready loop without real-clock latency.
				// The first status request still times out (proving deadline-as-signal),
				// just on a tiny budget instead of the 2s production settle window.
				workspaceReadyTimings: { timeoutMs: 5_000, pollMs: 1, settleMs: 2, statusRequestTimeoutMs: 20 },
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "rust-analyzer": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["rust-analyzer", server]]);

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			const result = await tool.execute("rust-wait-test", {
				action: "definition",
				file: sourcePath,
				line: 2,
				symbol: "greet",
				timeout: 10,
			});
			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");

			expect(output).toContain("Found 1 definition(s)");
			expect(events[0]).toBe("open");
			expect(events.filter(line => line === "status").length).toBeGreaterThanOrEqual(3);
		} finally {
			vi.restoreAllMocks();
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("skips rust-analyzer workspace polling for standalone Rust files", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rust-standalone-");
		try {
			const sourcePath = path.join(tempDir.path(), "foo.rs");
			await Bun.write(sourcePath, 'fn greet() -> &\'static str { "hi" }\n');

			const events: string[] = [];
			installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { definitionProvider: true } } });
				} else if (message.method === "rust-analyzer/analyzerStatus") {
					events.push("status");
					srv.send({ jsonrpc: "2.0", id: message.id, result: "No workspaces" });
				} else if (message.method === "textDocument/didOpen") {
					events.push("open");
				} else if (message.method === "textDocument/definition") {
					srv.send({
						jsonrpc: "2.0",
						id: message.id,
						result: [
							{
								uri: fileToUri(sourcePath),
								range: { start: { line: 0, character: 3 }, end: { line: 0, character: 8 } },
							},
						],
					});
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});

			const server: ServerConfig = {
				command: "rust-analyzer",
				resolvedCommand: process.execPath,
				fileTypes: ["rs"],
				rootMarkers: [],
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "rust-analyzer": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["rust-analyzer", server]]);

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			const result = await tool.execute("rust-standalone-test", {
				action: "definition",
				file: sourcePath,
				line: 1,
				symbol: "greet",
				timeout: 10,
			});
			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");

			// Standalone .rs (no Cargo workspace ancestor): the file is opened but the
			// analyzerStatus readiness poll is skipped entirely. The direct
			// `not.toContain("status")` assertion is the skip contract; the original
			// `elapsed < 2000ms` wall-clock proxy is dropped -- it is vacuous once the
			// transport is in-memory.
			expect(output).toContain("Found 1 definition(s)");
			expect(events).toContain("open");
			expect(events).not.toContain("status");
		} finally {
			vi.restoreAllMocks();
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("limits glob collection to avoid large diagnostic stalls", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-glob-");
		try {
			await Promise.all([
				Bun.write(path.join(tempDir.path(), "a.ts"), "export const a = 1;\n"),
				Bun.write(path.join(tempDir.path(), "b.ts"), "export const b = 1;\n"),
				Bun.write(path.join(tempDir.path(), "c.ts"), "export const c = 1;\n"),
			]);
			const result = await collectGlobMatches("*.ts", tempDir.path(), 2);
			expect(result.matches).toHaveLength(2);
			expect(result.truncated).toBe(true);
		} finally {
			tempDir.removeSync();
		}
	});

	it("treats existing bracket paths as literal diagnostic targets", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-bracket-path-");
		try {
			const diagnosticTarget = path.join(
				"apps",
				"frontend",
				"src",
				"app",
				"runs",
				"[runId]",
				"public",
				"opengraph-image.tsx",
			);
			const filePath = path.join(tempDir.path(), diagnosticTarget);
			await Bun.write(filePath, "export default function OpenGraphImage() {}\n");

			const result = await resolveDiagnosticTargets(diagnosticTarget, tempDir.path(), 10);

			expect(result).toEqual({
				matches: [diagnosticTarget],
				truncated: false,
			});
		} finally {
			tempDir.removeSync();
		}
	});

	it("resolves the requested symbol occurrence on a line", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-regression-");
		try {
			const filePath = path.join(tempDir.path(), "symbol.ts");
			await Bun.write(filePath, "foo(bar(foo));\n");

			expect(await resolveSymbolColumn(filePath, 1, "foo")).toBe(0);
			expect(await resolveSymbolColumn(filePath, 1, "foo#2")).toBe(8);
		} finally {
			tempDir.removeSync();
		}
	});

	it("throws when symbol does not exist on the target line", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-missing-symbol-");
		try {
			const filePath = path.join(tempDir.path(), "symbol.ts");
			await Bun.write(filePath, "winston.info('x');\n");

			expect(resolveSymbolColumn(filePath, 1, "nonexistent_symbol")).rejects.toThrow(
				'Symbol "nonexistent_symbol" not found on line 1',
			);
		} finally {
			tempDir.removeSync();
		}
	});

	it("throws when occurrence is out of bounds", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-occurrence-");
		try {
			const filePath = path.join(tempDir.path(), "symbol.ts");
			await Bun.write(filePath, "foo();\n");

			expect(resolveSymbolColumn(filePath, 1, "foo#2")).rejects.toThrow(
				'Symbol "foo" occurrence 2 is out of bounds on line 1 (found 1)',
			);
		} finally {
			tempDir.removeSync();
		}
	});

	it("filters and deduplicates workspace symbols by query", () => {
		const rustUri = fileToUri(path.join(os.tmpdir(), "rust.rs"));
		const loggerUri = fileToUri(path.join(os.tmpdir(), "logger.ts"));

		const symbols: SymbolInformation[] = [
			{
				name: "DisallowOverwritingRegularFilesViaOutputRedirection",
				kind: 12,
				location: {
					uri: rustUri,
					range: {
						start: { line: 10, character: 2 },
						end: { line: 10, character: 60 },
					},
				},
			},
			{
				name: "logger",
				kind: 13,
				location: {
					uri: loggerUri,
					range: {
						start: { line: 5, character: 1 },
						end: { line: 5, character: 7 },
					},
				},
			},
			{
				name: "logger",
				kind: 13,
				location: {
					uri: loggerUri,
					range: {
						start: { line: 5, character: 1 },
						end: { line: 5, character: 7 },
					},
				},
			},
		];

		const filtered = filterWorkspaceSymbols(symbols, "logger");
		const unique = dedupeWorkspaceSymbols(filtered);

		expect(filtered).toHaveLength(2);
		expect(unique).toHaveLength(1);
		expect(unique[0]?.name).toBe("logger");
	});

	it("applies command-only code actions by executing workspace commands", async () => {
		const executedCommands: string[] = [];
		const result = await applyCodeAction(
			{ title: "Organize Imports", command: "source.organizeImports" },
			{
				applyWorkspaceEdit: async () => [],
				executeCommand: async command => {
					executedCommands.push(command.command);
				},
			},
		);

		expect(executedCommands).toEqual(["source.organizeImports"]);
		expect(result).toEqual({
			title: "Organize Imports",
			edits: [],
			executedCommands: ["source.organizeImports"],
		});
	});

	it("resolves code actions before applying edits", async () => {
		const unresolvedAction: CodeAction = { title: "Add import" };
		const appliedEdits: string[] = [];
		const result = await applyCodeAction(unresolvedAction, {
			resolveCodeAction: async action => ({
				...action,
				edit: {
					changes: {
						[fileToUri(path.join(os.tmpdir(), "example.ts"))]: [
							{
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 0 },
								},
								newText: "import x from 'y';\n",
							},
						],
					},
				},
			}),
			applyWorkspaceEdit: async () => {
				appliedEdits.push("example.ts: 1 edit");
				return ["example.ts: 1 edit"];
			},
			executeCommand: async () => {},
		});

		expect(appliedEdits).toEqual(["example.ts: 1 edit"]);
		expect(result).toEqual({
			title: "Add import",
			edits: ["example.ts: 1 edit"],
			executedCommands: [],
		});
	});

	it("sanitizes symbol metadata in renderer output", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const renderOptions: RenderResultOptions = { expanded: false, isPartial: false };

		const call = renderCall(
			{ action: "definition", file: "src/example.ts", line: 10, symbol: "foo\tbar\nbaz" },
			renderOptions,
			uiTheme,
		);
		const callText = sanitizeText(call.render(120).join("\n"));
		const normalizedCallText = callText.replace(/\s+/g, " ");
		expect(normalizedCallText).toContain("foo bar baz");
		expect(callText).not.toContain("\t");
		const result = renderResult(
			{
				content: [{ type: "text", text: "No definition found" }],
				details: {
					action: "definition",
					success: true,
					request: {
						action: "definition",
						file: "src/example.ts",
						line: 10,
						symbol: "foo\tbar\nbaz",
					},
				},
			},
			renderOptions,
			uiTheme,
		);
		const resultText = sanitizeText(result.render(120).join("\n"));
		const normalizedResultText = resultText.replace(/\s+/g, " ");
		expect(normalizedResultText).toContain("symbol: foo bar baz");
		expect(resultText).not.toContain("\t");
	});

	it("sanitizes tabs in rendered diagnostic output", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const renderOptions: RenderResultOptions = { expanded: false, isPartial: false };

		const result = renderResult(
			{
				content: [
					{
						type: "text",
						text: "Diagnostics: 1 error(s)\nsrc/example.go:183:41 [error] [compiler] too many\targuments in call (WrongArgCount)",
					},
				],
			},
			renderOptions,
			uiTheme,
		);

		const resultText = sanitizeText(result.render(120).join("\n"));
		expect(resultText).not.toContain("\t");
		expect(resultText.replace(/\s+/g, " ")).toContain("too many arguments in call");
	});

	it("does not reuse stale file diagnostics after another URI publishes", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-stale-diags-");
		try {
			const targetFile = path.join(tempDir.path(), "target.ts");
			const otherFile = path.join(tempDir.path(), "other.ts");
			await Bun.write(targetFile, "export const target = 1;\n");
			await Bun.write(otherFile, "export const other = 1;\n");

			const targetUri = fileToUri(targetFile);
			const otherUri = fileToUri(otherFile);
			const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const staleDiagnostic: Diagnostic = {
				message: "stale target error",
				severity: 1,
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			};
			const otherDiagnostic: Diagnostic = {
				message: "other file warning",
				severity: 2,
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			};
			const client: LspClient = {
				name: "test-lsp",
				cwd: tempDir.path(),
				config: server,
				proc: {
					stdin: {
						write() {},
						flush: async () => {},
					},
				} as unknown as LspClient["proc"],
				requestId: 0,
				diagnostics: new Map([[targetUri, { diagnostics: [staleDiagnostic], version: null }]]),
				diagnosticsVersion: 1,
				openFiles: new Map([[targetUri, { version: 1, languageId: "typescript" }]]),
				pendingRequests: new Map(),
				messageBuffer: new Uint8Array(),
				isReading: false,
				status: "ready",
				lastActivity: Date.now(),
				writeQueue: Promise.resolve(),
				activeProgressTokens: new Set(),
				projectLoaded: Promise.resolve(),
				resolveProjectLoaded: () => {},
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
			vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", server]]);
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);

			setTimeout(() => {
				client.diagnostics.set(otherUri, { diagnostics: [otherDiagnostic], version: 1 });
				client.diagnosticsVersion += 1;
			}, 20);
			setTimeout(() => {
				client.diagnostics.set(targetUri, {
					diagnostics: [],
					version: client.openFiles.get(targetUri)?.version ?? 2,
				});
				client.diagnosticsVersion += 1;
			}, 80);

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			const result = await tool.execute("diag-stale", {
				action: "diagnostics",
				file: targetFile,
				timeout: 5,
			});
			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");

			expect(output).toBe("OK");
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("detects Windows local .exe LSP shims in node_modules/.bin", async () => {
		if (process.platform !== "win32") {
			return;
		}

		const tempDir = TempDir.createSync("@omp-lsp-win32-bin-");
		const whichSpy = vi.spyOn(Bun, "which").mockReturnValue(null);

		try {
			await Bun.write(path.join(tempDir.path(), "package.json"), "{}");
			const binDir = path.join(tempDir.path(), "node_modules", ".bin");
			await fs.promises.mkdir(binDir, { recursive: true });
			const localTsServer = path.join(binDir, "typescript-language-server.exe");
			await Bun.write(localTsServer, "");

			const config = loadConfig(tempDir.path());
			expect(config.servers["typescript-language-server"]?.resolvedCommand).toBe(localTsServer);
			expect(whichSpy).not.toHaveBeenCalledWith("typescript-language-server");
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("detects tlaplus files for LSP startup and language ids", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-tlaplus-");
		const specPath = path.join(tempDir.path(), "Spec.tla");
		const aliasPath = path.join(tempDir.path(), "Spec.tlaplus");

		await Bun.write(specPath, "---- MODULE Spec ----\n====\n");

		const resolvedTlapmLsp = path.join(tempDir.path(), "bin", "tlapm_lsp");
		const whichSpy = vi
			.spyOn(piUtils, "$which")
			.mockImplementation(command => (command === "tlapm_lsp" ? resolvedTlapmLsp : null));
		const existsSpy = vi
			.spyOn(fs, "existsSync")
			.mockImplementation(candidate => typeof candidate === "string" && candidate === specPath);

		try {
			const config = loadConfig(tempDir.path());
			expect(getServersForFile(config, specPath).map(([name]) => name)).toEqual(["tlaplus"]);
			expect(whichSpy).toHaveBeenCalledWith("tlapm_lsp");
			expect(existsSpy).toHaveBeenCalled();
			expect(detectLanguageId(specPath)).toBe("tlaplus");
			expect(detectLanguageId(aliasPath)).toBe("tlaplus");
		} finally {
			tempDir.removeSync();
		}
	});

	it("detects extensionless .emacs files for UI and LSP language ids", () => {
		const emacsPath = path.join(os.tmpdir(), "example", ".emacs");
		expect(getLanguageFromPath(emacsPath)).toBe("emacs-lisp");
		expect(detectLanguageId(emacsPath)).toBe("emacs-lisp");
	});

	it("loads config-only marketplace LSP servers from Claude plugin cache", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-marketplace-config-");
		const home = path.join(tempDir.path(), "home");
		const cwd = path.join(tempDir.path(), "repo");
		const pluginRoot = path.join(
			home,
			".claude",
			"plugins",
			"cache",
			"claude-plugins-official",
			"csharp-lsp",
			"1.0.0",
		);
		const marketplaceRoot = path.dirname(path.dirname(pluginRoot));
		const registryPath = path.join(home, ".claude", "plugins", "installed_plugins.json");

		await fs.promises.mkdir(pluginRoot, { recursive: true });
		await fs.promises.mkdir(cwd, { recursive: true });
		await fs.promises.mkdir(path.dirname(registryPath), { recursive: true });
		await Bun.write(path.join(cwd, "Example.csproj"), "<Project />\n");
		await Bun.write(
			registryPath,
			`${JSON.stringify(
				{
					version: 2,
					plugins: {
						"csharp-lsp@claude-plugins-official": [
							{
								scope: "user",
								installPath: pluginRoot,
								version: "1.0.0",
								installedAt: "2026-05-25T00:00:00.000Z",
								lastUpdated: "2026-05-25T00:00:00.000Z",
							},
						],
					},
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(
			path.join(marketplaceRoot, "marketplace.json"),
			`${JSON.stringify(
				{
					name: "claude-plugins-official",
					owner: { name: "anthropic" },
					plugins: [
						{
							name: "csharp-lsp",
							version: "1.0.0",
							source: "./csharp-lsp/1.0.0",
							lspServers: {
								"csharp-ls": {
									command: "csharp-ls",
									extensionToLanguage: { ".cs": "csharp" },
								},
							},
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		const resolvedCsharpLs = path.join(tempDir.path(), "bin", "csharp-ls");
		const whichSpy = vi
			.spyOn(piUtils, "$which")
			.mockImplementation(command => (command === "csharp-ls" ? resolvedCsharpLs : null));

		try {
			await preloadPluginRoots(home, cwd);

			const config = loadConfig(cwd);

			expect(config.servers["csharp-ls"]?.resolvedCommand).toBe(resolvedCsharpLs);
			expect(getServersForFile(config, path.join(cwd, "Program.cs")).map(([name]) => name)).toEqual(["csharp-ls"]);
			expect(config.servers["csharp-ls"]?.rootMarkers).toEqual(["."]);
			expect(whichSpy).toHaveBeenCalledWith("csharp-ls");
		} finally {
			await preloadPluginRoots(path.join(tempDir.path(), "empty-home"), cwd);
			tempDir.removeSync();
		}
	});
	it("rename_file applies LSP willRenameFiles edits and renames the file", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rename-file-");
		try {
			const sourceFile = path.join(tempDir.path(), "src", "old.ts");
			const destFile = path.join(tempDir.path(), "src", "new.ts");
			const referencingFile = path.join(tempDir.path(), "src", "consumer.ts");
			await Bun.write(sourceFile, "export const value = 42;\n");
			await Bun.write(referencingFile, "import { value } from './old';\nconsole.log(value);\n");

			const sourceUri = fileToUri(sourceFile);
			const destUri = fileToUri(destFile);
			const referencingUri = fileToUri(referencingFile);

			const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const client: LspClient = {
				name: "test-lsp",
				cwd: tempDir.path(),
				config: server,
				proc: {
					stdin: { write() {}, flush: async () => {} },
				} as unknown as LspClient["proc"],
				requestId: 0,
				diagnostics: new Map(),
				diagnosticsVersion: 0,
				openFiles: new Map(),
				pendingRequests: new Map(),
				messageBuffer: new Uint8Array(),
				isReading: false,
				status: "ready",
				lastActivity: Date.now(),
				writeQueue: Promise.resolve(),
				activeProgressTokens: new Set(),
				projectLoaded: Promise.resolve(),
				resolveProjectLoaded: () => {},
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-lsp": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);

			const willRenameRequests: Array<{ method: string; params: unknown }> = [];
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_client, method, params) => {
				willRenameRequests.push({ method, params });
				if (method === "workspace/willRenameFiles") {
					return {
						changes: {
							[referencingUri]: [
								{
									range: {
										start: { line: 0, character: 22 },
										end: { line: 0, character: 29 },
									},
									newText: "'./new'",
								},
							],
						},
					};
				}
				return null;
			});

			const notifications: Array<{ method: string; params: unknown }> = [];
			vi.spyOn(lspClient, "sendNotification").mockImplementation(async (_client, method, params) => {
				notifications.push({ method, params });
			});

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			const result = await tool.execute("rename-file-test", {
				action: "rename_file",
				file: sourceFile,
				new_name: destFile,
				timeout: 5,
			});

			expect(willRenameRequests).toHaveLength(1);
			expect(willRenameRequests[0]?.method).toBe("workspace/willRenameFiles");
			expect(willRenameRequests[0]?.params).toEqual({
				files: [{ oldUri: sourceUri, newUri: destUri }],
			});

			// Filesystem actually moved
			expect(fs.existsSync(sourceFile)).toBe(false);
			expect(fs.existsSync(destFile)).toBe(true);

			// Importer file got the LSP-provided edit
			const updatedConsumer = await Bun.file(referencingFile).text();
			expect(updatedConsumer).toBe("import { value } from './new';\nconsole.log(value);\n");

			// didRenameFiles notification fired with the same pair list
			const didRename = notifications.find(n => n.method === "workspace/didRenameFiles");
			expect(didRename).toBeDefined();
			expect(didRename?.params).toEqual({
				files: [{ oldUri: sourceUri, newUri: destUri }],
			});

			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(output).toContain("Renamed");
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("rename_file with apply:false previews edits without filesystem changes", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rename-file-preview-");
		try {
			const sourceFile = path.join(tempDir.path(), "old.ts");
			const destFile = path.join(tempDir.path(), "new.ts");
			await Bun.write(sourceFile, "export const value = 42;\n");

			const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const client: LspClient = {
				name: "test-lsp",
				cwd: tempDir.path(),
				config: server,
				proc: {
					stdin: { write() {}, flush: async () => {} },
				} as unknown as LspClient["proc"],
				requestId: 0,
				diagnostics: new Map(),
				diagnosticsVersion: 0,
				openFiles: new Map(),
				pendingRequests: new Map(),
				messageBuffer: new Uint8Array(),
				isReading: false,
				status: "ready",
				lastActivity: Date.now(),
				writeQueue: Promise.resolve(),
				activeProgressTokens: new Set(),
				projectLoaded: Promise.resolve(),
				resolveProjectLoaded: () => {},
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-lsp": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
			vi.spyOn(lspClient, "sendRequest").mockResolvedValue({
				documentChanges: [],
			});
			const notifySpy = vi.spyOn(lspClient, "sendNotification").mockResolvedValue();

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			await tool.execute("rename-file-preview", {
				action: "rename_file",
				file: sourceFile,
				new_name: destFile,
				apply: false,
				timeout: 5,
			});

			expect(fs.existsSync(sourceFile)).toBe(true);
			expect(fs.existsSync(destFile)).toBe(false);
			expect(notifySpy).not.toHaveBeenCalledWith(expect.anything(), "workspace/didRenameFiles", expect.anything());
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("rename_file enumerates every file inside a directory rename", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rename-dir-");
		try {
			const srcDir = path.join(tempDir.path(), "old");
			const dstDir = path.join(tempDir.path(), "new");
			const fileA = path.join(srcDir, "a.ts");
			const fileB = path.join(srcDir, "nested", "b.ts");
			await Bun.write(fileA, "export const a = 1;\n");
			await Bun.write(fileB, "export const b = 2;\n");

			const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const client: LspClient = {
				name: "test-lsp",
				cwd: tempDir.path(),
				config: server,
				proc: {
					stdin: { write() {}, flush: async () => {} },
				} as unknown as LspClient["proc"],
				requestId: 0,
				diagnostics: new Map(),
				diagnosticsVersion: 0,
				openFiles: new Map(),
				pendingRequests: new Map(),
				messageBuffer: new Uint8Array(),
				isReading: false,
				status: "ready",
				lastActivity: Date.now(),
				writeQueue: Promise.resolve(),
				activeProgressTokens: new Set(),
				projectLoaded: Promise.resolve(),
				resolveProjectLoaded: () => {},
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-lsp": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);

			const requests: Array<{ method: string; params: unknown }> = [];
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_c, method, params) => {
				requests.push({ method, params });
				return null;
			});
			vi.spyOn(lspClient, "sendNotification").mockResolvedValue();

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			await tool.execute("rename-dir-test", {
				action: "rename_file",
				file: srcDir,
				new_name: dstDir,
				timeout: 5,
			});

			expect(requests).toHaveLength(1);
			const params = requests[0]?.params as { files: Array<{ oldUri: string; newUri: string }> };
			expect(params.files).toHaveLength(2);
			const oldUris = params.files.map(f => f.oldUri).sort();
			const newUris = params.files.map(f => f.newUri).sort();
			expect(oldUris).toEqual([fileToUri(fileA), fileToUri(fileB)].sort());
			expect(newUris).toEqual(
				[fileToUri(path.join(dstDir, "a.ts")), fileToUri(path.join(dstDir, "nested", "b.ts"))].sort(),
			);

			// Directory was actually moved
			expect(fs.existsSync(srcDir)).toBe(false);
			expect(fs.existsSync(path.join(dstDir, "a.ts"))).toBe(true);
			expect(fs.existsSync(path.join(dstDir, "nested", "b.ts"))).toBe(true);
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("request action sends raw LSP method with auto-built textDocument/position params", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-request-");
		try {
			const filePath = path.join(tempDir.path(), "src", "lib.rs");
			await Bun.write(filePath, 'fn main() {\n    println!("hi");\n}\n');

			const server: ServerConfig = { command: "test-rs", fileTypes: ["rs"], rootMarkers: [] };
			const client: LspClient = {
				name: "test-rs",
				cwd: tempDir.path(),
				config: server,
				proc: {
					stdin: { write() {}, flush: async () => {} },
				} as unknown as LspClient["proc"],
				requestId: 0,
				diagnostics: new Map(),
				diagnosticsVersion: 0,
				openFiles: new Map(),
				pendingRequests: new Map(),
				messageBuffer: new Uint8Array(),
				isReading: false,
				status: "ready",
				lastActivity: Date.now(),
				writeQueue: Promise.resolve(),
				activeProgressTokens: new Set(),
				projectLoaded: Promise.resolve(),
				resolveProjectLoaded: () => {},
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-rs": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-rs", server]]);
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
			vi.spyOn(lspClient, "ensureFileOpen").mockResolvedValue();
			vi.spyOn(lspClient, "sendNotification").mockResolvedValue();

			const captured: Array<{ method: string; params: unknown }> = [];
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_c, method, requestParams) => {
				captured.push({ method, params: requestParams });
				return { expansion: "macro_rules!" };
			});

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			const result = await tool.execute("request-test", {
				action: "request",
				file: filePath,
				line: 2,
				query: "rust-analyzer/expandMacro",
				timeout: 5,
			});

			expect(captured).toHaveLength(1);
			expect(captured[0]?.method).toBe("rust-analyzer/expandMacro");
			expect(captured[0]?.params).toEqual({
				textDocument: { uri: fileToUri(filePath) },
				position: { line: 1, character: 4 },
			});

			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(output).toContain("rust-analyzer/expandMacro");
			expect(output).toContain('"expansion"');
			expect(output).toContain("macro_rules!");
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("request action forwards explicit JSON payload verbatim", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-request-payload-");
		try {
			const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const client: LspClient = {
				name: "test-lsp",
				cwd: tempDir.path(),
				config: server,
				proc: {
					stdin: { write() {}, flush: async () => {} },
				} as unknown as LspClient["proc"],
				requestId: 0,
				diagnostics: new Map(),
				diagnosticsVersion: 0,
				openFiles: new Map(),
				pendingRequests: new Map(),
				messageBuffer: new Uint8Array(),
				isReading: false,
				status: "ready",
				lastActivity: Date.now(),
				writeQueue: Promise.resolve(),
				activeProgressTokens: new Set(),
				projectLoaded: Promise.resolve(),
				resolveProjectLoaded: () => {},
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-lsp": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);

			const captured: Array<{ method: string; params: unknown }> = [];
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_c, method, requestParams) => {
				captured.push({ method, params: requestParams });
				return null;
			});

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			await tool.execute("request-payload", {
				action: "request",
				query: "workspace/executeCommand",
				payload: JSON.stringify({ command: "_typescript.organizeImports", arguments: ["a.ts"] }),
				timeout: 5,
			});

			expect(captured).toHaveLength(1);
			expect(captured[0]?.method).toBe("workspace/executeCommand");
			expect(captured[0]?.params).toEqual({
				command: "_typescript.organizeImports",
				arguments: ["a.ts"],
			});
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("capabilities action dumps server capabilities", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-caps-");
		try {
			const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const client: LspClient = {
				name: "test-lsp",
				cwd: tempDir.path(),
				config: server,
				proc: {
					stdin: { write() {}, flush: async () => {} },
				} as unknown as LspClient["proc"],
				requestId: 0,
				diagnostics: new Map(),
				diagnosticsVersion: 0,
				openFiles: new Map(),
				pendingRequests: new Map(),
				messageBuffer: new Uint8Array(),
				isReading: false,
				status: "ready",
				lastActivity: Date.now(),
				writeQueue: Promise.resolve(),
				activeProgressTokens: new Set(),
				projectLoaded: Promise.resolve(),
				resolveProjectLoaded: () => {},
				serverCapabilities: {
					hoverProvider: true,
					definitionProvider: true,
					executeCommandProvider: { commands: ["_typescript.organizeImports"] },
					experimental: { "rust-analyzer/expandMacro": true },
				},
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-lsp": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			const result = await tool.execute("caps-test", {
				action: "capabilities",
				timeout: 5,
			});

			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(output).toContain("test-lsp:");
			expect(output).toContain("hoverProvider");
			expect(output).toContain("_typescript.organizeImports");
			expect(output).toContain("rust-analyzer/expandMacro");
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("flushes pending descendant text edits before a folder rename", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-folder-rename-");
		try {
			const srcDir = path.join(tempDir.path(), "src");
			fs.mkdirSync(srcDir, { recursive: true });
			const childPath = path.join(srcDir, "a.ts");
			await Bun.write(childPath, "export const a = 1;\n");

			const childUri = fileToUri(childPath);
			const oldFolderUri = fileToUri(srcDir);
			const newFolderUri = fileToUri(path.join(tempDir.path(), "src2"));

			const childEdit: TextDocumentEdit = {
				textDocument: { uri: childUri, version: null },
				edits: [
					{
						range: {
							start: { line: 0, character: 13 },
							end: { line: 0, character: 14 },
						},
						newText: "renamed",
					},
				],
			};
			const folderRename: RenameFile = {
				kind: "rename",
				oldUri: oldFolderUri,
				newUri: newFolderUri,
			};
			const workspaceEdit: WorkspaceEdit = {
				documentChanges: [childEdit, folderRename],
			};

			const applied = await applyWorkspaceEdit(workspaceEdit, tempDir.path());

			// Old folder is gone, new folder holds the edited child.
			expect(fs.existsSync(srcDir)).toBe(false);
			const renamedChildPath = path.join(tempDir.path(), "src2", "a.ts");
			expect(fs.existsSync(renamedChildPath)).toBe(true);
			expect(fs.readFileSync(renamedChildPath, "utf8")).toBe("export const renamed = 1;\n");

			// Both ops are reported in original order: edit first, then rename.
			expect(applied).toHaveLength(2);
			expect(applied[0]).toContain("Applied 1 edit(s)");
			expect(applied[0]).toContain("src/a.ts");
			expect(applied[1]).toContain("Renamed");
			expect(applied[1]).toContain("src");
			expect(applied[1]).toContain("src2");
		} finally {
			tempDir.removeSync();
		}
	});

	it("flushes pending edits queued against a rename target before performing the rename", async () => {
		// LSP §3.16.2: documentChanges run in declared order. When a TextDocumentEdit
		// targets `renameOp.newUri` *before* the rename, those edits must land on the
		// existing file at that location BEFORE the rename overwrites/replaces it.
		// Otherwise the rename clobbers the post-edit content (or worse, the edits
		// land on the moved-in file with stale offsets).
		const tempDir = TempDir.createSync("@omp-lsp-rename-target-prefill-");
		try {
			const oldPath = path.join(tempDir.path(), "old.ts");
			const newPath = path.join(tempDir.path(), "new.ts");
			await Bun.write(oldPath, "export const moved = 1;\n");
			// A pre-existing target file the rename is about to clobber.
			await Bun.write(newPath, "export const target = 2;\n");

			const oldUri = fileToUri(oldPath);
			const newUri = fileToUri(newPath);

			// Edit the target file first, then rename onto it. Pre-edit content
			// MUST be observable somewhere in the applied log — proving the flush
			// ran before the rename clobbered the file.
			const targetEdit: TextDocumentEdit = {
				textDocument: { uri: newUri, version: null },
				edits: [
					{
						range: {
							start: { line: 0, character: 13 },
							end: { line: 0, character: 19 },
						},
						newText: "before",
					},
				],
			};
			const renameOp: RenameFile = {
				kind: "rename",
				oldUri,
				newUri,
			};
			const workspaceEdit: WorkspaceEdit = {
				documentChanges: [targetEdit, renameOp],
			};

			const applied = await applyWorkspaceEdit(workspaceEdit, tempDir.path());

			// Three steps observable in order: edit on newUri, then rename clobbers it.
			expect(applied).toHaveLength(2);
			expect(applied[0]).toContain("Applied 1 edit(s)");
			expect(applied[0]).toContain("new.ts");
			expect(applied[1]).toContain("Renamed");

			// Final state: new.ts holds the moved-in content (rename ran last and won).
			expect(fs.existsSync(oldPath)).toBe(false);
			expect(fs.readFileSync(newPath, "utf8")).toBe("export const moved = 1;\n");
		} finally {
			tempDir.removeSync();
		}
	});

	it("applies equal-position inserts in array order", () => {
		// LSP spec: multiple inserts at the same position land in the order they
		// appear in the edits array (import + reference insertions rely on this).
		const result = applyTextEditsToString("abc", [
			{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: "X" },
			{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: "Y" },
		]);
		expect(result).toBe("aXYbc");
	});

	it("validates every file's edits before writing any workspace-edit file", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-atomic-validate-");
		try {
			const okPath = path.join(tempDir.path(), "ok.ts");
			const badPath = path.join(tempDir.path(), "bad.ts");
			const okContent = "export const ok = 1;\n";
			await Bun.write(okPath, okContent);
			await Bun.write(badPath, "export const bad = 2;\n");

			const workspaceEdit: WorkspaceEdit = {
				changes: {
					[fileToUri(okPath)]: [
						{
							range: { start: { line: 0, character: 13 }, end: { line: 0, character: 15 } },
							newText: "changed",
						},
					],
					[fileToUri(badPath)]: [
						// Overlapping edits — must reject the whole workspace edit.
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
							newText: "x",
						},
						{
							range: { start: { line: 0, character: 5 }, end: { line: 0, character: 12 } },
							newText: "y",
						},
					],
				},
			};

			expect(applyWorkspaceEdit(workspaceEdit, tempDir.path())).rejects.toThrow(/overlapping LSP edits/);
			// The valid file must be untouched: validation runs before any write.
			expect(fs.readFileSync(okPath, "utf8")).toBe(okContent);
		} finally {
			tempDir.removeSync();
		}
	});

	it("round-trips file URIs containing percent and hash characters", () => {
		const tricky = path.resolve(os.tmpdir(), "omp uri", "100% #1.ts");
		const uri = fileToUri(tricky);
		// Percent-encoded so the server cannot misparse a fragment or escape.
		expect(uri).not.toContain("#");
		expect(uri).not.toContain(" ");
		expect(uriToFile(uri)).toBe(tricky);
		// Lax servers sending unencoded paths are tolerated.
		const plain = path.resolve(os.tmpdir(), "omp uri", "plain.ts");
		expect(uriToFile(fileToUri(plain).replaceAll("%20", " "))).toBe(plain);
	});

	it("resolves $-prefixed identifiers past compound matches", async () => {
		// Pre-fix, BARE_IDENTIFIER_RE rejected leading `$`, so requireWordBoundary
		// was false and `resolveSymbolColumn(_, _, "$store")` returned the column
		// inside `bar$store` rather than the standalone occurrence, feeding the
		// LSP server the wrong column. The new regex `/^[$A-Za-z_][\w$]*$/` plus
		// IDENTIFIER_CHAR_RE's existing `$` membership enforces the boundary.
		const tempDir = TempDir.createSync("@omp-lsp-dollar-identifier-");
		try {
			const filePath = path.join(tempDir.path(), "store.ts");
			// Standalone `$store` starts at column 16; compound `bar$store`
			// contains the substring at column 7. Old code returned 7; new code
			// returns 16.
			await Bun.write(filePath, "let bar$store = $store + 1;\n");

			const column = await resolveSymbolColumn(filePath, 1, "$store");
			expect(column).toBe(16);

			// `bar$store` is itself a valid `$`-bearing identifier and resolves
			// to its own start, not into either fragment.
			const compoundColumn = await resolveSymbolColumn(filePath, 1, "bar$store");
			expect(compoundColumn).toBe(4);
		} finally {
			tempDir.removeSync();
		}
	});

	it("applies a create op followed by a text edit for the same URI in declared order", async () => {
		// LSP §3.16.2 motivating case for the rewrite: "Extract to new file"
		// code actions emit `[CreateFile(newUri), TextDocumentEdit(newUri, ...)]`.
		// Pre-fix, all text edits flushed first → applyTextEdits opened a
		// not-yet-created file → ENOENT. The new walk processes each entry in
		// order, so the create lands first and the edit reads the empty file
		// the create just wrote.
		const tempDir = TempDir.createSync("@omp-lsp-create-then-edit-");
		try {
			const newFilePath = path.join(tempDir.path(), "extracted.ts");
			expect(fs.existsSync(newFilePath)).toBe(false);

			const newUri = fileToUri(newFilePath);
			const createOp: CreateFile = {
				kind: "create",
				uri: newUri,
			};
			const textEdit: TextDocumentEdit = {
				textDocument: { uri: newUri, version: null },
				edits: [
					{
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 0 },
						},
						newText: "export const extracted = 42;\n",
					},
				],
			};
			const workspaceEdit: WorkspaceEdit = {
				documentChanges: [createOp, textEdit],
			};

			const applied = await applyWorkspaceEdit(workspaceEdit, tempDir.path());

			expect(fs.existsSync(newFilePath)).toBe(true);
			expect(fs.readFileSync(newFilePath, "utf8")).toBe("export const extracted = 42;\n");

			// Declared order observable in the applied log: create first, then edit.
			expect(applied).toHaveLength(2);
			expect(applied[0]).toContain("Created");
			expect(applied[0]).toContain("extracted.ts");
			expect(applied[1]).toContain("Applied 1 edit(s)");
			expect(applied[1]).toContain("extracted.ts");
		} finally {
			tempDir.removeSync();
		}
	});

	it("flushes pending descendant text edits before a folder delete", async () => {
		// Mirror of the folder-rename subtree-flush test for the `delete` arm:
		// edits queued against a child URI must land at the original path
		// BEFORE the parent folder is removed, otherwise the flush at end of
		// walk would target a non-existent path and throw.
		const tempDir = TempDir.createSync("@omp-lsp-folder-delete-");
		try {
			const srcDir = path.join(tempDir.path(), "src");
			fs.mkdirSync(srcDir, { recursive: true });
			const childPath = path.join(srcDir, "a.ts");
			await Bun.write(childPath, "export const a = 1;\n");

			const childUri = fileToUri(childPath);
			const folderUri = fileToUri(srcDir);

			const childEdit: TextDocumentEdit = {
				textDocument: { uri: childUri, version: null },
				edits: [
					{
						range: {
							start: { line: 0, character: 18 },
							end: { line: 0, character: 19 },
						},
						newText: "999",
					},
				],
			};
			const folderDelete: DeleteFile = {
				kind: "delete",
				uri: folderUri,
			};
			const workspaceEdit: WorkspaceEdit = {
				documentChanges: [childEdit, folderDelete],
			};

			const applied = await applyWorkspaceEdit(workspaceEdit, tempDir.path());

			// Folder is gone; "Applied" message proves the flush ran before delete.
			expect(fs.existsSync(srcDir)).toBe(false);
			expect(applied).toHaveLength(2);
			expect(applied[0]).toContain("Applied 1 edit(s)");
			expect(applied[0]).toContain("src/a.ts");
			expect(applied[1]).toContain("Deleted");
			expect(applied[1]).toContain("src");
		} finally {
			tempDir.removeSync();
		}
	});

	it("sendRequest respects an explicit timeoutMs and reports it in the error", async () => {
		// Synthesise a minimal in-memory LSP client and never resolve the request
		// so the per-request timer is the only thing that can fire.
		const client: LspClient = {
			name: "test-lsp",
			cwd: process.cwd(),
			config: { command: "test-lsp", fileTypes: [".ts"], rootMarkers: [] },
			proc: { stdin: { write() {}, flush: async () => {} } } as unknown as LspClient["proc"],
			requestId: 0,
			diagnostics: new Map(),
			diagnosticsVersion: 0,
			openFiles: new Map(),
			pendingRequests: new Map(),
			messageBuffer: new Uint8Array(),
			isReading: false,
			status: "ready",
			lastActivity: Date.now(),
			writeQueue: Promise.resolve(),
			activeProgressTokens: new Set(),
			projectLoaded: Promise.resolve(),
			resolveProjectLoaded: () => {},
		};
		expect(lspClient.sendRequest(client, "test/method", {}, undefined, 25)).rejects.toThrow(/after 25ms/);
	});

	it("sendRequest uses the signal as the deadline when no explicit timeout is set", async () => {
		// With a signal but no explicit timeoutMs, the per-request 30s default
		// MUST NOT fire — the signal owns the deadline. Otherwise `timeout: 60`
		// on the LSP tool got truncated to 30000ms.
		const client: LspClient = {
			name: "test-lsp",
			cwd: process.cwd(),
			config: { command: "test-lsp", fileTypes: [".ts"], rootMarkers: [] },
			proc: { stdin: { write() {}, flush: async () => {} } } as unknown as LspClient["proc"],
			requestId: 0,
			diagnostics: new Map(),
			diagnosticsVersion: 0,
			openFiles: new Map(),
			pendingRequests: new Map(),
			messageBuffer: new Uint8Array(),
			isReading: false,
			status: "ready",
			lastActivity: Date.now(),
			writeQueue: Promise.resolve(),
			activeProgressTokens: new Set(),
			projectLoaded: Promise.resolve(),
			resolveProjectLoaded: () => {},
		};
		const signal = AbortSignal.timeout(20);
		expect(lspClient.sendRequest(client, "test/method", {}, signal)).rejects.toThrow();
		// If the per-request 30s timer had fired, the message would say "after 30000ms".
		// We assert the negative: the rejection came from the signal, not the timer.
		try {
			await lspClient.sendRequest(client, "test/method", {}, AbortSignal.timeout(20));
		} catch (err) {
			expect(String(err)).not.toContain("30000ms");
		}
	});

	it("rename_file skips the LSP loop when no configured server handles the file extension", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rename-irrelevant-");
		try {
			const sourceFile = path.join(tempDir.path(), "notes.md");
			const destFile = path.join(tempDir.path(), "renamed.md");
			await Bun.write(sourceFile, "# heading\n");

			// Only a TS server is configured; .md should not trigger any willRenameFiles.
			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-ts": { command: "test-ts", fileTypes: [".ts"], rootMarkers: [] } },
				idleTimeoutMs: undefined,
			});
			const sendSpy = vi.spyOn(lspClient, "sendRequest");
			const notifySpy = vi.spyOn(lspClient, "sendNotification");
			const getClientSpy = vi.spyOn(lspClient, "getOrCreateClient");

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			const result = await tool.execute("rename-md", {
				action: "rename_file",
				file: sourceFile,
				new_name: destFile,
				timeout: 5,
			});

			expect(sendSpy).not.toHaveBeenCalled();
			expect(notifySpy).not.toHaveBeenCalled();
			expect(getClientSpy).not.toHaveBeenCalled();
			expect(fs.existsSync(sourceFile)).toBe(false);
			expect(fs.existsSync(destFile)).toBe(true);
			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(output).toContain("Renamed");
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("workspace reload rediscovers LSP servers after an empty config was cached", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-reload-redetect-");
		try {
			const server: ServerConfig = {
				command: "test-lsp",
				fileTypes: [".ts"],
				rootMarkers: ["package.json"],
			};
			const configs: LspConfig[] = [
				{ servers: {}, idleTimeoutMs: undefined },
				{ servers: { "test-lsp": server }, idleTimeoutMs: undefined },
				{ servers: { "test-lsp": server }, idleTimeoutMs: undefined },
			];
			const loadConfigSpy = vi
				.spyOn(lspConfig, "loadConfig")
				.mockImplementation(() => configs.shift() ?? configs[0]);
			const client = { proc: { kill: vi.fn() } } as unknown as LspClient;
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
			vi.spyOn(lspClient, "sendRequest").mockResolvedValue(null);

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			const initial = await tool.execute("reload-redetect-status", { action: "status" });
			const initialOutput = initial.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(initialOutput).toContain("No language servers configured for this project");

			const starResult = await tool.execute("reload-redetect-star", { action: "reload", file: "*" });
			const starOutput = starResult.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");

			const omittedResult = await tool.execute("reload-redetect-omitted", { action: "reload" });
			const omittedOutput = omittedResult.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");

			expect(loadConfigSpy).toHaveBeenCalledTimes(3);
			expect(starOutput).toContain("Reloaded test-lsp");
			expect(omittedOutput).toContain("Reloaded test-lsp");
			expect(lspClient.getOrCreateClient).toHaveBeenCalledWith(server, tempDir.path());
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("status distinguishes configured servers from started clients", async () => {
		// `loadConfig` claims rust-analyzer + tsls are configured, but only
		// tsls has actually been spawned. Status must reflect that — claiming
		// rust-analyzer is 'active' when the process never started was the
		// original bug.
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
			servers: {
				"rust-analyzer": { command: "rust-analyzer", fileTypes: [".rs"], rootMarkers: ["Cargo.toml"] },
				"typescript-language-server": {
					command: "typescript-language-server",
					fileTypes: [".ts"],
					rootMarkers: ["tsconfig.json"],
				},
			},
			idleTimeoutMs: undefined,
		});
		vi.spyOn(lspClient, "getActiveClients").mockReturnValue([
			{ name: "typescript-language-server", status: "ready", fileTypes: [".ts"] },
		]);

		const tool = new LspTool({ cwd: process.cwd() } as ToolSession);
		const result = await tool.execute("status-test", { action: "status" });
		const output = result.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");

		expect(output).toContain("rust-analyzer (configured, not started)");
		expect(output).toContain("typescript-language-server (ready)");
	});

	it("reload * invalidates the per-cwd config cache so newly written .omp/lsp.json is observed", async () => {
		// #3546: `getConfig` caches the first `loadConfig` result per cwd
		// permanently. Creating `.omp/lsp.json` after the first LSP call left
		// the tool stuck on "No language servers configured" until the process
		// restarted. `reload *` (the user's explicit refresh) must invalidate
		// that cache so subsequent calls observe the fresh config from disk.
		const tempDir = TempDir.createSync("@omp-lsp-config-cache-reload-");
		try {
			const cwd = tempDir.path();
			const empty: LspConfig = { servers: {}, idleTimeoutMs: undefined };
			const withServer: LspConfig = {
				servers: {
					"fake-pylsp": {
						command: "true",
						fileTypes: [".py"],
						rootMarkers: [".python-root"],
						resolvedCommand: "/bin/true",
					},
				},
				idleTimeoutMs: undefined,
			};
			const loadConfigSpy = vi
				.spyOn(lspConfig, "loadConfig")
				.mockImplementation(() => (loadConfigSpy.mock.calls.length === 1 ? empty : withServer));
			// Prevent any real LSP subprocess from spawning when reload iterates
			// the refreshed server list — the spawn path would race with the
			// test's teardown.
			vi.spyOn(lspClient, "getOrCreateClient").mockRejectedValue(new Error("spawn suppressed in test"));
			vi.spyOn(lspClient, "getActiveClients").mockReturnValue([]);

			const tool = new LspTool({ cwd } as ToolSession);

			const status1 = await tool.execute("cache-1", { action: "status" });
			const text1 = status1.content
				.filter(b => b.type === "text")
				.map(b => b.text)
				.join("\n");
			expect(text1).toContain("No language servers configured");
			expect(loadConfigSpy).toHaveBeenCalledTimes(1);

			// Second status hits the cache — proves caching is the baseline, so
			// the next assertion measures invalidation, not a missing cache.
			await tool.execute("cache-2", { action: "status" });
			expect(loadConfigSpy).toHaveBeenCalledTimes(1);

			// `reload *` MUST drop the cached empty config and re-read from disk.
			const reload = await tool.execute("cache-3", { action: "reload", file: "*" });
			expect(loadConfigSpy).toHaveBeenCalledTimes(2);
			const reloadText = reload.content
				.filter(b => b.type === "text")
				.map(b => b.text)
				.join("\n");
			// Spawn was suppressed, so the per-server output is the failure line —
			// the contract under test is that the fresh server was even considered.
			expect(reloadText).toContain("fake-pylsp");

			// The refreshed config now sits in the cache; status sees the new
			// server without another disk read.
			const status3 = await tool.execute("cache-4", { action: "status" });
			const text3 = status3.content
				.filter(b => b.type === "text")
				.map(b => b.text)
				.join("\n");
			expect(text3).toContain("fake-pylsp (configured, not started)");
			expect(loadConfigSpy).toHaveBeenCalledTimes(2);
		} finally {
			tempDir.removeSync();
		}
	});
});

describe("expert elixir lsp", () => {
	it("registers expert for .ex while keeping elixirls primary", () => {
		const config = { servers: DEFAULTS as unknown as Record<string, ServerConfig> };
		const names = getServersForFile(config, "lib/app.ex").map(([name]) => name);
		expect(names).toContain("expert");
		expect(names).toContain("elixirls");
		expect(names.indexOf("elixirls")).toBeLessThan(names.indexOf("expert"));
	});
});
