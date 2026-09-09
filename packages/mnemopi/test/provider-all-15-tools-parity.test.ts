import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleToolCall, TOOLS } from "@oh-my-pi/pi-mnemopi/mcp-tools";

let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "mnemopi-ts-provider-parity-"));
	process.env.MNEMOPI_DATA_DIR = dataDir;
	process.env.MNEMOPI_NO_EMBEDDINGS = "1";
	delete process.env.MNEMOPI_MCP_BANK;
	delete process.env.MNEMOPI_SHARED_SURFACE_DB;
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
	delete process.env.MNEMOPI_DATA_DIR;
	delete process.env.MNEMOPI_NO_EMBEDDINGS;
	delete process.env.MNEMOPI_MCP_BANK;
	delete process.env.MNEMOPI_SHARED_SURFACE_DB;
});

function schemaFor(name: string) {
	const tool = TOOLS.find(candidate => candidate.name === name);
	expect(tool).toBeDefined();
	return tool?.inputSchema as { required?: readonly string[]; properties: Record<string, unknown> };
}

describe("provider all-tools parity", () => {
	it("registers the Python provider-compatible tool surface with valid JSON schemas", () => {
		const names = TOOLS.map(tool => tool.name);
		expect(names).toHaveLength(23);
		for (const name of [
			"mnemopi_remember",
			"mnemopi_recall",
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
			"mnemopi_shared_remember",
			"mnemopi_shared_recall",
			"mnemopi_shared_forget",
			"mnemopi_shared_stats",
			"mnemopi_graph_query",
			"mnemopi_graph_link",
		]) {
			expect(names).toContain(name);
		}
		for (const tool of TOOLS) {
			const roundTripped = JSON.parse(JSON.stringify(tool.inputSchema)) as { type: string };
			expect(roundTripped.type).toBe("object");
		}
	});

	it("advertises required arguments for provider write/update/import tools", () => {
		expect(schemaFor("mnemopi_remember").required).toContain("content");
		expect(schemaFor("mnemopi_recall").required).toContain("query");
		expect(schemaFor("mnemopi_scratchpad_write").required).toContain("content");
		expect(schemaFor("mnemopi_update").required).toEqual(["memory_id", "content"]);
		expect(schemaFor("mnemopi_forget").required).toContain("memory_id");
		expect(schemaFor("mnemopi_export").required).toContain("output_path");
		expect(schemaFor("mnemopi_import").required).toContain("input_path");
	});

	it("returns user-facing argument errors instead of mutating on missing arguments", async () => {
		for (const [name, args, expected] of [
			["mnemopi_remember", {}, "content is required"],
			["mnemopi_recall", {}, "query is required"],
			["mnemopi_scratchpad_write", { content: "" }, "content is required"],
			["mnemopi_update", { memory_id: "missing-id" }, "content or importance is required"],
			["mnemopi_forget", {}, "memory_id is required"],
			["mnemopi_export", {}, "output_path is required"],
			["mnemopi_import", {}, "Either input_path (for file import) is required"],
		] as const) {
			const result = await handleToolCall(name, args);
			expect(result.error).toBe(expected);
		}
	});

	it("exports provider data to a file and imports it into a fresh isolated bank", async () => {
		const remembered = await handleToolCall("mnemopi_remember", {
			content: "source provider memory for import parity",
			importance: 0.7,
			bank: "source",
		});
		expect(remembered.status).toBe("stored");
		await handleToolCall("mnemopi_scratchpad_write", {
			content: "portable provider scratch",
			bank: "source",
		});

		const exportPath = join(dataDir, "provider-export.json");
		const exported = await handleToolCall("mnemopi_export", {
			output_path: exportPath,
			bank: "source",
		});
		expect(exported.status).toBe("exported");
		expect(existsSync(exportPath)).toBe(true);
		const payload = JSON.parse(readFileSync(exportPath, "utf8")) as { working_memory?: unknown[] };
		expect(payload.working_memory?.length).toBe(1);

		const imported = await handleToolCall("mnemopi_import", { input_path: exportPath, bank: "dest" });
		expect(imported.status).toBe("imported");
		expect(JSON.stringify(imported.stats)).toContain("inserted");
		const recalled = await handleToolCall("mnemopi_recall", {
			query: "import parity",
			bank: "dest",
			limit: 5,
		});
		expect(recalled.count as number).toBeGreaterThanOrEqual(1);
	});

	it("diagnose, validate, graph, and shared handlers return structured provider results", async () => {
		const remembered = await handleToolCall("mnemopi_remember", {
			content: "validate me through provider parity",
			bank: "ops",
		});
		const memoryId = remembered.memory_id as string;
		const validate = await handleToolCall("mnemopi_validate", {
			memory_id: memoryId,
			action: "attest",
			validator: "test",
			bank: "ops",
		});
		expect(validate.status).toBe("validation_attest");
		const diagnose = await handleToolCall("mnemopi_diagnose", { bank: "ops" });
		expect(diagnose.status).toBe("ok");
		expect(diagnose.db_path).toContain("banks/ops/mnemopi.db");
		const graphQuery = await handleToolCall("mnemopi_graph_query", { seed_memory_id: memoryId, bank: "ops" });
		expect(graphQuery).toMatchObject({
			status: "ok",
			seed_memory_id: memoryId,
			count: 0,
			results_count: 0,
			results: [],
			related_memories: [],
			bank: "ops",
		});
		expect(
			await handleToolCall("mnemopi_graph_link", {
				source_id: memoryId,
				target_id: "other",
				relationship: "related",
				bank: "ops",
			}),
		).toMatchObject({
			status: "linked",
			source_id: memoryId,
			target_id: "other",
			relationship: "related",
			edge_type: "related",
			weight: 0.5,
			bank: "ops",
		});

		const shared = await handleToolCall("mnemopi_shared_remember", {
			content: "Prefer concise parity notes",
			kind: "preference",
		});
		expect(shared.status).toBe("stored_shared");
		expect((await handleToolCall("mnemopi_shared_forget", { memory_id: shared.memory_id })).status).toBe("deleted");
	}, 30_000);
});
