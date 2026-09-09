import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callToolJson, handleJsonRpc, runStdio } from "@oh-my-pi/pi-mnemopi/mcp-server";
import { getToolDefinitions, handleToolCall, TOOLS } from "@oh-my-pi/pi-mnemopi/mcp-tools";

let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "mnemopi-mcp-server-"));
	process.env.MNEMOPI_DATA_DIR = dataDir;
	process.env.MNEMOPI_NO_EMBEDDINGS = "1";
	delete process.env.MNEMOPI_MCP_BANK;
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
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

async function runStdioText(input: string): Promise<unknown[]> {
	let output = "";
	await runStdio(streamFromText(input), {
		write(chunk: string) {
			output += chunk;
		},
	});
	const trimmed = output.trim();
	return trimmed.length === 0 ? [] : trimmed.split("\n").map(line => JSON.parse(line) as unknown);
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
	it("lists tools through JSON-RPC", async () => {
		const response = await handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		if (response === null) throw new Error("expected tools/list response");
		expect(response.error).toBeUndefined();
		expect((response.result as { tools: unknown[] }).tools).toHaveLength(23);
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
