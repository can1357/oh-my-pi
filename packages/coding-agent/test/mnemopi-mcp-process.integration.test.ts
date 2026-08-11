import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { callTool, connectToServer, disconnectServer, listTools } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/client";
import type { MCPTransport } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";
import {
	MCP_CLIENT_INFO,
	MCP_MODERN_PROTOCOL_VERSION,
	type MCPRequestOptions,
	type MCPServerConnection,
	type MCPStdioServerConfig,
} from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";

import mnemopiPkg from "../../mnemopi/package.json" with { type: "json" };

const repoRoot = resolve(import.meta.dir, "../../..");
const mnemopiDir = join(repoRoot, "packages", "mnemopi");
const mnemopiCli = join(mnemopiDir, "src", "cli.ts");
const serverInfo = { name: "mnemopi", version: mnemopiPkg.version };
const staticDefinitionsTtlMs = 86_400_000;
interface MnemopiSpawnability {
	available: boolean;
	reason?: string;
	runtime?: string;
}

let mnemopiRuntime: string | undefined;

function requireMnemopiRuntime(): string {
	if (!mnemopiRuntime) throw new Error("No runnable Bun executable is available for the Mnemopi child process");
	return mnemopiRuntime;
}

function getBunRuntimeCandidates(): string[] {
	const bunCommand = Bun.which("bun");
	const npmBunExecutable =
		process.platform === "win32" && bunCommand && extname(bunCommand).toLowerCase() === ".cmd"
			? join(dirname(bunCommand), "node_modules", "bun", "bin", "bun.exe")
			: undefined;
	return [npmBunExecutable, bunCommand, process.execPath].filter(
		(candidate, index, candidates): candidate is string =>
			typeof candidate === "string" && existsSync(candidate) && candidates.indexOf(candidate) === index,
	);
}

async function inspectMnemopiSpawnability(): Promise<MnemopiSpawnability> {
	const failures: string[] = [];

	for (const candidate of getBunRuntimeCandidates()) {
		try {
			const probe = Bun.spawn([candidate, "--version"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [version, exitCode] = await Promise.all([new Response(probe.stdout).text(), probe.exited]);
			if (exitCode !== 0 || !/^\d+\.\d+\.\d+\s*$/.test(version)) {
				throw new Error(`expected Bun --version to succeed, got exit ${exitCode}: ${version.trim()}`);
			}
			return { available: true, runtime: candidate };
		} catch (error) {
			failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return {
		available: false,
		reason:
			failures.length > 0
				? failures.join("; ")
				: "No runnable Bun executable is available for the Mnemopi child process",
	};
}

// Resolve the actual Bun executable rather than the npm-generated bun.cmd wrapper:
// StdioTransport resolves .cmd commands through cmd.exe, while its child must own
// the JSONL pipes directly.
const mnemopiSpawnability = await inspectMnemopiSpawnability();
mnemopiRuntime = mnemopiSpawnability.runtime;
const mnemopiProcessSuite = mnemopiSpawnability.available
	? "Mnemopi MCP cross-product process gate"
	: `Mnemopi MCP cross-product process gate (unavailable child runtime: ${mnemopiSpawnability.reason})`;

let temporaryPaths: string[] = [];

afterEach(() => {
	Bun.gc(true);
	for (const temporaryPath of temporaryPaths) {
		rmSync(temporaryPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
	temporaryPaths = [];
});

function createServerConfig(): MCPStdioServerConfig {
	const dataDir = mkdtempSync(join(tmpdir(), "mnemopi-mcp-process-"));
	temporaryPaths.push(dataDir);
	return {
		type: "stdio",
		command: requireMnemopiRuntime(),
		args: [mnemopiCli, "mcp"],
		cwd: mnemopiDir,
		env: {
			MNEMOPI_DATA_DIR: dataDir,
			MNEMOPI_NO_EMBEDDINGS: "1",
		},
		timeout: 10_000,
	};
}

type ObservedRequest = {
	method: string;
	params: Record<string, unknown> | undefined;
};

type JsonRpcResponse = {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
};

interface JsonlReadStreamReader {
	read(): Promise<{ done: boolean; value: Uint8Array }>;
}

interface JsonlReadStream {
	getReader(): JsonlReadStreamReader;
}

interface JsonlProcess {
	readonly stdin: { write(chunk: string): unknown; flush(): unknown } | null;
	readonly stdout: JsonlReadStream;
	readonly stderr: JsonlReadStream | null;
	readonly exitCode: number | null;
	readonly exited: Promise<number>;
	kill(): void;
}

class JsonlReader {
	readonly #reader: JsonlReadStreamReader;
	readonly #decoder = new TextDecoder();
	#buffer = "";

	constructor(stream: JsonlReadStream) {
		this.#reader = stream.getReader();
	}

	async next(): Promise<JsonRpcResponse> {
		while (true) {
			const newline = this.#buffer.indexOf("\n");
			if (newline >= 0) {
				const line = this.#buffer.slice(0, newline).trim();
				this.#buffer = this.#buffer.slice(newline + 1);
				if (line.length > 0) return JSON.parse(line) as JsonRpcResponse;
				continue;
			}
			const chunk = await this.#reader.read();
			if (chunk.done) {
				throw new Error(`Mnemopi stdio closed before a JSONL response: ${this.#buffer}`);
			}
			this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
		}
	}
}

function spawnRawServer(): JsonlProcess {
	const dataDir = mkdtempSync(join(tmpdir(), "mnemopi-mcp-legacy-process-"));
	temporaryPaths.push(dataDir);
	const env: Record<string, string | undefined> = {
		...process.env,
		MNEMOPI_DATA_DIR: dataDir,
		MNEMOPI_NO_EMBEDDINGS: "1",
	};
	delete env.MNEMOPI_MCP_BANK;
	return Bun.spawn([requireMnemopiRuntime(), mnemopiCli, "mcp"], {
		cwd: mnemopiDir,
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	}) as unknown as JsonlProcess;
}

async function sendJsonl(child: JsonlProcess, request: Record<string, unknown>): Promise<void> {
	if (!child.stdin) throw new Error("Mnemopi child has no stdin");
	await child.stdin.write(`${JSON.stringify(request)}\n`);
	await child.stdin.flush();
}

async function readJsonlStream(stream: JsonlReadStream): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let result = "";
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) return result;
		result += decoder.decode(chunk.value, { stream: true });
	}
}

async function stopRawServer(child: JsonlProcess): Promise<{ exitCode: number; stderr: string }> {
	const stderr = child.stderr ? readJsonlStream(child.stderr) : Promise.resolve("");
	if (child.exitCode === null) child.kill();
	return { exitCode: await child.exited, stderr: await stderr };
}

// Test-only direct-pipe transport. It uses the same MCP client API and child
// argv/cwd as the stdio config, but bypasses Windows cmd.exe handling so the
// actual Bun executable owns the JSONL pipes.
class DirectJsonlTransport implements MCPTransport {
	readonly #child: JsonlProcess;
	readonly #reader: JsonlReader;
	#connected = true;
	#nextRequestId = 0;

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;

	constructor(config: MCPStdioServerConfig) {
		const env: Record<string, string | undefined> = { ...process.env, ...config.env };
		delete env.MNEMOPI_MCP_BANK;
		this.#child = Bun.spawn([config.command, ...(config.args ?? [])], {
			cwd: config.cwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		}) as unknown as JsonlProcess;
		this.#reader = new JsonlReader(this.#child.stdout);
	}

	get connected(): boolean {
		return this.#connected;
	}

	async request<T>(method: string, params?: Record<string, unknown>, _options?: MCPRequestOptions): Promise<T> {
		if (!this.#connected) throw new Error("Transport not connected");
		const id = ++this.#nextRequestId;
		await sendJsonl(this.#child, { jsonrpc: "2.0", id, method, params });
		const response = await this.#reader.next();
		if (response.id !== id) throw new Error(`Unexpected Mnemopi JSONL response ID: ${String(response.id)}`);
		if (response.error) throw new Error(`MCP error ${response.error.code}: ${response.error.message}`);
		return response.result as T;
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected) throw new Error("Transport not connected");
		await sendJsonl(this.#child, { jsonrpc: "2.0", method, params });
	}

	async close(): Promise<void> {
		if (!this.#connected) return;
		this.#connected = false;
		await stopRawServer(this.#child);
		this.onClose?.();
	}
}

describe.skipIf(!mnemopiSpawnability.available)(mnemopiProcessSuite, () => {
	it("drives modern discovery, list, and call through the coding-agent JSONL client", async () => {
		const observed: ObservedRequest[] = [];
		let connection: MCPServerConnection | undefined;
		try {
			connection = await connectToServer("mnemopi-process", createServerConfig(), {
				transportFactory: async config => {
					const transport = new DirectJsonlTransport(config as MCPStdioServerConfig);
					const request = transport.request.bind(transport);
					const notify = transport.notify.bind(transport);
					transport.request = async <T>(
						method: string,
						params?: Record<string, unknown>,
						options?: MCPRequestOptions,
					) => {
						observed.push({ method, params });
						return request<T>(method, params, options);
					};
					transport.notify = async (method: string, params?: Record<string, unknown>) => {
						observed.push({ method, params });
						return notify(method, params);
					};
					return transport;
				},
			});

			expect(connection.protocol).toEqual({
				era: "modern",
				version: MCP_MODERN_PROTOCOL_VERSION,
				supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
				clientCapabilities: {},
				capabilities: { tools: { listChanged: false } },
				serverInfo,
			});
			expect(connection.resultHints?.discovery).toMatchObject({
				era: "modern",
				operation: "server/discover",
				ttlMs: staticDefinitionsTtlMs,
				cacheScope: "public",
				scopeConsistent: true,
				pages: [
					{
						resultType: "complete",
						ttlMs: staticDefinitionsTtlMs,
						cacheScope: "public",
						_meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
					},
				],
			});

			const tools = await listTools(connection);
			expect(tools.some(tool => tool.name === "mnemopi_stats")).toBe(true);
			expect(connection.resultHints?.tools).toMatchObject({
				era: "modern",
				operation: "tools/list",
				ttlMs: staticDefinitionsTtlMs,
				cacheScope: "public",
				scopeConsistent: true,
				pages: [
					{
						resultType: "complete",
						ttlMs: staticDefinitionsTtlMs,
						cacheScope: "public",
						_meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
					},
				],
			});

			const result = await callTool(connection, "mnemopi_stats", { bank: "process-modern" });
			expect(result).toMatchObject({
				resultType: "complete",
				_meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
			});
			expect(result.isError).toBeUndefined();
			const text = result.content.find(content => content.type === "text");
			expect(text?.type).toBe("text");
			expect(JSON.parse(text?.type === "text" ? text.text : "{}")).toMatchObject({
				status: "ok",
				bank: "process-modern",
			});

			expect(observed.map(request => request.method)).toEqual(["server/discover", "tools/list", "tools/call"]);
			for (const request of observed) {
				expect(request.params?._meta).toEqual({
					"io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
					"io.modelcontextprotocol/clientCapabilities": {},
					"io.modelcontextprotocol/clientInfo": MCP_CLIENT_INFO,
				});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Mnemopi modern JSONL process failure after ${JSON.stringify(observed)}: ${message}`);
		} finally {
			if (connection) {
				await disconnectServer(connection);
				expect(connection.transport.connected).toBe(false);
			}
		}
	});

	it("keeps the legacy JSONL initialize lifecycle isolated from modern metadata", async () => {
		const child = spawnRawServer();
		const reader = new JsonlReader(child.stdout);
		const sentMethods: string[] = [];
		let failure: unknown;
		try {
			const initialize = {
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: { roots: { listChanged: false } },
					clientInfo: MCP_CLIENT_INFO,
				},
			};
			sentMethods.push(initialize.method);
			await sendJsonl(child, initialize);
			const initialized = await reader.next();
			expect(initialized).toEqual({
				jsonrpc: "2.0",
				id: 1,
				result: {
					protocolVersion: "2024-11-05",
					serverInfo,
					capabilities: { tools: {} },
				},
			});

			const notification = { jsonrpc: "2.0", method: "notifications/initialized", params: {} };
			sentMethods.push(notification.method);
			await sendJsonl(child, notification);

			const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
			sentMethods.push(list.method);
			await sendJsonl(child, list);
			const listed = await reader.next();
			expect(listed.id).toBe(2);
			expect(listed.error).toBeUndefined();
			expect(listed.result?.resultType).toBeUndefined();
			expect(listed.result?._meta).toBeUndefined();
			const listedTools = listed.result?.tools;
			expect(Array.isArray(listedTools)).toBe(true);
			expect((listedTools as Array<{ name: string }>).some(tool => tool.name === "mnemopi_stats")).toBe(true);

			const call = {
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "mnemopi_stats", arguments: { bank: "process-legacy" } },
			};
			sentMethods.push(call.method);
			await sendJsonl(child, call);
			const called = await reader.next();
			expect(called.id).toBe(3);
			expect(called.error).toBeUndefined();
			expect(called.result?.resultType).toBeUndefined();
			expect(called.result?._meta).toBeUndefined();
			const content = called.result?.content as Array<{ type: string; text: string }>;
			expect(JSON.parse(content[0]?.text ?? "{}")).toMatchObject({ status: "ok", bank: "process-legacy" });
			expect(sentMethods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
		} catch (error) {
			failure = error;
		}
		const stopped = await stopRawServer(child);
		expect(stopped.exitCode).toBeGreaterThanOrEqual(0);
		if (failure) {
			const message = failure instanceof Error ? failure.message : String(failure);
			throw new Error(`Mnemopi legacy JSONL process failure: ${message}\nserver stderr:\n${stopped.stderr}`);
		}
	});
});
