import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	callToolJson,
	handleJsonRpc,
	LEGACY_PROTOCOL_VERSION,
	MODERN_PROTOCOL_VERSION,
	runStdio,
	SERVER_INFO,
	STATIC_DEFINITIONS_TTL_MS,
} from "@pk-nerdsaver-ai/pi-mnemopi/mcp-server";
import { getToolDefinitions, handleToolCall, TOOLS } from "@pk-nerdsaver-ai/pi-mnemopi/mcp-tools";

let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "mnemopi-mcp-server-"));
	process.env.MNEMOPI_DATA_DIR = dataDir;
	process.env.MNEMOPI_NO_EMBEDDINGS = "1";
	delete process.env.MNEMOPI_MCP_BANK;
});

afterEach(() => {
	Bun.gc(true);
	rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	delete process.env.MNEMOPI_DATA_DIR;
	delete process.env.MNEMOPI_NO_EMBEDDINGS;
	delete process.env.MNEMOPI_MCP_BANK;
});

function streamFromText(text: string): ReadableStream<Uint8Array> {
	const encoded = new TextEncoder().encode(text);
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoded);
			controller.close();
		},
	});
}

async function runStdioRaw(input: string): Promise<string> {
	let output = "";
	await runStdio(streamFromText(input), {
		write(chunk: string) {
			output += chunk;
		},
	});
	return output;
}

async function runStdioText(input: string): Promise<unknown[]> {
	const trimmed = (await runStdioRaw(input)).trim();
	return trimmed.length === 0 ? [] : trimmed.split("\n").map(line => JSON.parse(line) as unknown);
}

function modernParams(params: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		...params,
		_meta: {
			"io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
			"io.modelcontextprotocol/clientCapabilities": {},
			"io.modelcontextprotocol/clientInfo": { name: "mnemopi-test", version: "1.0.0" },
		},
	};
}

describe("MCP tool definitions", () => {
	it("exposes the full realistic tool surface", () => {
		const names = TOOLS.map(tool => tool.name);
		expect(names).toHaveLength(23);
		expect(names).toEqual([
			"mnemopi_remember",
			"mnemopi_recall",
			"mnemopi_shared_remember",
			"mnemopi_shared_recall",
			"mnemopi_shared_forget",
			"mnemopi_shared_stats",
			"mnemopi_sleep",
			"mnemopi_stats",
			"mnemopi_invalidate",
			"mnemopi_validate",
			"mnemopi_get",
			"mnemopi_triple_add",
			"mnemopi_triple_query",
			"mnemopi_scratchpad_write",
			"mnemopi_scratchpad_read",
			"mnemopi_scratchpad_clear",
			"mnemopi_export",
			"mnemopi_update",
			"mnemopi_forget",
			"mnemopi_import",
			"mnemopi_diagnose",
			"mnemopi_graph_query",
			"mnemopi_graph_link",
		]);
	});

	it("returns JSON-serializable MCP schemas", () => {
		const tools = getToolDefinitions();
		expect(tools).toHaveLength(23);
		for (const tool of tools) {
			const schema = JSON.parse(JSON.stringify(tool.inputSchema)) as {
				type: string;
				properties: unknown;
			};
			expect(schema.type).toBe("object");
			expect(schema.properties).toBeDefined();
		}
	});
});

describe("MCP JSON handlers", () => {
	it("sources SERVER_INFO from package manifest", async () => {
		const pkg = (await import("../package.json", { with: { type: "json" } })).default;
		expect(SERVER_INFO).toEqual({
			name: "mnemopi",
			version: pkg.version,
		});
	});

	it("preserves legacy tools/list behavior without modern metadata", async () => {
		const response = await handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		if (response === null) throw new Error("expected tools/list response");
		expect(response.error).toBeUndefined();
		const result = response.result as { tools: unknown[]; resultType?: unknown; _meta?: unknown };
		expect(result.tools).toHaveLength(23);
		expect(result.resultType).toBeUndefined();
		expect(result._meta).toBeUndefined();
	});

	it("keeps legacy requests with progress metadata on the legacy path", async () => {
		const response = await handleJsonRpc({
			jsonrpc: "2.0",
			id: "legacy-progress",
			method: "tools/list",
			params: { _meta: { progressToken: "legacy-token" } },
		});
		if (response === null || response.error !== undefined) throw new Error("expected legacy tools/list result");
		const result = response.result as { tools: unknown[]; resultType?: unknown };
		expect(result.tools).toHaveLength(23);
		expect(result.resultType).toBeUndefined();
	});

	it("discovers only the implemented modern tools capability with public cache metadata", async () => {
		const response = await handleJsonRpc({
			jsonrpc: "2.0",
			id: "discover",
			method: "server/discover",
			params: modernParams(),
		});
		expect(response).toEqual({
			jsonrpc: "2.0",
			id: "discover",
			result: {
				resultType: "complete",
				supportedVersions: [MODERN_PROTOCOL_VERSION],
				capabilities: { tools: { listChanged: false } },
				_meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
				ttlMs: STATIC_DEFINITIONS_TTL_MS,
				cacheScope: "public",
			},
		});
	});

	it("selects modern handling only from the reserved protocol-version metadata", async () => {
		const bareDiscover = await handleJsonRpc({
			jsonrpc: "2.0",
			id: 2,
			method: "server/discover",
		});
		expect(bareDiscover?.error).toEqual({
			code: -32601,
			message: "Unknown method: server/discover",
		});

		const missingCapabilities = await handleJsonRpc({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/list",
			params: {
				_meta: { "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION },
			},
		});
		expect(missingCapabilities?.error?.code).toBe(-32602);

		const unsupported = await handleJsonRpc({
			jsonrpc: "2.0",
			id: 4,
			method: "tools/list",
			params: {
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2099-01-01",
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		});
		expect(unsupported?.error).toEqual({
			code: -32022,
			message: "Unsupported protocol version",
			data: {
				supported: [MODERN_PROTOCOL_VERSION],
				requested: "2099-01-01",
			},
		});
	});

	it("rejects schema-invalid modern tools/list cursors", async () => {
		for (const cursor of [null, 1, true, {}, []]) {
			const response = await handleJsonRpc({
				jsonrpc: "2.0",
				id: `cursor-${String(cursor)}`,
				method: "tools/list",
				params: modernParams({ cursor }),
			});
			expect(response?.error).toEqual({
				code: -32602,
				message: "tools/list params.cursor must be a string",
			});
		}
	});

	it("lists modern tools deterministically without mutating shared definitions", async () => {
		const originalOrder = getToolDefinitions().map(tool => tool.name);
		const response = await handleJsonRpc({
			jsonrpc: "2.0",
			id: 5,
			method: "tools/list",
			params: modernParams(),
		});
		if (response === null || response.error !== undefined) throw new Error("expected modern tools/list result");
		const result = response.result as {
			resultType: string;
			tools: Array<{ name: string }>;
			ttlMs: number;
			cacheScope: string;
			_meta: unknown;
		};
		const listedNames = result.tools.map(tool => tool.name);
		expect(listedNames).toEqual([...originalOrder].sort());
		expect(getToolDefinitions().map(tool => tool.name)).toEqual(originalOrder);
		expect(result.resultType).toBe("complete");
		expect(result.ttlMs).toBe(STATIC_DEFINITIONS_TTL_MS);
		expect(result.cacheScope).toBe("public");
		expect(result._meta).toEqual({ "io.modelcontextprotocol/serverInfo": SERVER_INFO });
	});

	it("wraps modern tool calls in complete results with server identity", async () => {
		const response = await handleJsonRpc({
			jsonrpc: "2.0",
			id: 6,
			method: "tools/call",
			params: modernParams({ name: "mnemopi_stats", arguments: { bank: "modern" } }),
		});
		if (response === null || response.error !== undefined) throw new Error("expected modern tools/call result");
		const result = response.result as {
			resultType: string;
			content: Array<{ type: string; text: string }>;
			_meta: unknown;
			ttlMs?: unknown;
		};
		expect(result.resultType).toBe("complete");
		expect(result._meta).toEqual({ "io.modelcontextprotocol/serverInfo": SERVER_INFO });
		expect(result.ttlMs).toBeUndefined();
		const payload = JSON.parse(result.content[0]?.text ?? "{}") as { status: string; bank: string };
		expect(payload).toMatchObject({ status: "ok", bank: "modern" });
	});

	it("rejects malformed tool arguments and unknown modern tool names", async () => {
		const modernMalformed = await handleJsonRpc({
			jsonrpc: "2.0",
			id: "modern-malformed-arguments",
			method: "tools/call",
			params: modernParams({ name: "mnemopi_stats", arguments: [] }),
		});
		expect(modernMalformed?.error).toEqual({
			code: -32602,
			message: "tools/call params.arguments must be an object",
		});

		const legacyMalformed = await handleJsonRpc({
			jsonrpc: "2.0",
			id: "legacy-malformed-arguments",
			method: "tools/call",
			params: { name: "mnemopi_stats", arguments: null },
		});
		expect(legacyMalformed?.error).toEqual({
			code: -32602,
			message: "tools/call params.arguments must be an object",
		});

		const unknownModernTool = await handleJsonRpc({
			jsonrpc: "2.0",
			id: "modern-unknown-tool",
			method: "tools/call",
			params: modernParams({ name: "mnemopi_not_advertised", arguments: {} }),
		});
		expect(unknownModernTool?.error).toEqual({
			code: -32602,
			message: "Unknown tool: mnemopi_not_advertised",
		});
	});

	it("rejects invalid JSON-RPC envelopes before protocol-era dispatch", async () => {
		const invalidEnvelopes: unknown[] = [
			null,
			[],
			{ jsonrpc: "1.0", id: 1, method: "tools/list" },
			{ jsonrpc: "2.0", id: 1 },
			{ jsonrpc: "2.0", id: 1, method: 42 },
			{ jsonrpc: "2.0", id: null, method: "tools/list" },
			{ jsonrpc: "2.0", id: 1.5, method: "tools/list" },
		];
		for (const envelope of invalidEnvelopes) {
			expect(await handleJsonRpc(envelope)).toEqual({
				jsonrpc: "2.0",
				id: null,
				error: { code: -32600, message: "Invalid Request" },
			});
		}
	});

	it("returns invalid-request errors for decoded invalid envelopes and continues serving", async () => {
		const responses = await runStdioText(
			`${JSON.stringify({ jsonrpc: "2.0", id: null, method: "tools/list" })}\n42\n${JSON.stringify({
				jsonrpc: "2.0",
				method: "notifications/initialized",
			})}\n${JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list" })}\n`,
		);
		expect(responses).toHaveLength(3);
		for (const invalidResponse of responses.slice(0, 2)) {
			expect(invalidResponse).toEqual({
				jsonrpc: "2.0",
				id: null,
				error: { code: -32600, message: "Invalid Request" },
			});
		}
		expect(responses[2]).toMatchObject({ jsonrpc: "2.0", id: 10 });
	});

	it("rejects initialize in modern mode while preserving the legacy handshake", async () => {
		const modern = await handleJsonRpc({
			jsonrpc: "2.0",
			id: 7,
			method: "initialize",
			params: modernParams(),
		});
		expect(modern?.error).toEqual({ code: -32601, message: "Unknown method: initialize" });

		const legacy = await handleJsonRpc({
			jsonrpc: "2.0",
			id: 8,
			method: "initialize",
			params: {
				protocolVersion: LEGACY_PROTOCOL_VERSION,
				clientInfo: { name: "legacy-test", version: "1.0.0" },
				capabilities: {},
			},
		});
		expect(legacy).toEqual({
			jsonrpc: "2.0",
			id: 8,
			result: {
				protocolVersion: LEGACY_PROTOCOL_VERSION,
				serverInfo: SERVER_INFO,
				capabilities: { tools: {} },
			},
		});
	});

	it("preserves the legacy tools/call result shape", async () => {
		const response = await handleJsonRpc({
			jsonrpc: "2.0",
			id: 9,
			method: "tools/call",
			params: { name: "mnemopi_stats", arguments: { bank: "legacy" } },
		});
		if (response === null || response.error !== undefined) throw new Error("expected legacy tools/call result");
		const result = response.result as {
			content: Array<{ type: string; text: string }>;
			resultType?: unknown;
			_meta?: unknown;
		};
		expect(result.resultType).toBeUndefined();
		expect(result._meta).toBeUndefined();
		const payload = JSON.parse(result.content[0]?.text ?? "{}") as { status: string; bank: string };
		expect(payload).toMatchObject({ status: "ok", bank: "legacy" });
	});

	it("keeps stdio responses newline framed for strict modern clients", async () => {
		const notification = {
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: modernParams({ requestId: "obsolete" }),
		};
		const discover = {
			jsonrpc: "2.0",
			id: "stdio-discover",
			method: "server/discover",
			params: modernParams(),
		};
		const list = {
			jsonrpc: "2.0",
			id: "stdio-list",
			method: "tools/list",
			params: modernParams(),
		};
		const output = await runStdioRaw(
			`${JSON.stringify(notification)}\n${JSON.stringify(discover)}\n${JSON.stringify(list)}\n`,
		);
		expect(output.endsWith("\n")).toBe(true);
		expect(output.includes("\r")).toBe(false);
		const frames = output.split("\n");
		expect(frames.at(-1)).toBe("");
		expect(frames.slice(0, -1).map(frame => (JSON.parse(frame) as { id: unknown }).id)).toEqual([
			"stdio-discover",
			"stdio-list",
		]);
	});

	it("does not write a response for notifications but still answers requests", async () => {
		const responses = await runStdioText(
			`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify({
				jsonrpc: "2.0",
				id: 7,
				method: "tools/list",
			})}\n`,
		);
		expect(await handleJsonRpc({ jsonrpc: "2.0", method: "tools/list" })).toBeNull();
		expect(await handleJsonRpc({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
		expect(responses).toHaveLength(1);
		const response = responses[0] as { id?: unknown; result?: { tools?: unknown[] } };
		expect(response.id).toBe(7);
		expect(response.result?.tools).toHaveLength(23);
	});

	it("returns parse errors for malformed lines and keeps serving later requests", async () => {
		const responses = await runStdioText(
			`{"jsonrpc":"2.0",bad}\n${JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" })}\n`,
		);
		expect(responses).toHaveLength(2);
		const parseError = responses[0] as { id?: unknown; error?: { code?: number; message?: string } };
		expect(parseError.id).toBeNull();
		expect(parseError.error?.code).toBe(-32700);
		const validResponse = responses[1] as { id?: unknown; result?: { tools?: unknown[] } };
		expect(validResponse.id).toBe(8);
		expect(validResponse.result?.tools).toHaveLength(23);
	});

	it("wraps tool results in MCP text content", async () => {
		const response = await callToolJson("mnemopi_stats", { bank: "server" });
		expect(response.isError).toBeUndefined();
		const payload = JSON.parse(response.content[0]?.text ?? "{}") as {
			status: string;
			bank: string;
		};
		expect(payload.status).toBe("ok");
		expect(payload.bank).toBe("server");
	});

	it("dispatches remember, recall, stats, sleep, scratchpad, and bank operations", async () => {
		const remembered = await handleToolCall("mnemopi_remember", {
			content: "MCP server test remembers kombucha preference",
			importance: 0.8,
			bank: "work",
		});
		expect(remembered.status).toBe("stored");
		expect(remembered.bank).toBe("work");
		expect(typeof remembered.memory_id).toBe("string");

		const recalled = await handleToolCall("mnemopi_recall", {
			query: "kombucha preference",
			top_k: 3,
			bank: "work",
		});
		expect(recalled.status).toBe("ok");
		expect(recalled.bank).toBe("work");
		expect(recalled.count as number).toBeGreaterThanOrEqual(1);

		const scratchWrite = await handleToolCall("mnemopi_scratchpad_write", {
			content: "scratch note",
			bank: "work",
		});
		expect(scratchWrite.status).toBe("written");
		expect(scratchWrite.bank).toBe("work");
		const scratchRead = await handleToolCall("mnemopi_scratchpad_read", { bank: "work" });
		expect(scratchRead.entries_count as number).toBeGreaterThanOrEqual(1);

		const stats = await handleToolCall("mnemopi_stats", { bank: "work" });
		expect(stats.status).toBe("ok");
		expect(stats.bank).toBe("work");
		expect(stats.working).toBeDefined();

		const sleep = await handleToolCall("mnemopi_sleep", { dry_run: true, bank: "work" });
		expect(sleep.status).toBe("ok");
		expect(sleep.dry_run).toBe(true);
		expect(sleep.bank).toBe("work");
	});

	it("uses MNEMOPI_MCP_BANK when a call omits bank", async () => {
		process.env.MNEMOPI_MCP_BANK = "env-bank";
		const remembered = await handleToolCall("mnemopi_remember", { content: "env bank memory" });
		expect(remembered.bank).toBe("env-bank");
		const stats = await handleToolCall("mnemopi_stats", {});
		expect(stats.bank).toBe("env-bank");
	});

	it("routes bank paths through BankManager validation and canonical layout", async () => {
		const defaultStats = await handleToolCall("mnemopi_diagnose", {});
		expect(defaultStats.db_path).toBe(join(dataDir, "mnemopi.db"));

		const workStats = await handleToolCall("mnemopi_diagnose", { bank: "work" });
		expect(workStats.db_path).toBe(join(dataDir, "banks", "work", "mnemopi.db"));
		await expect(handleToolCall("mnemopi_diagnose", { bank: "../escape" })).rejects.toThrow();
	});

	it("links graph edges and queries related memories through a real BeamMemory", async () => {
		const first = await handleToolCall("mnemopi_remember", {
			content: "Graph source memory about Ada and deterministic tests",
			bank: "graph",
		});
		const second = await handleToolCall("mnemopi_remember", {
			content: "Graph target memory about Ada and reliable tests",
			bank: "graph",
		});
		const sourceId = first.memory_id;
		const targetId = second.memory_id;
		if (typeof sourceId !== "string" || typeof targetId !== "string") throw new Error("expected memory ids");

		const link = await handleToolCall("mnemopi_graph_link", {
			source_id: sourceId,
			target_id: targetId,
			relationship: "supports",
			weight: 0.75,
			bank: "graph",
		});
		expect(link.status).toBe("linked");
		expect(link.bank).toBe("graph");

		const query = await handleToolCall("mnemopi_graph_query", {
			seed_memory_id: sourceId,
			edge_type: "supports",
			min_weight: 0.7,
			max_hops: 1,
			bank: "graph",
		});
		expect(query.status).toBe("ok");
		expect(query.count).toBe(1);
		const related = query.related_memories as Array<{
			memoryId?: string;
			edgeType?: string;
			weight?: number;
			depth?: number;
		}>;
		expect(related).toEqual([{ memoryId: targetId, edgeType: "supports", weight: 0.75, depth: 1 }]);
	});
});
