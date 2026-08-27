import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, RenderResultOptions } from "@oh-my-pi/pi-agent-core";
import { arkToWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { preloadPluginRoots } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import { getServersForFile, type LspConfig, loadConfig } from "@oh-my-pi/pi-coding-agent/lsp/config";
import {
	applyTextEditsToString,
	applyWorkspaceEdit,
	type ExecutedWorkspaceChange,
	sortAndValidateTextEdits,
} from "@oh-my-pi/pi-coding-agent/lsp/edits";
import { renderCall, renderResult } from "@oh-my-pi/pi-coding-agent/lsp/render";
import { configCache, getConfig } from "@oh-my-pi/pi-coding-agent/lsp/servers";
import {
	type CodeAction,
	type CreateFile,
	type DeleteFile,
	type Diagnostic,
	type LspClient,
	type LspToolDetails,
	lspSchema,
	type RenameFile,
	type ServerConfig,
	type SymbolInformation,
	type TextDocumentEdit,
	type WorkspaceEdit,
} from "@oh-my-pi/pi-coding-agent/lsp/types";
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
} from "@oh-my-pi/pi-coding-agent/lsp/utils";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { clampTimeout } from "@oh-my-pi/pi-coding-agent/tools/tool-timeouts";
import * as piUtils from "@oh-my-pi/pi-utils";
import { sanitizeText, TempDir } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import DEFAULTS from "../../src/lsp/defaults.json" with { type: "json" };
import { renderResult as renderLocalResult } from "../../src/lsp/render";
import { getLanguageFromPath } from "../../src/utils/lang-from-path";

const lspTestSettings = Settings.isolated();

/** Minimal LSP tool session: production always supplies `settings`; these tests only need cwd + a default settings stub. */
function makeLspSession(cwd: string): ToolSession {
	return { cwd, settings: lspTestSettings } as ToolSession;
}

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
	/** Fail stdout without exiting the process. */
	failStdout(error: Error): void;
	/** Whether the client invoked `proc.kill()` (production's hard-kill fallback). */
	readonly killed: boolean;
	/** Number of subprocesses spawned through this fake. */
	readonly spawnCount: number;
	/** Resolve once a received message matches `predicate` (already-seen or future). */
	waitFor(predicate: (message: RpcMessage) => boolean, timeoutMs?: number): Promise<RpcMessage>;
}

type FakeLspHandler = (message: RpcMessage, server: FakeLspServer) => void | Promise<void>;

interface FakeLspOptions {
	killResolvesExit?: boolean;
	stderr?: string;
	stdoutClosesBeforeExit?: boolean;
}

// In-memory LSP transport fake. Replaces the real subprocess (`ptree.spawn`)
// with an in-process JSON-RPC peer so the initialize / shutdown / exit and
// workspace-folder handshakes resolve deterministically -- no subprocess spawn,
// no real-clock latency. Installed by spying on the shared `ptree` namespace
// object (NOT `mock.module`, which would leak across files); the suite's
// `afterEach` `vi.restoreAllMocks()` removes it.
function installFakeLsp(handler: FakeLspHandler, options?: FakeLspOptions): FakeLspServer {
	const encoder = new TextEncoder();
	const received: RpcMessage[] = [];
	const waiters: Array<{
		predicate: (message: RpcMessage) => boolean;
		resolve: (message: RpcMessage) => void;
		timer: Timer;
	}> = [];
	let exitCode: number | null = null;
	let killed = false;
	let spawnCount = 0;
	let stdoutStopped = false;
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
			if (controller && exitCode === null && !stdoutStopped) controller.enqueue(frame(message));
		},
		exit(code = 0) {
			if (exitCode !== null) return;
			if (!stdoutStopped) {
				stdoutStopped = true;
				controller?.close();
			}
			if (options?.stdoutClosesBeforeExit) {
				queueMicrotask(() => {
					exitCode = code;
					resolveExited(code);
				});
				return;
			}
			exitCode = code;
			resolveExited(code);
		},
		failStdout(error) {
			if (stdoutStopped) return;
			stdoutStopped = true;
			controller?.error(error);
		},
		get killed() {
			return killed;
		},
		get spawnCount() {
			return spawnCount;
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
		peekStderr: () => options?.stderr ?? "",
		kill() {
			killed = true;
			if (options?.killResolvesExit !== false) server.exit(0);
		},
	} as unknown as LspClient["proc"];

	vi.spyOn(piUtils.ptree, "spawn").mockImplementation((() => {
		spawnCount++;
		return proc as unknown as piUtils.ptree.ChildProcess<"pipe">;
	}) as typeof piUtils.ptree.spawn);
	return server;
}

/** LSP fake that completes initialize and graceful shutdown handshakes. */
function installHandshakeLsp(): FakeLspServer {
	return installFakeLsp((message, server) => {
		if (message.method === "initialize") {
			server.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
		} else if (message.method === "shutdown") {
			server.send({ jsonrpc: "2.0", id: message.id, result: null });
		} else if (message.method === "exit") {
			server.exit(0);
		}
	});
}

type BunSpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;

interface BunSpawnCall {
	cmd: string[];
	options?: BunSpawnOptions;
}

interface BunSpawnOutput {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
}

function textStream(text: string): ReadableStream<Uint8Array> {
	const body = new Response(text).body;
	if (!body) {
		throw new Error("Failed to create text stream");
	}
	return body;
}

function completedProcess(stdout = "", stderr = "", exitCode = 0): Subprocess {
	return {
		pid: 12_345,
		stdout: textStream(stdout),
		stderr: textStream(stderr),
		exited: Promise.resolve(exitCode),
		kill: () => {},
	} as Subprocess;
}

function recordBunSpawn(calls: BunSpawnCall[], outputForCommand: (cmd: string[]) => BunSpawnOutput = () => ({})): void {
	vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options?: BunSpawnOptions) => {
		const recordedCmd = [...cmd];
		calls.push({ cmd: recordedCmd, options });
		const output = outputForCommand(recordedCmd);
		return completedProcess(output.stdout, output.stderr, output.exitCode);
	}) as typeof Bun.spawn);
}

function textResult(result: AgentToolResult<LspToolDetails>): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

/**
 * `loadConfig` walks the user config directories (~/.omp/agent, ~/.pi/agent,
 * ~/.claude), which resolve from os.homedir(). A developer with a real
 * lsp.json there flips loadConfig off its auto-detect path onto the override
 * path, where their rootMarkers replace the packaged ones — so these tests
 * would assert against that machine's config instead of the defaults. Point
 * HOME at an empty directory so every case sees a pristine environment.
 */
let lspHomeOverride: string | undefined;
let lspOriginalHome: string | undefined;

beforeEach(() => {
	lspOriginalHome = process.env.HOME;
	lspHomeOverride = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lsp-test-home-"));
	process.env.HOME = lspHomeOverride;
	// Bun's os.homedir() reads the passwd entry rather than $HOME, so the env
	// var alone does not redirect the config walk.
	vi.spyOn(os, "homedir").mockReturnValue(lspHomeOverride);
});

afterEach(() => {
	if (lspOriginalHome === undefined) delete process.env.HOME;
	else process.env.HOME = lspOriginalHome;
	if (lspHomeOverride) fs.rmSync(lspHomeOverride, { recursive: true, force: true });
	lspHomeOverride = undefined;
});

describe("lsp regressions", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("detects bracket-style glob patterns", () => {
		expect(hasGlobPattern("src/[ab].ts")).toBe(true);
		expect(hasGlobPattern("src/**/*.ts")).toBe(true);
		expect(hasGlobPattern("src/main.ts")).toBe(false);
	});

	it("supports long LSP timeouts up to the advertised ceiling", () => {
		expect(clampTimeout("lsp")).toBe(20);
		expect(clampTimeout("lsp", 1)).toBe(5);
		expect(clampTimeout("lsp", 120)).toBe(120);
		expect(clampTimeout("lsp", 1000)).toBe(300);
		expect(arkToWireSchema(lspSchema)).toMatchObject({
			properties: {
				timeout: {
					description: "Timeout in seconds (default 20; range 5–300).",
					maximum: 300,
					minimum: 5,
				},
			},
		});
	});

	it("keeps equivalent LSP configs shared but isolates distinct process and initialization semantics", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-client-identity-");
		try {
			installHandshakeLsp();
			const base: ServerConfig = {
				command: "fake-lsp",
				args: ["--mode", "base"],
				fileTypes: [".ts"],
				rootMarkers: [],
				initOptions: { nested: { beta: 2, alpha: 1 } },
				settings: { diagnostics: { enabled: true, severity: "warning" } },
			};
			const baseClient = await lspClient.getOrCreateClient(base, tempDir.path(), 1_000);

			// Object insertion order is not semantic: a canonical-equivalent config
			// must still share the same process.
			const equivalent = await lspClient.getOrCreateClient(
				{
					...base,
					initOptions: { nested: { alpha: 1, beta: 2 } },
					settings: { diagnostics: { severity: "warning", enabled: true } },
				},
				tempDir.path(),
				1_000,
			);
			expect(equivalent).toBe(baseClient);

			installHandshakeLsp();
			const differentArgs = await lspClient.getOrCreateClient(
				{ ...base, args: ["--mode", "other"] },
				tempDir.path(),
				1_000,
			);
			installHandshakeLsp();
			const differentInit = await lspClient.getOrCreateClient(
				{ ...base, initOptions: { nested: { alpha: 99, beta: 2 } } },
				tempDir.path(),
				1_000,
			);
			installHandshakeLsp();
			const differentSettings = await lspClient.getOrCreateClient(
				{ ...base, settings: { diagnostics: { enabled: false, severity: "warning" } } },
				tempDir.path(),
				1_000,
			);
			const languageServer = installHandshakeLsp();
			const differentLanguage = await lspClient.getOrCreateClient(
				{ ...base, languageId: "typescriptreact" },
				tempDir.path(),
				1_000,
			);
			const filePath = path.join(tempDir.path(), "component.ts");
			await Bun.write(filePath, "export const component = true;\n");
			await lspClient.ensureFileOpen(differentLanguage, filePath);
			const didOpen = await languageServer.waitFor(message => message.method === "textDocument/didOpen");
			expect(didOpen.params).toMatchObject({ textDocument: { languageId: "typescriptreact" } });

			expect(differentArgs).not.toBe(baseClient);
			expect(differentInit).not.toBe(baseClient);
			expect(differentSettings).not.toBe(baseClient);
			expect(differentLanguage).not.toBe(baseClient);
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("uses a custom server languageId for disk and in-memory document opens", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-language-id-");
		const filePath = path.join(tempDir.path(), "foo.gd");
		const syncedFilePath = path.join(tempDir.path(), "unsaved.gd");
		try {
			await Bun.write(
				path.join(tempDir.path(), ".omp", "lsp.json"),
				JSON.stringify({
					servers: {
						"fake-gd": {
							command: process.execPath,
							fileTypes: [".gd"],
							languageId: "gdscript",
							rootMarkers: [".omp"],
						},
					},
				}),
			);
			await Bun.write(filePath, "extends Node\n");

			const server = installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});
			const config = loadConfig(tempDir.path());
			const serverConfig = getServersForFile(config, filePath)[0]?.[1];
			if (!serverConfig) throw new Error("Custom GDScript server was not loaded");

			const client = await lspClient.getOrCreateClient(serverConfig, tempDir.path(), 1_000);
			await lspClient.ensureFileOpen(client, filePath);
			const diskOpen = await server.waitFor(message => message.method === "textDocument/didOpen");
			expect(diskOpen.params).toMatchObject({ textDocument: { languageId: "gdscript" } });

			await lspClient.syncContent(client, syncedFilePath, "extends Resource\n");
			const syncedOpen = await server.waitFor(
				message => message.method === "textDocument/didOpen" && message !== diskOpen,
			);
			expect(syncedOpen.params).toMatchObject({ textDocument: { languageId: "gdscript" } });
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("sends the LSP exit notification and releases the idle checker after shutdown", async () => {
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

			const clientModule = new URL("../../src/lsp/client.ts", import.meta.url).href;
			const shutdownProbe = Bun.spawn(
				[
					process.execPath,
					"-e",
					`import { setIdleTimeout, shutdownAll } from ${JSON.stringify(clientModule)}; setIdleTimeout(60_000); await shutdownAll();`,
				],
				{ stdout: "ignore", stderr: "inherit" },
			);
			// Real time is required because fake timers cannot advance a separate Bun process.
			// The process exit itself proves shutdown released the event loop.
			const probeExit = await Promise.race([shutdownProbe.exited, Bun.sleep(5_000).then(() => null)]);
			if (probeExit === null) {
				shutdownProbe.kill();
				await shutdownProbe.exited;
			}
			expect(probeExit).toBe(0);
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("rearms the idle checker from cached config after global shutdown", async () => {
		const cwd = "/cached-lsp-config";
		const intervalSpy = vi.spyOn(globalThis, "setInterval");
		configCache.set(cwd, { servers: {}, idleTimeoutMs: 60_000 });
		try {
			lspClient.setIdleTimeout(60_000);
			expect(intervalSpy).toHaveBeenCalledTimes(1);

			await lspClient.shutdownAll();
			getConfig(cwd);

			expect(intervalSpy).toHaveBeenCalledTimes(2);
		} finally {
			lspClient.setIdleTimeout(null);
			configCache.delete(cwd);
		}
	});

	it("returns an already-starting client without creating a second client", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-pending-client-");
		const initialize = Promise.withResolvers<void>();
		try {
			const server = installFakeLsp(async (message, srv) => {
				if (message.method === "initialize") {
					await initialize.promise;
					srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});
			const config: ServerConfig = {
				command: "fake-pending-lsp",
				fileTypes: ["ts"],
				rootMarkers: [],
			};

			const startingClient = lspClient.getOrCreateClient(config, tempDir.path(), 1_000);
			await server.waitFor(message => message.method === "initialize");
			const existingClient = lspClient.getActiveOrPendingClient(config, tempDir.path());
			let settled = false;
			void existingClient.then(() => {
				settled = true;
			});
			await Bun.sleep(0);
			expect(settled).toBe(false);

			initialize.resolve();
			expect(await existingClient).toBe(await startingClient);
			expect(server.received.filter(message => message.method === "initialize")).toHaveLength(1);
		} finally {
			initialize.resolve();
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("stops waiting for a pending client on caller abort without cancelling its initialization", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-pending-abort-");
		const initialize = Promise.withResolvers<void>();
		try {
			const server = installFakeLsp(async (message, srv) => {
				if (message.method === "initialize") {
					await initialize.promise;
					srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});
			const config: ServerConfig = {
				command: "fake-abort-pending-lsp",
				fileTypes: ["ts"],
				rootMarkers: [],
			};

			const startingClient = lspClient.getOrCreateClient(config, tempDir.path(), 1_000);
			await server.waitFor(message => message.method === "initialize");
			const controller = new AbortController();
			const waitingClient = lspClient.getActiveOrPendingClient(config, tempDir.path(), controller.signal);
			controller.abort();
			await expect(waitingClient).rejects.toThrow();

			initialize.resolve();
			expect(await startingClient).toBeDefined();
			expect(server.received.filter(message => message.method === "initialize")).toHaveLength(1);
		} finally {
			initialize.resolve();
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("advertises workspace folder support and abort-on-failure workspace edits during LSP initialization", async () => {
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
				capabilities?: {
					workspace?: { workspaceFolders?: unknown; workspaceEdit?: { failureHandling?: unknown } };
				};
				workspaceFolders?: unknown;
			};

			expect(params.capabilities?.workspace?.workspaceFolders).toBe(true);
			expect(params.capabilities?.workspace?.workspaceEdit?.failureHandling).toBe("abort");
			expect(params.workspaceFolders).toEqual([
				{ uri: fileToUri(tempDir.path()), name: path.basename(tempDir.path()) },
			]);
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("does not advertise unsupported snippet text edits", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-snippet-capability-");
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
			const params = init?.params as { capabilities?: { experimental?: { snippetTextEdit?: boolean } } };
			expect(params.capabilities?.experimental?.snippetTextEdit).toBeUndefined();
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

	it("sends initial workspace configuration after initialized before semantic requests (#5276)", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-initial-config-");
		let receivedInitialConfiguration = false;
		try {
			const server = installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { hoverProvider: true } } });
				} else if (message.method === "workspace/didChangeConfiguration") {
					receivedInitialConfiguration = true;
				} else if (message.method === "textDocument/hover" && receivedInitialConfiguration) {
					srv.send({ jsonrpc: "2.0", id: message.id, result: { contents: "configured hover" } });
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});
			const settings = {
				"typescript-language-server": {
					preferences: {
						includePackageJsonAutoImports: "on",
						importModuleSpecifierPreference: "non-relative",
					},
					inlayHints: {
						includeInlayEnumMemberValueHints: true,
						includeInlayParameterNameHints: "all",
					},
				},
			};
			const config: ServerConfig = {
				command: "fake-lsp",
				fileTypes: ["ts"],
				rootMarkers: [],
				settings,
			};

			const client = await lspClient.getOrCreateClient(config, tempDir.path(), 1_000);
			const result = await lspClient.sendRequest(
				client,
				"textDocument/hover",
				{
					textDocument: { uri: fileToUri(path.join(tempDir.path(), "src", "configured.ts")) },
					position: { line: 0, character: 0 },
				},
				undefined,
				50,
			);

			expect(result).toEqual({ contents: "configured hover" });
			const methods = server.received.map(message => message.method);
			expect(methods.slice(0, 4)).toEqual([
				"initialize",
				"initialized",
				"workspace/didChangeConfiguration",
				"textDocument/hover",
			]);
			expect(server.received[2].params).toEqual({ settings: config.settings });
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("answers missing workspace configuration sections with null in request order", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-configuration-null-");
		try {
			const server = installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
				} else if (message.method === "initialized") {
					srv.send({
						jsonrpc: "2.0",
						id: 5745,
						method: "workspace/configuration",
						params: {
							items: [
								{ section: "razor.format.attribute_indent_style" },
								{ section: "html.auto_closing_tags" },
								{},
							],
						},
					});
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});
			const config: ServerConfig = {
				command: "fake-lsp",
				fileTypes: ["cs"],
				rootMarkers: [],
				settings: { "html.auto_closing_tags": true },
			};

			await lspClient.getOrCreateClient(config, tempDir.path(), 1_000);
			const response = await server.waitFor(message => message.id === 5745 && message.method === undefined);

			expect(response.result).toEqual([null, true, null]);
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("keeps the session alive when configuration is pulled after didChangeConfiguration", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-configuration-session-");
		let configurationAccepted = false;
		try {
			const server = installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { hoverProvider: true } } });
				} else if (message.method === "workspace/didChangeConfiguration") {
					srv.send({
						jsonrpc: "2.0",
						id: "roslyn-config",
						method: "workspace/configuration",
						params: { items: [{ section: "razor.format.attribute_indent_style" }] },
					});
				} else if (message.id === "roslyn-config" && message.method === undefined) {
					if (Array.isArray(message.result) && message.result[0] === null) {
						configurationAccepted = true;
					} else {
						srv.exit(-6);
					}
				} else if (message.method === "textDocument/hover" && configurationAccepted) {
					srv.send({ jsonrpc: "2.0", id: message.id, result: { contents: "string C.Target" } });
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});
			const config: ServerConfig = {
				command: "fake-lsp",
				fileTypes: ["cs"],
				rootMarkers: [],
			};

			const client = await lspClient.getOrCreateClient(config, tempDir.path(), 1_000);
			await server.waitFor(message => message.id === "roslyn-config" && message.method === undefined);
			const result = await lspClient.sendRequest(
				client,
				"textDocument/hover",
				{
					textDocument: { uri: fileToUri(path.join(tempDir.path(), "Target.cs")) },
					position: { line: 0, character: 6 },
				},
				undefined,
				50,
			);

			expect(result).toEqual({ contents: "string C.Target" });
			expect(configurationAccepted).toBe(true);
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
			const fakeServer = installFakeLsp((message, srv) => {
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

			const tool = new LspTool(makeLspSession(tempDir.path()));
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
			const firstStatusRequest = fakeServer.received.find(
				message => message.method === "rust-analyzer/analyzerStatus",
			);
			if (!firstStatusRequest) throw new Error("Expected the timed-out analyzer status request");
			const cancellation = await fakeServer.waitFor(message => message.method === "$/cancelRequest");
			expect(cancellation.params).toEqual({ id: firstStatusRequest.id });
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

			const tool = new LspTool(makeLspSession(tempDir.path()));
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

	it("sanitizes expanded generic error output (#7041)", async () => {
		const theme = await getThemeByName("dark");
		const result = renderLocalResult(
			{
				content: [{ type: "text", text: `Error:\nserver\tstderr ${"x".repeat(200)}` }],
			},
			{ expanded: true, isPartial: false },
			theme!,
		);

		const lines = sanitizeText(result.render(300).join("\n")).split("\n");
		expect(lines.join("\n")).not.toContain("\t");
		expect(lines.join("\n")).not.toContain("x".repeat(100));
	});

	for (const dynamicRegistration of [false, true]) {
		it(`reports pull diagnostics advertised through ${dynamicRegistration ? "dynamic registration" : "server capabilities"}`, async () => {
			const tempDir = TempDir.createSync("@omp-lsp-pull-diags-");
			try {
				const targetFile = path.join(tempDir.path(), "target.ts");
				await Bun.write(targetFile, "const broken: string = 42;\n");
				const diagnostic: Diagnostic = {
					message: "Type 'number' is not assignable to type 'string'.",
					severity: 1,
					code: 2322,
					source: "ts",
					range: {
						start: { line: 0, character: 6 },
						end: { line: 0, character: 12 },
					},
				};

				const fakeServer = installFakeLsp((message, server) => {
					if (message.method === "initialize") {
						server.send({
							jsonrpc: "2.0",
							id: message.id,
							result: { capabilities: dynamicRegistration ? {} : { diagnosticProvider: true } },
						});
						server.send({
							jsonrpc: "2.0",
							method: "$/progress",
							params: { token: "workspace", value: { kind: "begin" } },
						});
						server.send({
							jsonrpc: "2.0",
							method: "$/progress",
							params: { token: "workspace", value: { kind: "end" } },
						});
					} else if (dynamicRegistration && message.method === "initialized") {
						server.send({
							jsonrpc: "2.0",
							id: "register-diagnostics",
							method: "client/registerCapability",
							params: {
								registrations: [
									{
										id: "pull-diagnostics",
										method: "textDocument/diagnostic",
										registerOptions: {},
									},
								],
							},
						});
					} else if (message.method === "textDocument/diagnostic") {
						server.send({
							jsonrpc: "2.0",
							id: message.id,
							result: { kind: "full", items: [diagnostic] },
						});
					} else if (message.method === "shutdown") {
						server.send({ jsonrpc: "2.0", id: message.id, result: null });
					} else if (message.method === "exit") {
						server.exit(0);
					}
				});

				const serverConfig: ServerConfig = {
					command: "fake-lsp",
					fileTypes: ["ts"],
					rootMarkers: [],
				};
				vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
					servers: { "fake-lsp": serverConfig },
					idleTimeoutMs: undefined,
				});
				vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["fake-lsp", serverConfig]]);

				const tool = new LspTool(makeLspSession(tempDir.path()));
				const result = await tool.execute(`pull-diagnostics-${dynamicRegistration}`, {
					action: "diagnostics",
					file: targetFile,
					timeout: 20,
				});
				const initialize = fakeServer.received.find(message => message.method === "initialize");

				expect(initialize).toMatchObject({
					params: {
						capabilities: {
							textDocument: { diagnostic: { dynamicRegistration: true } },
						},
					},
				});
				expect(fakeServer.received.map(message => message.method)).toContain("textDocument/diagnostic");
				expect(textResult(result)).toContain("Type 'number' is not assignable to type 'string'.");
			} finally {
				await lspClient.shutdownAll();
				tempDir.removeSync();
			}
		}, 15_000);
	}

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

			let poll = 0;
			vi.spyOn(Bun, "sleep").mockImplementation(async () => {
				poll++;
				if (poll === 1) {
					client.diagnostics.set(otherUri, { diagnostics: [otherDiagnostic], version: 1 });
					client.diagnosticsVersion += 1;
					return;
				}
				if (poll === 2) {
					client.diagnostics.set(targetUri, {
						diagnostics: [],
						version: client.openFiles.get(targetUri)?.version ?? 2,
					});
					client.diagnosticsVersion += 1;
					return;
				}
				throw new Error("waitForDiagnostics polled after the fresh target publish");
			});

			const tool = new LspTool(makeLspSession(tempDir.path()));
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

	it("reports failure when every applicable diagnostics server fails (#8377)", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-all-servers-fail-");
		try {
			const targetFile = path.join(tempDir.path(), "target.ts");
			await Bun.write(targetFile, "export const target = 1;\n");
			// The diagnostics renderer prefixes status lines via the global theme,
			// which production initializes before any tool runs.
			await initTheme();

			const serverConfig: ServerConfig = {
				command: "broken-lsp",
				fileTypes: ["ts"],
				rootMarkers: [],
			};
			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { broken: serverConfig },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["broken", serverConfig]]);
			vi.spyOn(lspClient, "getOrCreateClient").mockRejectedValue(new Error("server exited with code 7"));

			const tool = new LspTool(makeLspSession(tempDir.path()));
			const result = await tool.execute("all-servers-fail", {
				action: "diagnostics",
				file: targetFile,
				timeout: 5,
			});

			// A total server failure must not masquerade as a clean file.
			expect(result.details?.success).toBe(false);
			const output = textResult(result);
			expect(output).not.toBe("OK");
			expect(output).toContain("all language servers failed");
			expect(output).toContain("broken");
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("treats a go.work-only root as a Go workspace for workspace diagnostics", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-go-work-only-");
		const spawnCalls: BunSpawnCall[] = [];
		recordBunSpawn(spawnCalls, cmd => {
			if (cmd.join("\0") === "go\0work\0edit\0-json") {
				return { stdout: JSON.stringify({ Use: [{ DiskPath: "./service" }] }) };
			}
			return {};
		});

		try {
			const serviceDir = path.join(tempDir.path(), "service");
			await fs.promises.mkdir(serviceDir, { recursive: true });
			await Bun.write(path.join(tempDir.path(), "go.work"), ["go 1.22", "", "use ./service", ""].join("\n"));
			await Bun.write(path.join(serviceDir, "go.mod"), "module example.com/service\n\ngo 1.22\n");

			const tool = new LspTool(makeLspSession(tempDir.path()));
			const result = await tool.execute("go-work-only-diagnostics", {
				action: "diagnostics",
				file: "*",
			});

			const buildCalls = spawnCalls.filter(call => call.cmd[0] === "go" && call.cmd[1] === "build");
			expect(buildCalls).toHaveLength(1);
			expect(buildCalls[0]?.cmd).toEqual(["go", "build", "./service/..."]);
			expect(buildCalls[0]?.options?.cwd).toBe(tempDir.path());
			const output = textResult(result);
			expect(output).toContain("Workspace diagnostics (");
			expect(output).toContain("go build");
			expect(output).toContain("No issues found");
			expect(output).not.toContain("Cannot detect project type");
		} finally {
			tempDir.removeSync();
		}
	});

	it("builds every go.work use module when go.work and go.mod coexist", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-go-work-before-mod-");
		const spawnCalls: BunSpawnCall[] = [];
		recordBunSpawn(spawnCalls, cmd => {
			if (cmd.join("\0") === "go\0work\0edit\0-json") {
				return {
					stdout: JSON.stringify({
						Use: [{ DiskPath: "." }, { DiskPath: "./service" }, { DiskPath: "./tools/helper" }],
					}),
				};
			}
			return {};
		});

		try {
			const serviceDir = path.join(tempDir.path(), "service");
			const helperDir = path.join(tempDir.path(), "tools", "helper");
			await fs.promises.mkdir(serviceDir, { recursive: true });
			await fs.promises.mkdir(helperDir, { recursive: true });
			await Bun.write(path.join(tempDir.path(), "go.mod"), "module example.com/root\n\ngo 1.22\n");
			await Bun.write(path.join(serviceDir, "go.mod"), "module example.com/service\n\ngo 1.22\n");
			await Bun.write(path.join(helperDir, "go.mod"), "module example.com/helper\n\ngo 1.22\n");
			await Bun.write(
				path.join(tempDir.path(), "go.work"),
				["go 1.22", "", "use (", "\t.", "\t./service", "\t./tools/helper", ")", ""].join("\n"),
			);

			const tool = new LspTool(makeLspSession(tempDir.path()));
			const result = await tool.execute("go-work-module-patterns", {
				action: "diagnostics",
				file: "*",
			});

			const buildCalls = spawnCalls.filter(call => call.cmd[0] === "go" && call.cmd[1] === "build");
			expect(buildCalls).toHaveLength(1);
			expect(buildCalls[0]?.cmd.slice(0, 2)).toEqual(["go", "build"]);
			expect(buildCalls[0]?.cmd.slice(2).sort()).toEqual(["./...", "./service/...", "./tools/helper/..."]);
			expect(textResult(result)).toContain("Workspace diagnostics (");
			expect(textResult(result)).toContain("go build");
		} finally {
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

	it("detects Ruff in Windows virtualenv Scripts directories", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true, writable: true });

		const tempDir = TempDir.createSync("@omp-lsp-win32-ruff-");
		const whichSpy = vi.spyOn(Bun, "which").mockReturnValue(null);

		try {
			await Bun.write(path.join(tempDir.path(), "pyproject.toml"), '[project]\nname = "demo"\n');
			const scriptsDir = path.join(tempDir.path(), ".venv", "Scripts");
			await fs.promises.mkdir(scriptsDir, { recursive: true });
			const localRuff = path.join(scriptsDir, "ruff.exe");
			await Bun.write(localRuff, "");

			const config = loadConfig(tempDir.path());
			expect(config.servers.ruff?.resolvedCommand).toBe(localRuff);
			expect(whichSpy).not.toHaveBeenCalledWith("ruff");
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true, writable: true });
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("detects Ruff in Windows virtualenv Scripts directories for Ruff-only roots", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true, writable: true });
		const whichSpy = vi.spyOn(Bun, "which").mockReturnValue(null);

		try {
			for (const marker of ["ruff.toml", ".ruff.toml"] as const) {
				const tempDir = TempDir.createSync("@omp-lsp-win32-ruff-marker-");
				try {
					await Bun.write(path.join(tempDir.path(), marker), "");
					const scriptsDir = path.join(tempDir.path(), ".venv", "Scripts");
					await fs.promises.mkdir(scriptsDir, { recursive: true });
					const localRuff = path.join(scriptsDir, "ruff.exe");
					await Bun.write(localRuff, "");

					const config = loadConfig(tempDir.path());
					expect(config.servers.ruff?.resolvedCommand).toBe(localRuff);
				} finally {
					tempDir.removeSync();
				}
			}
			expect(whichSpy).not.toHaveBeenCalledWith("ruff");
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true, writable: true });
			vi.restoreAllMocks();
		}
	});

	it("detects pyright and pylsp in Windows virtualenv Scripts for Python-only roots", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true, writable: true });
		const whichSpy = vi.spyOn(Bun, "which").mockReturnValue(null);

		try {
			const cases: Array<{ marker: string; server: string; binary: string }> = [
				{ marker: "pyrightconfig.json", server: "pyright", binary: "pyright-langserver.exe" },
				{ marker: "setup.cfg", server: "pylsp", binary: "pylsp.exe" },
			];
			for (const { marker, server, binary } of cases) {
				const tempDir = TempDir.createSync("@omp-lsp-win32-py-marker-");
				try {
					await Bun.write(path.join(tempDir.path(), marker), "");
					const scriptsDir = path.join(tempDir.path(), ".venv", "Scripts");
					await fs.promises.mkdir(scriptsDir, { recursive: true });
					const localBin = path.join(scriptsDir, binary);
					await Bun.write(localBin, "");

					const config = loadConfig(tempDir.path());
					expect(config.servers[server]?.resolvedCommand).toBe(localBin);
				} finally {
					tempDir.removeSync();
				}
			}
			expect(whichSpy).not.toHaveBeenCalledWith("pyright-langserver");
			expect(whichSpy).not.toHaveBeenCalledWith("pylsp");
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true, writable: true });
			vi.restoreAllMocks();
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

			const tool = new LspTool(makeLspSession(tempDir.path()));
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

	it("rename_file rejects a snippet edit before writing any file", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rename-snippet-");
		try {
			const sourceFile = path.join(tempDir.path(), "src", "old.ts");
			const destFile = path.join(tempDir.path(), "src", "new.ts");
			const plainFile = path.join(tempDir.path(), "src", "plain.ts");
			const snippetFile = path.join(tempDir.path(), "src", "snippet.ts");
			await Bun.write(sourceFile, "export const value = 42;\n");
			await Bun.write(plainFile, "import { value } from './old';\n");
			await Bun.write(snippetFile, "import { value } from './old';\n");

			const plainUri = fileToUri(plainFile);
			const snippetUri = fileToUri(snippetFile);

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
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_client, method) => {
				if (method === "workspace/willRenameFiles") {
					return {
						// plainUri is a valid edit; snippetUri carries insertTextFormat 2.
						// The plain bucket must NOT be written when the snippet bucket rejects.
						changes: {
							[plainUri]: [
								{
									range: { start: { line: 0, character: 22 }, end: { line: 0, character: 29 } },
									newText: "'./new'",
								},
							],
							[snippetUri]: [
								{
									range: { start: { line: 0, character: 22 }, end: { line: 0, character: 29 } },
									newText: "'./new$0'",
									insertTextFormat: 2,
								},
							],
						},
					};
				}
				return null;
			});
			vi.spyOn(lspClient, "sendNotification").mockResolvedValue();

			const tool = new LspTool(makeLspSession(tempDir.path()));
			await expect(
				tool.execute("rename-snippet-test", {
					action: "rename_file",
					file: sourceFile,
					new_name: destFile,
					timeout: 5,
				}),
			).rejects.toThrow("snippet-formatted LSP edits are unsupported");

			// Nothing was half-applied: the plain bucket is untouched and the
			// rename never ran.
			expect(await Bun.file(plainFile).text()).toBe("import { value } from './old';\n");
			expect(await Bun.file(snippetFile).text()).toBe("import { value } from './old';\n");
			expect(fs.existsSync(sourceFile)).toBe(true);
			expect(fs.existsSync(destFile)).toBe(false);
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("rename_file aborts before mutation when willRenameFiles fails on a supporting server", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rename-file-fail-");
		try {
			const sourceFile = path.join(tempDir.path(), "src", "old.ts");
			const destFile = path.join(tempDir.path(), "src", "new.ts");
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

			// A server that supports willRenameFiles but fails with a real error
			// (not method-not-found). The rename must not proceed.
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_client, method) => {
				if (method === "workspace/willRenameFiles") {
					throw new Error("internal error: index not ready");
				}
				return null;
			});
			const notifySpy = vi.spyOn(lspClient, "sendNotification").mockResolvedValue();

			const tool = new LspTool(makeLspSession(tempDir.path()));
			const result = await tool.execute("rename-file-fail", {
				action: "rename_file",
				file: sourceFile,
				new_name: destFile,
				timeout: 5,
			});

			// No filesystem mutation.
			expect(fs.existsSync(sourceFile)).toBe(true);
			expect(fs.existsSync(destFile)).toBe(false);
			// No didRenameFiles notification.
			expect(notifySpy).not.toHaveBeenCalledWith(expect.anything(), "workspace/didRenameFiles", expect.anything());

			expect(result.details).toMatchObject({ action: "rename_file", success: false });
			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(output).toContain("aborted rename");
			expect(output).toContain("index not ready");
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("rename_file skips a server that replies method-not-found and still renames", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rename-file-mnf-");
		try {
			const sourceFile = path.join(tempDir.path(), "src", "old.ts");
			const destFile = path.join(tempDir.path(), "src", "new.ts");
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
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_client, method) => {
				if (method === "workspace/willRenameFiles") {
					throw new Error("Method not found: -32601");
				}
				return null;
			});
			vi.spyOn(lspClient, "sendNotification").mockResolvedValue();

			const tool = new LspTool(makeLspSession(tempDir.path()));
			const result = await tool.execute("rename-file-mnf", {
				action: "rename_file",
				file: sourceFile,
				new_name: destFile,
				timeout: 5,
			});

			// Unsupported server does not block: the path still moves.
			expect(fs.existsSync(sourceFile)).toBe(false);
			expect(fs.existsSync(destFile)).toBe(true);
			expect(result.details).toMatchObject({ action: "rename_file", success: true });
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

			const tool = new LspTool(makeLspSession(tempDir.path()));
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

			const tool = new LspTool(makeLspSession(tempDir.path()));
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

			const tool = new LspTool(makeLspSession(tempDir.path()));
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

			const tool = new LspTool(makeLspSession(tempDir.path()));
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

			const tool = new LspTool(makeLspSession(tempDir.path()));
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

	it("synchronizes open document overlays after applying a rename workspace edit", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-workspace-edit-sync-");
		const filePath = path.join(tempDir.path(), "main.go");
		const uri = fileToUri(filePath);
		let overlay = "";
		try {
			await Bun.write(filePath, "package main\nfunc OldName() {}\n");
			const serverConfig: ServerConfig = {
				command: "fake-gopls",
				fileTypes: ["go"],
				rootMarkers: [],
				isLinter: true,
			};
			installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					srv.send({
						jsonrpc: "2.0",
						id: message.id,
						result: { capabilities: { documentSymbolProvider: true, renameProvider: true } },
					});
				} else if (message.method === "textDocument/didOpen") {
					if (
						typeof message.params === "object" &&
						message.params !== null &&
						"textDocument" in message.params &&
						typeof message.params.textDocument === "object" &&
						message.params.textDocument !== null &&
						"text" in message.params.textDocument &&
						typeof message.params.textDocument.text === "string"
					) {
						overlay = message.params.textDocument.text;
					}
				} else if (message.method === "textDocument/didChange") {
					if (
						typeof message.params === "object" &&
						message.params !== null &&
						"contentChanges" in message.params &&
						Array.isArray(message.params.contentChanges) &&
						typeof message.params.contentChanges[0] === "object" &&
						message.params.contentChanges[0] !== null &&
						"text" in message.params.contentChanges[0] &&
						typeof message.params.contentChanges[0].text === "string"
					) {
						overlay = message.params.contentChanges[0].text;
					}
				} else if (message.method === "textDocument/documentSymbol") {
					const name = overlay.includes("NewName") ? "NewName" : "OldName";
					srv.send({
						jsonrpc: "2.0",
						id: message.id,
						result: [
							{
								name,
								kind: 12,
								range: { start: { line: 1, character: 0 }, end: { line: 1, character: 17 } },
								selectionRange: { start: { line: 1, character: 5 }, end: { line: 1, character: 12 } },
							},
						],
					});
				} else if (message.method === "textDocument/rename") {
					srv.send({
						jsonrpc: "2.0",
						id: message.id,
						result: {
							changes: {
								[uri]: [
									{
										range: { start: { line: 1, character: 5 }, end: { line: 1, character: 12 } },
										newText: "NewName",
									},
								],
							},
						},
					});
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});
			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "fake-gopls": serverConfig },
				idleTimeoutMs: undefined,
			});

			const tool = new LspTool(makeLspSession(tempDir.path()));
			expect(
				textResult(await tool.execute("symbols-before-rename", { action: "symbols", file: filePath })),
			).toContain("OldName");
			await tool.execute("rename-open-document", {
				action: "rename",
				file: filePath,
				line: 2,
				symbol: "OldName",
				new_name: "NewName",
			});
			expect(await Bun.file(filePath).text()).toContain("NewName");

			const symbols = await tool.execute("symbols-after-rename", { action: "symbols", file: filePath });
			expect(textResult(symbols)).toContain("NewName");
		} finally {
			configCache.delete(tempDir.path());
			await lspClient.shutdownAll();
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

			const { applied } = await applyWorkspaceEdit(workspaceEdit, tempDir.path());

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
				options: { overwrite: true },
			};
			const workspaceEdit: WorkspaceEdit = {
				documentChanges: [targetEdit, renameOp],
			};

			const { applied } = await applyWorkspaceEdit(workspaceEdit, tempDir.path());

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

	it("dedupes byte-identical non-empty text edits before overlap validation", () => {
		const edit = {
			range: { start: { line: 9, character: 55 }, end: { line: 9, character: 62 } },
			newText: "./megaMenu",
		};

		expect(sortAndValidateTextEdits([edit, { ...edit }])).toEqual([edit]);
		expect(
			applyTextEditsToString("import x from './menu';\n", [
				{
					range: { start: { line: 0, character: 15 }, end: { line: 0, character: 21 } },
					newText: "./megaMenu",
				},
				{
					range: { start: { line: 0, character: 15 }, end: { line: 0, character: 21 } },
					newText: "./megaMenu",
				},
			]),
		).toBe("import x from './megaMenu';\n");
	});

	it("rejects unexpected snippet text edits without writing their syntax", () => {
		expect(() =>
			applyTextEditsToString("struct S;", [
				{
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
					newText: "#[derive($0)] ",
					insertTextFormat: 2,
				},
			]),
		).toThrow("snippet-formatted LSP edits are unsupported");
	});

	it("keeps byte-identical zero-width inserts because they are not idempotent", () => {
		const result = applyTextEditsToString("abc", [
			{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: "X" },
			{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: "X" },
		]);
		expect(result).toBe("aXXbc");
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

			const { applied } = await applyWorkspaceEdit(workspaceEdit, tempDir.path());

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

	it("honors CreateFile overwrite and ignoreIfExists options", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-create-options-");
		try {
			const filePath = path.join(tempDir.path(), "existing.ts");
			const uri = fileToUri(filePath);
			await Bun.write(filePath, "ORIGINAL");

			const ignored = await applyWorkspaceEdit(
				{
					documentChanges: [
						{ kind: "create", uri, options: { overwrite: false, ignoreIfExists: true } } satisfies CreateFile,
					],
				},
				tempDir.path(),
			);
			expect(fs.readFileSync(filePath, "utf8")).toBe("ORIGINAL");
			expect(ignored.applied).toEqual([]);
			expect(ignored.executed).toEqual([]);

			await applyWorkspaceEdit(
				{
					documentChanges: [
						{ kind: "create", uri, options: { overwrite: true, ignoreIfExists: true } } satisfies CreateFile,
					],
				},
				tempDir.path(),
			);
			expect(fs.readFileSync(filePath, "utf8")).toBe("");
		} finally {
			tempDir.removeSync();
		}
	});

	it("honors RenameFile overwrite and ignoreIfExists options", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rename-options-");
		try {
			const oldPath = path.join(tempDir.path(), "old.ts");
			const newPath = path.join(tempDir.path(), "new.ts");
			const oldUri = fileToUri(oldPath);
			const newUri = fileToUri(newPath);
			await Bun.write(oldPath, "SOURCE");
			await Bun.write(newPath, "TARGET");

			const ignored = await applyWorkspaceEdit(
				{
					documentChanges: [
						{
							kind: "rename",
							oldUri,
							newUri,
							options: { overwrite: false, ignoreIfExists: true },
						} satisfies RenameFile,
					],
				},
				tempDir.path(),
			);
			expect(fs.readFileSync(oldPath, "utf8")).toBe("SOURCE");
			expect(fs.readFileSync(newPath, "utf8")).toBe("TARGET");
			expect(ignored.applied).toEqual([]);
			expect(ignored.executed).toEqual([]);

			await applyWorkspaceEdit(
				{
					documentChanges: [
						{
							kind: "rename",
							oldUri,
							newUri,
							options: { overwrite: true, ignoreIfExists: true },
						} satisfies RenameFile,
					],
				},
				tempDir.path(),
			);
			expect(fs.existsSync(oldPath)).toBe(false);
			expect(fs.readFileSync(newPath, "utf8")).toBe("SOURCE");
		} finally {
			tempDir.removeSync();
		}
	});

	it("keeps overlays open when ignoreIfExists skips a rename", async () => {
		// A RenameFile with ignoreIfExists:true whose target exists performs no
		// filesystem mutation, so overlay reconciliation must not close the old
		// URI's open document or announce Deleted/Created to the server.
		const tempDir = TempDir.createSync("@omp-lsp-skipped-rename-overlay-");
		try {
			const oldPath = path.join(tempDir.path(), "old.ts");
			const newPath = path.join(tempDir.path(), "new.ts");
			await Bun.write(oldPath, "SOURCE");
			await Bun.write(newPath, "TARGET");

			const server = installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});
			const config: ServerConfig = { command: "fake-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const client = await lspClient.getOrCreateClient(config, tempDir.path(), 1_000);
			await lspClient.ensureFileOpen(client, oldPath);
			await server.waitFor(message => message.method === "textDocument/didOpen");

			const applied = await lspClient.applyWorkspaceEditWithLsp(
				{
					documentChanges: [
						{
							kind: "rename",
							oldUri: fileToUri(oldPath),
							newUri: fileToUri(newPath),
							options: { overwrite: false, ignoreIfExists: true },
						} satisfies RenameFile,
					],
				},
				tempDir.path(),
			);

			// Nothing ran, nothing moved, and the overlay survived.
			expect(applied).toEqual([]);
			expect(fs.readFileSync(oldPath, "utf8")).toBe("SOURCE");
			expect(fs.readFileSync(newPath, "utf8")).toBe("TARGET");
			expect(client.openFiles.has(fileToUri(oldPath))).toBe(true);
			expect(server.received.filter(message => message.method === "textDocument/didClose")).toEqual([]);
			expect(server.received.filter(message => message.method === "workspace/didChangeWatchedFiles")).toEqual([]);
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("reconciles the executed prefix when a workspace edit fails partway", async () => {
		// A text edit to an open file inside `src/` is flushed to disk before the
		// non-recursive delete of `src/` runs (subtree flush), and that delete
		// throws on the non-empty directory. The error must propagate, but the
		// already-mutated file's overlay must be refreshed — not left stale.
		const tempDir = TempDir.createSync("@omp-lsp-partial-edit-overlay-");
		try {
			const srcDir = path.join(tempDir.path(), "src");
			fs.mkdirSync(srcDir);
			const filePath = path.join(srcDir, "a.ts");
			await Bun.write(filePath, "export const a = 1;\n");

			const server = installFakeLsp((message, srv) => {
				if (message.method === "initialize") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
				} else if (message.method === "shutdown") {
					srv.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					srv.exit(0);
				}
			});
			const config: ServerConfig = { command: "fake-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const client = await lspClient.getOrCreateClient(config, tempDir.path(), 1_000);
			await lspClient.ensureFileOpen(client, filePath);
			await server.waitFor(message => message.method === "textDocument/didOpen");

			const uri = fileToUri(filePath);
			await expect(
				lspClient.applyWorkspaceEditWithLsp(
					{
						documentChanges: [
							{
								textDocument: { uri, version: null },
								edits: [
									{
										range: { start: { line: 0, character: 17 }, end: { line: 0, character: 18 } },
										newText: "2",
									},
								],
							} satisfies TextDocumentEdit,
							{ kind: "delete", uri: fileToUri(srcDir), options: { recursive: false } } satisfies DeleteFile,
						],
					},
					tempDir.path(),
				),
			).rejects.toThrow();

			// Disk carries the executed edit; the failing delete never ran.
			expect(fs.readFileSync(filePath, "utf8")).toBe("export const a = 2;\n");
			expect(fs.existsSync(srcDir)).toBe(true);

			// The overlay was refreshed to the committed content despite the failure.
			const didChange = await server.waitFor(message => message.method === "textDocument/didChange");
			expect(didChange.params).toMatchObject({
				textDocument: { uri },
				contentChanges: [{ text: "export const a = 2;\n" }],
			});
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("honors DeleteFile recursive and ignoreIfNotExists options", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-delete-options-");
		try {
			const directory = path.join(tempDir.path(), "directory");
			const uri = fileToUri(directory);
			fs.mkdirSync(directory);
			await Bun.write(path.join(directory, "child.ts"), "KEEP");

			const nonRecursive: DeleteFile = { kind: "delete", uri, options: { recursive: false } };
			await expect(applyWorkspaceEdit({ documentChanges: [nonRecursive] }, tempDir.path())).rejects.toThrow();
			expect(fs.readFileSync(path.join(directory, "child.ts"), "utf8")).toBe("KEEP");

			const recursive: DeleteFile = { kind: "delete", uri, options: { recursive: true } };
			await applyWorkspaceEdit({ documentChanges: [recursive] }, tempDir.path());
			expect(fs.existsSync(directory)).toBe(false);

			const ignored = await applyWorkspaceEdit(
				{
					documentChanges: [{ kind: "delete", uri, options: { ignoreIfNotExists: true } } satisfies DeleteFile],
				},
				tempDir.path(),
			);
			expect(ignored.applied).toEqual([]);
			expect(ignored.executed).toEqual([]);
		} finally {
			tempDir.removeSync();
		}
	});

	it("does not delete the source when a rename target resolves to the same file", async () => {
		// A case-only rename on a case-insensitive filesystem yields distinct path
		// strings that resolve to one inode. Reproduce that deterministically on a
		// case-sensitive filesystem with a symlinked parent directory: `dir/f.ts`
		// and `dirlink/f.ts` are the same file. The overwrite branch must skip
		// removing the destination, or it deletes the source before the rename.
		const tempDir = TempDir.createSync("@omp-lsp-same-file-rename-");
		try {
			const realDir = path.join(tempDir.path(), "dir");
			fs.mkdirSync(realDir);
			const filePath = path.join(realDir, "f.ts");
			await Bun.write(filePath, "SOURCE");

			const linkDir = path.join(tempDir.path(), "dirlink");
			fs.symlinkSync(realDir, linkDir);
			const aliasPath = path.join(linkDir, "f.ts");

			const renameOp: RenameFile = {
				kind: "rename",
				oldUri: fileToUri(filePath),
				newUri: fileToUri(aliasPath),
				options: { overwrite: true },
			};
			expect(renameOp.oldUri).not.toBe(renameOp.newUri);

			await applyWorkspaceEdit({ documentChanges: [renameOp] }, tempDir.path());
			expect(fs.existsSync(filePath)).toBe(true);
			expect(fs.readFileSync(filePath, "utf8")).toBe("SOURCE");
		} finally {
			tempDir.removeSync();
		}
	});

	it("restores an overwritten rename target when the final rename fails", async () => {
		// An overwrite rename displaces the existing destination before moving the
		// source. If the move itself then fails (EXDEV, permissions), the
		// destination must be restored so the workspace is exactly as it was —
		// previously the destination was deleted outright and stayed lost.
		const tempDir = TempDir.createSync("@omp-lsp-rename-restore-");
		try {
			const oldPath = path.join(tempDir.path(), "old.ts");
			const newPath = path.join(tempDir.path(), "new.ts");
			await Bun.write(oldPath, "SOURCE");
			await Bun.write(newPath, "TARGET");

			const realRename = fsp.rename;
			vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
				// Fail only the source→destination move; displacement and
				// restoration of the destination still go through.
				if (from === oldPath) {
					throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
				}
				return realRename(from, to);
			});

			const renameOp: RenameFile = {
				kind: "rename",
				oldUri: fileToUri(oldPath),
				newUri: fileToUri(newPath),
				options: { overwrite: true },
			};
			const executed: ExecutedWorkspaceChange[] = [];
			await expect(
				applyWorkspaceEdit({ documentChanges: [renameOp] }, tempDir.path(), change => executed.push(change)),
			).rejects.toThrow("EXDEV");

			// Workspace unchanged: source intact, destination restored, no
			// displaced temp litter, and no executed op reported.
			expect(fs.readFileSync(oldPath, "utf8")).toBe("SOURCE");
			expect(fs.readFileSync(newPath, "utf8")).toBe("TARGET");
			expect(fs.readdirSync(tempDir.path()).sort()).toEqual(["new.ts", "old.ts"]);
			expect(executed).toEqual([]);
		} finally {
			vi.restoreAllMocks();
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
				options: { recursive: true },
			};
			const workspaceEdit: WorkspaceEdit = {
				documentChanges: [childEdit, folderDelete],
			};

			const { applied } = await applyWorkspaceEdit(workspaceEdit, tempDir.path());

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
		vi.useFakeTimers();
		try {
			const request = lspClient.sendRequest(client, "test/method", {}, undefined, 25);
			vi.advanceTimersByTime(25);
			await expect(request).rejects.toThrow(/after 25ms/);
		} finally {
			vi.useRealTimers();
		}
	});

	it("sendRequest uses the signal as the deadline when no explicit timeout is set", async () => {
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
		const controller = new AbortController();
		const reason = new Error("caller deadline");
		const request = lspClient.sendRequest(client, "test/method", {}, controller.signal);
		controller.abort(reason);

		// The exact caller reason proves the signal owned the deadline rather than
		// the per-request 30s fallback.
		await expect(request).rejects.toBe(reason);
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

			const tool = new LspTool(makeLspSession(tempDir.path()));
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

	it("rename_file reports an unreadable source as a read failure, not a missing path", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rename-source-eacces-");
		try {
			const sourceFile = path.join(tempDir.path(), "locked.ts");
			const destFile = path.join(tempDir.path(), "renamed.ts");
			await Bun.write(sourceFile, "export const a = 1;\n");

			// EACCES is not ENOENT: the file is there, we just can't read it.
			const realStat = fs.promises.stat;
			vi.spyOn(fs.promises, "stat").mockImplementation((async (target: fs.PathLike) => {
				if (target === sourceFile) {
					throw Object.assign(new Error(`permission denied: ${sourceFile}\tsecret`), {
						code: "EACCES",
						path: sourceFile,
						syscall: "stat",
					});
				}
				return await realStat(target);
			}) as typeof fs.promises.stat);

			const tool = new LspTool(makeLspSession(tempDir.path()));
			const result = await tool.execute("rename-source-eacces", {
				action: "rename_file",
				file: sourceFile,
				new_name: destFile,
				timeout: 5,
			});

			const output = textResult(result);
			expect(output).toContain("cannot read source path locked.ts: EACCES during stat");
			expect(output).not.toContain(tempDir.path());
			expect(output).not.toContain("\t");
			expect(output).not.toContain("does not exist");
			expect(result.details).toMatchObject({ action: "rename_file", success: false });
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("rename_file refuses to rename when the destination cannot be inspected", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rename-dest-eacces-");
		try {
			const sourceFile = path.join(tempDir.path(), "old.ts");
			const destFile = path.join(tempDir.path(), "new.ts");
			await Bun.write(sourceFile, "export const a = 1;\n");

			// A failed destination probe never established that the path is free,
			// so treating it as absent would rename onto a file we cannot see.
			const realLstat = fs.promises.lstat;
			vi.spyOn(fs.promises, "lstat").mockImplementation((async (target: fs.PathLike) => {
				if (target === destFile) {
					throw Object.assign(new Error(`permission denied: ${destFile}\tsecret`), {
						code: "EACCES",
						path: destFile,
						syscall: "lstat",
					});
				}
				return await realLstat(target);
			}) as typeof fs.promises.lstat);

			const tool = new LspTool(makeLspSession(tempDir.path()));
			const result = await tool.execute("rename-dest-eacces", {
				action: "rename_file",
				file: sourceFile,
				new_name: destFile,
				timeout: 5,
			});

			const output = textResult(result);
			expect(output).toContain("cannot read destination path new.ts: EACCES during lstat");
			expect(output).not.toContain(tempDir.path());
			expect(output).not.toContain("\t");
			expect(result.details).toMatchObject({ action: "rename_file", success: false });
			expect(fs.existsSync(sourceFile)).toBe(true);
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("rename_file treats a dangling destination symlink as an existing path", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rename-dangling-dest-");
		try {
			const sourceFile = path.join(tempDir.path(), "old.ts");
			const destFile = path.join(tempDir.path(), "dangling.ts");
			await Bun.write(sourceFile, "export const a = 1;\n");
			const sourceStat = await fs.promises.stat(sourceFile);
			const realLstat = fs.promises.lstat;
			const lstatSpy = vi.spyOn(fs.promises, "lstat").mockImplementation((async (target: fs.PathLike) => {
				if (target === destFile) return sourceStat;
				return await realLstat(target);
			}) as typeof fs.promises.lstat);

			const result = await new LspTool(makeLspSession(tempDir.path())).execute("rename-dangling-dest", {
				action: "rename_file",
				file: sourceFile,
				new_name: destFile,
				timeout: 5,
			});

			expect(textResult(result)).toContain("destination already exists: dangling.ts");
			expect(lstatSpy).toHaveBeenCalledWith(destFile);
			expect(fs.existsSync(sourceFile)).toBe(true);
			expect(fs.existsSync(destFile)).toBe(false);
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("shortens an outside-cwd Windows home path before separator normalization", async () => {
		if (!lspHomeOverride) throw new Error("Expected isolated home");
		const cwd = path.join(lspHomeOverride, "project");
		const sourceFile = path.join(lspHomeOverride, "other", "locked.ts");
		const destFile = path.join(lspHomeOverride, "other", "renamed.ts");
		fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		await Bun.write(sourceFile, "export const a = 1;\n");
		const realStat = fs.promises.stat;
		vi.spyOn(fs.promises, "stat").mockImplementation((async (target: fs.PathLike) => {
			if (target === sourceFile) {
				throw Object.assign(new Error(`permission denied: ${sourceFile}`), {
					code: "EACCES",
					path: sourceFile,
					syscall: "stat",
				});
			}
			return await realStat(target);
		}) as typeof fs.promises.stat);

		const result = await new LspTool(makeLspSession(cwd)).execute("rename-home-eacces", {
			action: "rename_file",
			file: sourceFile,
			new_name: destFile,
			timeout: 5,
		});
		const output = textResult(result);
		expect(output).toContain("cannot read source path ~");
		expect(output).not.toContain(lspHomeOverride);
	});

	it("workspace reload replaces a client whose process or initialization config changed", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-reload-identity-");
		try {
			const oldServer = installHandshakeLsp();
			const oldConfig: ServerConfig = {
				command: "fake-lsp",
				args: ["--mode", "old"],
				fileTypes: [".ts"],
				rootMarkers: [],
				initOptions: { generation: 1 },
				settings: { diagnostics: false },
			};
			const oldClient = await lspClient.getOrCreateClient(oldConfig, tempDir.path(), 1_000);

			const newServer = installHandshakeLsp();
			const newConfig: ServerConfig = {
				...oldConfig,
				args: ["--mode", "new"],
				initOptions: { generation: 2 },
				settings: { diagnostics: true },
			};
			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "fake-lsp": newConfig },
				idleTimeoutMs: undefined,
			});

			const tool = new LspTool(makeLspSession(tempDir.path()));
			const result = await tool.execute("reload-client-identity", { action: "reload", file: "*" });
			const newClient = await lspClient.getActiveOrPendingClient(newConfig, tempDir.path());

			expect(newClient).toBeDefined();
			expect(newClient).not.toBe(oldClient);
			expect(oldServer.received.map(message => message.method)).toContain("shutdown");
			expect(oldServer.received.map(message => message.method)).toContain("exit");
			expect(newServer.received.map(message => message.method)).toContain("initialize");
			expect(newServer.received).toContainEqual(
				expect.objectContaining({
					method: "workspace/didChangeConfiguration",
					params: { settings: { diagnostics: true } },
				}),
			);
			const output = textResult(result);
			expect(output).toContain("Stopped 1 server(s) with superseded configuration: fake-lsp");
			expect(output).toContain("Reloaded fake-lsp");
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("workspace reload blocks fresh client creation until stale teardown finishes", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-reload-fresh-race-");
		try {
			const oldServer = installFakeLsp((message, server) => {
				if (message.method === "initialize") {
					server.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
				} else if (message.method === "exit") {
					server.exit(0);
				}
			});
			const oldConfig: ServerConfig = {
				command: "fake-lsp",
				args: ["--mode", "old"],
				fileTypes: [".ts"],
				rootMarkers: [],
			};
			await lspClient.getOrCreateClient(oldConfig, tempDir.path(), 1_000);

			const newServer = installHandshakeLsp();
			const newConfig: ServerConfig = { ...oldConfig, args: ["--mode", "new"] };
			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "fake-lsp": newConfig },
				idleTimeoutMs: undefined,
			});
			const reload = new LspTool(makeLspSession(tempDir.path())).execute("reload-fresh-race", {
				action: "reload",
				file: "*",
			});
			const shutdown = await oldServer.waitFor(message => message.method === "shutdown");
			const spawnCountBefore = newServer.spawnCount;
			const concurrentFresh = lspClient.getOrCreateClient(newConfig, tempDir.path(), 1_000);
			expect(newServer.spawnCount).toBe(spawnCountBefore);
			expect(newServer.received.some(message => message.method === "initialize")).toBe(false);

			oldServer.send({ jsonrpc: "2.0", id: shutdown.id, result: null });
			const [result, freshClient] = await Promise.all([reload, concurrentFresh]);
			expect(freshClient.config.args).toEqual(["--mode", "new"]);
			expect(newServer.received.map(message => message.method)).toContain("initialize");
			expect(textResult(result)).toContain("Reloaded fake-lsp");
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("workspace reload failure keeps fresh client creation blocked", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-reload-failed-teardown-");
		try {
			const oldServer = installFakeLsp(
				(message, server) => {
					if (message.method === "initialize") {
						server.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
					} else if (message.method === "shutdown") {
						server.send({ jsonrpc: "2.0", id: message.id, result: null });
					}
				},
				{ killResolvesExit: false },
			);
			const oldConfig: ServerConfig = {
				command: "fake-lsp",
				args: ["--mode", "old"],
				fileTypes: [".ts"],
				rootMarkers: [],
			};
			await lspClient.getOrCreateClient(oldConfig, tempDir.path(), 1_000);

			const newServer = installHandshakeLsp();
			const newConfig: ServerConfig = { ...oldConfig, args: ["--mode", "new"] };
			await expect(lspClient.shutdownStaleClients(tempDir.path(), [newConfig])).rejects.toThrow(
				"Failed to stop LSP server(s) with superseded configuration",
			);
			await expect(lspClient.getOrCreateClient(newConfig, tempDir.path(), 1_000)).rejects.toThrow(
				"Failed to stop LSP server(s) with superseded configuration",
			);
			expect(newServer.spawnCount).toBe(0);
			oldServer.exit(0);
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	}, 10_000);

	it("workspace reload waits for a stale pending client before starting its replacement", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-reload-pending-");
		try {
			const oldServer = installFakeLsp((message, server) => {
				if (message.method === "shutdown") {
					server.send({ jsonrpc: "2.0", id: message.id, result: null });
				} else if (message.method === "exit") {
					server.exit(0);
				}
			});
			const oldConfig: ServerConfig = {
				command: "fake-lsp",
				args: ["--mode", "old"],
				fileTypes: [".ts"],
				rootMarkers: [],
			};
			const oldClientPromise = lspClient.getOrCreateClient(oldConfig, tempDir.path(), 1_000);
			const oldOutcome = oldClientPromise.then(
				() => "resolved",
				error => String(error),
			);
			const initialize = await oldServer.waitFor(message => message.method === "initialize");

			const newServer = installHandshakeLsp();
			const newConfig: ServerConfig = { ...oldConfig, args: ["--mode", "new"] };
			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "fake-lsp": newConfig },
				idleTimeoutMs: undefined,
			});
			const tool = new LspTool(makeLspSession(tempDir.path()));
			const reload = tool.execute("reload-pending-client", { action: "reload", file: "*" });
			const concurrentOldOutcome = lspClient.getOrCreateClient(oldConfig, tempDir.path(), 1_000).then(
				() => "resolved",
				error => String(error),
			);
			await Bun.sleep(0);
			expect(newServer.received.some(message => message.method === "initialize")).toBe(false);
			oldServer.send({ jsonrpc: "2.0", id: initialize.id, result: { capabilities: {} } });
			expect(await oldOutcome).toContain("superseded during initialization");
			expect(await concurrentOldOutcome).toContain("superseded during initialization");
			const result = await reload;

			expect(oldServer.killed).toBe(true);
			expect(oldServer.received.filter(message => message.method === "initialize")).toHaveLength(1);
			expect(newServer.received.map(message => message.method)).toContain("initialize");
			expect(textResult(result)).toContain("Reloaded fake-lsp");
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("workspace reload deadline interrupts a stale pending initializer and prevents late publication", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-reload-pending-abort-");
		try {
			const oldServer = installFakeLsp(() => {});
			const oldConfig: ServerConfig = {
				command: "fake-lsp",
				args: ["--mode", "old"],
				fileTypes: [".ts"],
				rootMarkers: [],
			};
			const oldClientPromise = lspClient.getOrCreateClient(oldConfig, tempDir.path());
			const oldOutcome = oldClientPromise.then(
				() => "resolved",
				error => String(error),
			);
			const initialize = await oldServer.waitFor(message => message.method === "initialize");
			const newConfig: ServerConfig = { ...oldConfig, args: ["--mode", "new"] };
			const controller = new AbortController();
			const reason = new Error("reload cancelled");
			const cleanup = lspClient.shutdownStaleClients(tempDir.path(), [newConfig], controller.signal);
			await Bun.sleep(0);
			controller.abort(reason);
			await expect(cleanup).rejects.toBeInstanceOf(ToolAbortError);

			// The original caller did not carry the reload signal. Even after its
			// initialize response arrives, the tombstone prevents stale publish.
			oldServer.send({ jsonrpc: "2.0", id: initialize.id, result: { capabilities: {} } });
			expect(await oldOutcome).toContain("superseded during initialization");
		} finally {
			await lspClient.shutdownAll();
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
			const client = { proc: { kill: vi.fn() }, config: server } as unknown as LspClient;
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
			vi.spyOn(lspClient, "sendNotification").mockResolvedValue(undefined);

			const tool = new LspTool(makeLspSession(tempDir.path()));
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
			expect(lspClient.getOrCreateClient).toHaveBeenCalledWith(server, tempDir.path(), undefined, expect.anything());
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

		const tool = new LspTool(makeLspSession(process.cwd()));
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

			const tool = new LspTool(makeLspSession(cwd));

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

	describe("reload cancellation and truthful teardown (#6369)", () => {
		// A JSON-RPC error response the client maps to isMethodNotFoundError, so a
		// rust-analyzer server whose reloadWorkspace is unsupported falls through
		// to the generic `workspace/didChangeConfiguration` reload.
		const methodNotFound = (id: RpcMessage["id"]): RpcMessage => ({
			jsonrpc: "2.0",
			id,
			error: { code: -32_601, message: "method not found" },
		});

		it("propagates cancellation of the reload request instead of reporting Restarted", async () => {
			const tempDir = TempDir.createSync("@omp-lsp-reload-cancel-req-");
			try {
				const server = installFakeLsp((message, srv) => {
					if (message.method === "initialize") {
						srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
					} else if (message.method === "shutdown") {
						srv.send({ jsonrpc: "2.0", id: message.id, result: null });
					} else if (message.method === "exit") {
						srv.exit(0);
					}
					// rust-analyzer/reloadWorkspace is left pending: only the caller
					// signal decides its fate.
				});
				const config: ServerConfig = { command: "rust-analyzer", fileTypes: [".ts"], rootMarkers: [] };
				vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: { fake: config }, idleTimeoutMs: undefined });

				const tool = new LspTool(makeLspSession(tempDir.path()));
				const controller = new AbortController();
				const pending = tool.execute("reload-cancel-req", { action: "reload", file: "*" }, controller.signal);
				await server.waitFor(m => m.method === "rust-analyzer/reloadWorkspace");
				controller.abort(new ToolAbortError());

				// Pre-fix, the bare `catch` swallowed the abort, fell through to the
				// notification (also aborted), hit the second bare `catch`, killed
				// the process, and returned "Restarted".
				await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
			} finally {
				vi.restoreAllMocks();
				await lspClient.shutdownAll();
				tempDir.removeSync();
			}
		});

		it("propagates cancellation that arrives during the notification fallback", async () => {
			const tempDir = TempDir.createSync("@omp-lsp-reload-cancel-fallback-");
			const controller = new AbortController();
			try {
				installFakeLsp((message, srv) => {
					if (message.method === "initialize") {
						srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
					} else if (message.method === "rust-analyzer/reloadWorkspace") {
						// Fall through to the generic reload, then cancel before it lands.
						srv.send(methodNotFound(message.id));
						controller.abort(new ToolAbortError());
					} else if (message.method === "shutdown") {
						srv.send({ jsonrpc: "2.0", id: message.id, result: null });
					} else if (message.method === "exit") {
						srv.exit(0);
					}
				});
				const config: ServerConfig = { command: "rust-analyzer", fileTypes: [".ts"], rootMarkers: [] };
				vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: { fake: config }, idleTimeoutMs: undefined });

				const tool = new LspTool(makeLspSession(tempDir.path()));
				const pending = tool.execute("reload-cancel-fb", { action: "reload", file: "*" }, controller.signal);

				await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
			} finally {
				vi.restoreAllMocks();
				await lspClient.shutdownAll();
				tempDir.removeSync();
			}
		});

		it("still falls back to the generic reload on method-not-found without killing the server", async () => {
			const tempDir = TempDir.createSync("@omp-lsp-reload-fallback-ok-");
			try {
				const server = installFakeLsp((message, srv) => {
					if (message.method === "initialize") {
						srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
					} else if (message.method === "rust-analyzer/reloadWorkspace") {
						expect(message.params).toBeUndefined();
						srv.send(methodNotFound(message.id));
					} else if (message.method === "shutdown") {
						srv.send({ jsonrpc: "2.0", id: message.id, result: null });
					} else if (message.method === "exit") {
						srv.exit(0);
					}
				});
				const config: ServerConfig = { command: "rust-analyzer", fileTypes: [".ts"], rootMarkers: [] };
				vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: { fake: config }, idleTimeoutMs: undefined });

				const tool = new LspTool(makeLspSession(tempDir.path()));
				const result = await tool.execute("reload-fallback", { action: "reload", file: "*" });

				expect(textResult(result)).toContain("Reloaded fake");
				expect(server.killed).toBe(false);
			} finally {
				vi.restoreAllMocks();
				await lspClient.shutdownAll();
				tempDir.removeSync();
			}
		});

		it("recognizes -32601 by code even when the server's message text is nonstandard", async () => {
			const tempDir = TempDir.createSync("@omp-lsp-reload-fallback-code-");
			try {
				const server = installFakeLsp((message, srv) => {
					if (message.method === "initialize") {
						srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
					} else if (message.method === "rust-analyzer/reloadWorkspace") {
						// None of isMethodNotFoundError's message substrings — only the
						// JSON-RPC code identifies this as method-not-found.
						srv.send({ jsonrpc: "2.0", id: message.id, error: { code: -32_601, message: "Unknown request" } });
					} else if (message.method === "shutdown") {
						srv.send({ jsonrpc: "2.0", id: message.id, result: null });
					} else if (message.method === "exit") {
						srv.exit(0);
					}
				});
				const config: ServerConfig = { command: "rust-analyzer", fileTypes: [".ts"], rootMarkers: [] };
				vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: { fake: config }, idleTimeoutMs: undefined });

				const tool = new LspTool(makeLspSession(tempDir.path()));
				const result = await tool.execute("reload-fallback-code", { action: "reload", file: "*" });

				expect(textResult(result)).toContain("Reloaded fake");
				expect(server.killed).toBe(false);
			} finally {
				vi.restoreAllMocks();
				await lspClient.shutdownAll();
				tempDir.removeSync();
			}
		});

		it("does not send rust-analyzer/reloadWorkspace to a non-rust server that crashes on it (#8571)", async () => {
			const tempDir = TempDir.createSync("@omp-lsp-reload-non-rust-");
			try {
				let sawRustReload = false;
				const server = installFakeLsp((message, srv) => {
					if (message.method === "initialize") {
						srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
					} else if (message.method === "rust-analyzer/reloadWorkspace") {
						// Roslyn crashes the whole process instead of replying -32601
						// (dotnet/roslyn#84890); the gate must never let us send this.
						sawRustReload = true;
						srv.exit(82);
					} else if (message.method === "shutdown") {
						srv.send({ jsonrpc: "2.0", id: message.id, result: null });
					} else if (message.method === "exit") {
						srv.exit(0);
					}
				});
				const settings = { csharp: { analysis: { backgroundScope: "fullSolution" } } };
				const config: ServerConfig = {
					command: "roslyn-language-server",
					fileTypes: [".cs"],
					rootMarkers: [],
					settings,
				};
				vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
					servers: { csharp: config },
					idleTimeoutMs: undefined,
				});

				const tool = new LspTool(makeLspSession(tempDir.path()));
				const result = await tool.execute("reload-non-rust", { action: "reload", file: "*" });

				expect(sawRustReload).toBe(false);
				expect(textResult(result)).toContain("Reloaded csharp");
				const configurationMessages = server.received.filter(
					message => message.method === "workspace/didChangeConfiguration",
				);
				expect(configurationMessages.at(-1)?.params).toEqual({ settings });
				expect(server.killed).toBe(false);
			} finally {
				vi.restoreAllMocks();
				await lspClient.shutdownAll();
				tempDir.removeSync();
			}
		});

		it("shutdownClientInstance removes the client by identity and confirms process exit", async () => {
			const tempDir = TempDir.createSync("@omp-lsp-teardown-confirm-");
			try {
				installFakeLsp((message, srv) => {
					if (message.method === "initialize") {
						srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
					} else if (message.method === "shutdown") {
						srv.send({ jsonrpc: "2.0", id: message.id, result: null });
					} else if (message.method === "exit") {
						srv.exit(0);
					}
				});
				const config: ServerConfig = { command: "fake-teardown-confirm", fileTypes: [".ts"], rootMarkers: [] };
				const client = await lspClient.getOrCreateClient(config, tempDir.path());
				expect(lspClient.getActiveClients().some(s => s.name === config.command)).toBe(true);

				const exited = await lspClient.shutdownClientInstance(client);
				expect(exited).toBe(true);
				expect(lspClient.getActiveClients().some(s => s.name === config.command)).toBe(false);
			} finally {
				vi.restoreAllMocks();
				await lspClient.shutdownAll();
				tempDir.removeSync();
			}
		});

		it("shutdownClientInstance reports a failed teardown when the process outlives the kill", async () => {
			const tempDir = TempDir.createSync("@omp-lsp-teardown-delayed-");
			try {
				const server = installFakeLsp(
					(message, srv) => {
						if (message.method === "initialize") {
							srv.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
						} else if (message.method === "shutdown") {
							srv.send({ jsonrpc: "2.0", id: message.id, result: null });
						}
						// `exit` notification and `kill()` never resolve `proc.exited`.
					},
					{ killResolvesExit: false },
				);
				const config: ServerConfig = { command: "fake-teardown-delayed", fileTypes: [".ts"], rootMarkers: [] };
				const client = await lspClient.getOrCreateClient(config, tempDir.path());

				const exited = await lspClient.shutdownClientInstance(client);
				expect(exited).toBe(false);
				expect(lspClient.getActiveClients().some(s => s.name === config.command)).toBe(true);

				server.exit(0);
				await Bun.sleep(0);
				expect(lspClient.getActiveClients().some(s => s.name === config.command)).toBe(false);
			} finally {
				vi.restoreAllMocks();
				tempDir.removeSync();
			}
		}, 15_000);
	});
	describe("reader exit ordering and initialization backoff (#7041)", () => {
		it("surfaces the process diagnostic when stdout closes before exit publication", async () => {
			installFakeLsp(
				(message, server) => {
					if (message.method === "initialize") server.exit(23);
				},
				{
					stdoutClosesBeforeExit: true,
					stderr: "simulated rust-analyzer crash",
				},
			);
			const tempDir = TempDir.createSync("@omp-lsp-quick-exit-");
			try {
				const config: ServerConfig = {
					command: "fake-lsp-quick-exit",
					fileTypes: [".rs"],
					rootMarkers: [],
				};

				await expect(lspClient.getOrCreateClient(config, tempDir.path())).rejects.toThrow(
					"LSP server exited (code 23): simulated rust-analyzer crash",
				);
			} finally {
				await lspClient.shutdownAll();
				tempDir.removeSync();
			}
		});

		it("kills and evicts a client whose stdout reader fails while the process is alive", async () => {
			const server = installFakeLsp((message, fake) => {
				if (message.method === "initialize") fake.failStdout(new Error("simulated reader failure"));
			});
			const tempDir = TempDir.createSync("@omp-lsp-reader-failure-");
			try {
				const config: ServerConfig = {
					command: "fake-lsp-reader-failure",
					fileTypes: [".ts"],
					rootMarkers: [],
				};

				await expect(lspClient.getOrCreateClient(config, tempDir.path())).rejects.toThrow(
					"LSP connection closed: Error: simulated reader failure",
				);
				expect(server.killed).toBe(true);
				expect(lspClient.getActiveClients().some(client => client.name === config.command)).toBe(false);
			} finally {
				await lspClient.shutdownAll();
				tempDir.removeSync();
			}
		});

		it("keeps ordinary backoff but lets explicit reload retry immediately", async () => {
			installFakeLsp((message, server) => {
				if (message.method === "initialize") server.exit(23);
			});
			const tempDir = TempDir.createSync("@omp-lsp-reload-init-failure-");
			const config: ServerConfig = {
				command: "fake-lsp-reload-init-failure",
				fileTypes: [".ts"],
				rootMarkers: [],
			};
			try {
				await expect(lspClient.getOrCreateClient(config, tempDir.path())).rejects.toBeInstanceOf(Error);
				await expect(lspClient.getOrCreateClient(config, tempDir.path())).rejects.toThrow(
					"failed to initialize recently",
				);

				vi.restoreAllMocks();
				const retryServer = installFakeLsp((message, server) => {
					if (message.method === "initialize") {
						server.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
					} else if (message.method === "rust-analyzer/reloadWorkspace") {
						server.send({ jsonrpc: "2.0", id: message.id, result: null });
					} else if (message.method === "shutdown") {
						server.send({ jsonrpc: "2.0", id: message.id, result: null });
					} else if (message.method === "exit") {
						server.exit(0);
					}
				});
				vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
					servers: { fake: config },
					idleTimeoutMs: undefined,
				});

				const tool = new LspTool(makeLspSession(tempDir.path()));
				const result = await tool.execute("reload-init-failure", { action: "reload", file: "*" });

				expect(textResult(result)).toContain("Reloaded fake");
				expect(retryServer.received.some(message => message.method === "initialize")).toBe(true);
			} finally {
				vi.restoreAllMocks();
				await lspClient.shutdownAll();
				tempDir.removeSync();
			}
		});
	});

	// #3962 — LSP cold-start and notification writes must honor the tool's
	// combined timeout/caller abort signal. Before the fix, a wedged server
	// hung past the tool's advertised deadline: `initialize` fell back to the
	// 30s internal timer because no signal was threaded, and notification
	// writes (`didOpen`/`didChange`/`didSave`) had no timeout at all, so a
	// stuck `sink.flush()` blocked every later op on the client's write queue.
	describe("lsp cold-start and notification writes honor caller signal (#3962)", () => {
		it("aborts a wedged cold-start initialize on the caller signal instead of the 30s internal fallback", async () => {
			// Server accepts spawn but never answers the `initialize` request.
			// Pre-fix, `getOrCreateClient` swallowed the signal and only bailed
			// after the 30s `DEFAULT_REQUEST_TIMEOUT_MS` fallback fired.
			const server = installFakeLsp(() => {});

			const tempDir = TempDir.createSync("@omp-lsp-init-abort-");
			try {
				const controller = new AbortController();
				const reason = new Error("caller deadline");
				const config: ServerConfig = {
					command: "fake-lsp-init-abort",
					fileTypes: ["ts"],
					rootMarkers: [],
				};

				const pending = lspClient.getOrCreateClient(config, tempDir.path(), undefined, controller.signal);
				await server.waitFor(message => message.method === "initialize");
				controller.abort(reason);
				await expect(pending).rejects.toBe(reason);
			} finally {
				await lspClient.shutdownAll();
				tempDir.removeSync();
			}
		});

		it("does not negative-cache caller-aborted initialize attempts", async () => {
			const server = installFakeLsp(() => {});

			const tempDir = TempDir.createSync("@omp-lsp-init-abort-cache-");
			try {
				const controller = new AbortController();
				const config: ServerConfig = {
					command: "fake-lsp-init-abort-cache",
					fileTypes: ["ts"],
					rootMarkers: [],
				};

				const pending = lspClient.getOrCreateClient(config, tempDir.path(), undefined, controller.signal);
				await server.waitFor(message => message.method === "initialize");
				controller.abort();
				await expect(pending).rejects.toBeInstanceOf(Error);

				const probeSignal = AbortSignal.abort(new Error("probe only"));
				await expect(
					lspClient.getOrCreateClient(config, tempDir.path(), undefined, probeSignal),
				).rejects.not.toThrow("failed to initialize recently");
			} finally {
				await lspClient.shutdownAll();
				tempDir.removeSync();
			}
		});

		it("does not tear down when a caller aborts before its queued write reaches flush", async () => {
			const firstFlush = Promise.withResolvers<number>();
			const writes: Array<string | Uint8Array> = [];
			const kill = vi.fn();
			const client: LspClient = {
				name: "fake-lsp-queued-abort:/tmp",
				cwd: "/tmp",
				config: { command: "fake-lsp-queued-abort", fileTypes: ["ts"], rootMarkers: [] },
				proc: {
					exited: new Promise<number>(() => {}),
					exitCode: null,
					stdin: {
						write(chunk: string | Uint8Array) {
							writes.push(chunk);
							return typeof chunk === "string" ? Buffer.byteLength(chunk, "utf-8") : chunk.byteLength;
						},
						flush: () => firstFlush.promise,
					},
					stdout: new ReadableStream<Uint8Array>(),
					peekStderr: () => "",
					kill,
				} as unknown as LspClient["proc"],
				requestId: 0,
				diagnostics: new Map(),
				diagnosticsVersion: 0,
				openFiles: new Map(),
				pendingRequests: new Map(),
				messageBuffer: new Uint8Array(0),
				isReading: false,
				status: "ready",
				lastActivity: Date.now(),
				writeQueue: Promise.resolve(),
				activeProgressTokens: new Set(),
				projectLoaded: Promise.resolve(),
				resolveProjectLoaded: () => {},
			};

			const first = lspClient.sendNotification(client, "workspace/didChangeConfiguration", { settings: {} });
			await Bun.sleep(0);

			const controller = new AbortController();
			const second = lspClient.sendNotification(client, "textDocument/didOpen", {}, controller.signal);
			controller.abort();
			await Bun.sleep(0);

			expect(kill).not.toHaveBeenCalled();
			firstFlush.resolve(0);
			await first;
			await expect(second).rejects.toBeInstanceOf(Error);
			expect(kill).not.toHaveBeenCalled();
			expect(writes).toHaveLength(1);
		});

		it("surfaces an asynchronous stdin write rejection instead of resolving the notification", async () => {
			const epipe = Object.assign(new Error("EPIPE: broken pipe, write"), {
				code: "EPIPE",
				syscall: "write",
			});
			const client: LspClient = {
				name: "fake-lsp-write-epipe:/tmp",
				cwd: "/tmp",
				config: { command: "fake-lsp-write-epipe", fileTypes: ["ts"], rootMarkers: [] },
				proc: {
					exited: Promise.withResolvers<number>().promise,
					exitCode: null,
					stdin: {
						write: () => Promise.reject(epipe),
						flush: () => 0,
					},
					stdout: new ReadableStream<Uint8Array>(),
					peekStderr: () => "",
					kill() {},
				} as unknown as LspClient["proc"],
				requestId: 0,
				diagnostics: new Map(),
				diagnosticsVersion: 0,
				openFiles: new Map(),
				pendingRequests: new Map(),
				messageBuffer: new Uint8Array(0),
				isReading: false,
				status: "ready",
				lastActivity: Date.now(),
				writeQueue: Promise.resolve(),
				activeProgressTokens: new Set(),
				projectLoaded: Promise.resolve(),
				resolveProjectLoaded: () => {},
			};

			await expect(
				lspClient.sendNotification(client, "workspace/didChangeWatchedFiles", {
					changes: [{ uri: "file:///tmp/example.ts", type: 2 }],
				}),
			).rejects.toBe(epipe);
		});

		it("bounds a wedged notification flush on the caller signal and tears down the client", async () => {
			// Custom fake: stdin.flush is gated by a controllable promise so we
			// can simulate a server that stopped draining stdin AFTER init has
			// completed. Pre-fix, `sendNotification` had no signal and the
			// stuck flush wedged the write queue permanently.
			const encoder = new TextEncoder();
			const { promise: exited, resolve: resolveExited } = Promise.withResolvers<number>();
			let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
			let exitCode: number | null = null;
			let killed = false;
			let flushGate: Promise<void> = Promise.resolve();
			let onFlush: (() => void) | undefined;

			const frame = (message: RpcMessage): Uint8Array => {
				const content = JSON.stringify(message);
				return encoder.encode(`Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n${content}`);
			};

			const stdout = new ReadableStream<Uint8Array>({
				start(c) {
					stdoutController = c;
				},
			});

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
						if (message.method === "initialize") {
							stdoutController?.enqueue(frame({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } }));
						}
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
					flush: async () => {
						onFlush?.();
						await flushGate;
						return 0;
					},
					end: async () => 0,
				},
				stdout,
				peekStderr: () => "",
				kill() {
					killed = true;
					if (exitCode === null) {
						exitCode = 0;
						stdoutController?.close();
						resolveExited(0);
					}
				},
			} as unknown as LspClient["proc"];

			vi.spyOn(piUtils.ptree, "spawn").mockReturnValue(proc as unknown as piUtils.ptree.ChildProcess<"pipe">);

			const tempDir = TempDir.createSync("@omp-lsp-flush-wedge-");
			try {
				const config: ServerConfig = {
					command: "fake-lsp-flush-wedge",
					fileTypes: ["ts"],
					rootMarkers: [],
				};

				const client = await lspClient.getOrCreateClient(config, tempDir.path());
				expect(lspClient.getActiveClients().some(s => s.name === config.command)).toBe(true);

				// Wedge every subsequent flush: sink.flush() now awaits a promise
				// that never settles, mirroring a server that stopped draining stdin.
				const flushStarted = Promise.withResolvers<void>();
				onFlush = flushStarted.resolve;
				flushGate = new Promise<void>(() => {});

				const controller = new AbortController();
				const notification = lspClient.sendNotification(
					client,
					"textDocument/didOpen",
					{
						textDocument: {
							uri: "file:///tmp/x.ts",
							languageId: "typescript",
							version: 1,
							text: "",
						},
					},
					controller.signal,
				);
				await flushStarted.promise;
				controller.abort();
				await expect(notification).rejects.toBeInstanceOf(Error);

				// Teardown contract: an aborted write kills the client so the
				// next `getOrCreateClient` spawns a fresh server instead of
				// queueing behind the wedged flush forever.
				expect(killed).toBe(true);
				expect(lspClient.getActiveClients().some(s => s.name === config.command)).toBe(false);
			} finally {
				await lspClient.shutdownAll();
				tempDir.removeSync();
			}
		});
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

describe("ty python lsp", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("registers ty for .py behind existing Python primaries and before ruff", () => {
		const config = { servers: DEFAULTS as unknown as Record<string, ServerConfig> };
		const names = getServersForFile(config, "app.py").map(([name]) => name);
		expect(names).toContain("ty");
		expect(names).toContain("ruff");
		// ty is behind all existing Python primaries
		expect(names.indexOf("pyright")).toBeLessThan(names.indexOf("ty"));
		expect(names.indexOf("basedpyright")).toBeLessThan(names.indexOf("ty"));
		expect(names.indexOf("pylsp")).toBeLessThan(names.indexOf("ty"));
		// ruff (linter) sorts after all primaries including ty
		expect(names.indexOf("ty")).toBeLessThan(names.indexOf("ruff"));
	});

	it("registers ty for .pyi stub files", () => {
		const config = { servers: DEFAULTS as unknown as Record<string, ServerConfig> };
		const names = getServersForFile(config, "app.pyi").map(([name]) => name);
		expect(names).toContain("ty");
	});

	it("auto-detects ty when its binary and Python root markers are present", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-ty-detect-");
		const resolvedTy = path.join(tempDir.path(), "bin", "ty");
		const whichSpy = vi
			.spyOn(piUtils, "$which")
			.mockImplementation(command => (command === "ty" ? resolvedTy : null));
		try {
			await Bun.write(path.join(tempDir.path(), "pyproject.toml"), '[project]\nname = "demo"\n');
			const config = loadConfig(tempDir.path());
			expect(config.servers.ty?.resolvedCommand).toBe(resolvedTy);
			expect(config.servers.ty?.command).toBe("ty");
			expect(config.servers.ty?.args).toEqual(["server"]);
			expect(whichSpy).toHaveBeenCalledWith("ty");
		} finally {
			tempDir.removeSync();
		}
	});

	it("coexists with ruff: ty is primary, ruff is linter, both auto-detected", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-ty-ruff-");
		const resolvedTy = path.join(tempDir.path(), "bin", "ty");
		const resolvedRuff = path.join(tempDir.path(), "bin", "ruff");
		vi.spyOn(piUtils, "$which").mockImplementation(command =>
			command === "ty" ? resolvedTy : command === "ruff" ? resolvedRuff : null,
		);
		try {
			await Bun.write(path.join(tempDir.path(), "pyproject.toml"), '[project]\nname = "demo"\n');
			const config = loadConfig(tempDir.path());
			expect(config.servers.ty?.resolvedCommand).toBe(resolvedTy);
			expect(config.servers.ruff?.resolvedCommand).toBe(resolvedRuff);
			expect(config.servers.ruff?.isLinter).toBe(true);
			expect(config.servers.ty?.isLinter).toBeFalsy();
			const names = getServersForFile(config, path.join(tempDir.path(), "app.py")).map(([name]) => name);
			expect(names.indexOf("ty")).toBeLessThan(names.indexOf("ruff"));
		} finally {
			tempDir.removeSync();
		}
	});

	it("auto-detects ty in a ty.toml-only project, resolving via project-local venv bin", async () => {
		// Astral documents ty.toml as a first-class project config file; a project
		// that opts into ty with only that file (no pyproject/setup/requirements)
		// must still pass the root-marker gate AND resolve the local venv binary.
		const tempDir = TempDir.createSync("@omp-lsp-ty-toml-");
		const venvBin = process.platform === "win32" ? ".venv/Scripts" : ".venv/bin";
		const resolvedTy = path.join(tempDir.path(), venvBin, "ty");
		// $which never succeeds: only LOCAL_BIN_PATHS resolution can find ty.
		vi.spyOn(piUtils, "$which").mockImplementation(() => null);
		try {
			await Bun.write(path.join(tempDir.path(), "ty.toml"), "[configuration]\n");
			await Bun.write(resolvedTy, '#!/bin/sh\nexec ty "$@"\n');
			const config = loadConfig(tempDir.path());
			expect(config.servers.ty?.resolvedCommand).toBe(resolvedTy);
			expect(config.servers.ty?.command).toBe("ty");
			expect(config.servers.ty?.args).toEqual(["server"]);
		} finally {
			tempDir.removeSync();
		}
	});
});
