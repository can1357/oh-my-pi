import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseXdUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/xd-protocol";
import type { MCPToolOriginSource } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { requiresApproval, resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { resolveMountedXdevExecutable, type XdevState, xdevDocsAll } from "@oh-my-pi/pi-coding-agent/tools/xdev";

const deltaSchema = type({ delta: "number" });
const RARE_TOOL = "mcp__archive_item_124";
const DISABLED_TOOL = "mcp__archive_disabled";
const SERVER_GUIDANCE = "Inspect archive retention before retiring objects; record the retention decision.";

interface CatalogPage {
	snapshot: string;
	inventoryTotal: number;
	total: number;
	offset: number;
	limit: number;
	families: Array<{ name: string; count: number; path: string }>;
	tools: Array<{ name: string; family: string; path: string; summary: string; mcpStatus?: string }>;
	next: string | null;
}

function textOf(result: AgentToolResult<unknown>): string {
	const text = result.content.find(part => part.type === "text");
	if (!text || text.type !== "text") throw new Error("Expected a text result");
	return text.text;
}

async function readCatalog(read: ReadTool, path: string): Promise<CatalogPage> {
	return JSON.parse(textOf(await read.execute("catalog-read", { path }))) as CatalogPage;
}

function createCatalogFixture() {
	const balances = new Map<string, number>();
	function createDevice(
		name: string,
		summary: string,
		multiplier = 1,
	): AgentTool<typeof deltaSchema> & MCPToolOriginSource {
		return {
			name,
			label: name,
			description: summary,
			summary,
			parameters: deltaSchema,
			loadMode: "discoverable",
			approval: "write",
			...(name.startsWith("mcp__") ? { mcpServerName: "archive-server", mcpToolName: name } : {}),
			async execute(_id, { delta }) {
				const balance = (balances.get(name) ?? 0) + delta * multiplier;
				balances.set(name, balance);
				return { content: [{ type: "text", text: `balance=${balance}` }] };
			},
		};
	}
	const tools = new Map<string, Tool>();
	const mountedNames = new Set<string>();
	for (let index = 124; index >= 0; index--) {
		const name = `mcp__archive_item_${String(index).padStart(3, "0")}`;
		tools.set(
			name,
			createDevice(name, name === RARE_TOOL ? "Retire legacy objects safely" : `Archive operation ${index}`),
		);
		mountedNames.add(name);
	}
	tools.set(DISABLED_TOOL, createDevice(DISABLED_TOOL, "Retire disabled objects"));
	tools.set("active_only", createDevice("active_only", "Report account state"));
	const activeNames = new Set(["active_only", "read", "write"]);
	const xdev: XdevState = {
		tools,
		mountedNames,
		builtInNames: new Set(["read", "write"]),
		isActive: name => activeNames.has(name),
		getDocsMode: () => "index",
		getMcpServerInstructions: name => (name === "archive-server" ? SERVER_GUIDANCE : undefined),
		getMcpServerStatus: name => (name === "archive-server" ? "connected" : undefined),
	};
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "tools.xdevDocs": "index" }),
		xdev,
	};
	const read = new ReadTool(session);
	const write = new WriteTool(session);
	tools.set(read.name, read);
	tools.set(write.name, write);
	return { read, write, xdev, activeNames, balances, createDevice };
}

describe("xd:// indexed discovery through ReadTool", () => {
	it("finds a rare device beyond the first page, reads its guidance, and executes the canonical tool", async () => {
		const { read, write, xdev, activeNames, balances } = createCatalogFixture();
		const index = xdevDocsAll(xdev, "index", [RARE_TOOL]);
		expect(Buffer.byteLength(index)).toBeLessThan(1600);
		expect(index).toContain("xd://?family=mcp%3Aarchive");
		for (const name of xdev.mountedNames) expect(index).not.toContain(name);
		expect(index).not.toContain(SERVER_GUIDANCE);

		const first = await readCatalog(read, "xd://?");
		expect(first.total).toBe(128);
		expect(first.tools).toHaveLength(50);
		expect(first.tools.map(tool => tool.name)).not.toContain(RARE_TOOL);
		expect(first.families.map(({ name, count }) => ({ name, count }))).toEqual([
			{ name: "builtin", count: 2 },
			{ name: "external", count: 1 },
			{ name: "mcp:archive", count: 125 },
		]);
		const names: string[] = [];
		const visited = new Set<string>();
		let page = first;
		while (true) {
			names.push(...page.tools.map(tool => tool.name));
			if (!page.next) break;
			expect(visited.has(page.next)).toBe(false);
			visited.add(page.next);
			page = await readCatalog(read, page.next);
			expect(page.snapshot).toBe(first.snapshot);
		}
		expect(names).toEqual(
			[...xdev.tools.keys()].filter(name => xdev.mountedNames.has(name) || activeNames.has(name)).sort(),
		);
		expect(names).not.toContain(DISABLED_TOOL);
		const exhaustive = textOf(await read.execute("mounted-list", { path: "xd://" }));
		for (const name of xdev.mountedNames) expect(exhaustive).toContain(`xd://${name}`);

		const selected = await readCatalog(read, "xd://?family=mcp%3Aarchive&q=ReTiRe+ArChIvE");
		expect(selected.total).toBe(1);
		expect(selected.tools[0]).toMatchObject({ name: RARE_TOOL, path: `xd://${RARE_TOOL}`, mcpStatus: "connected" });
		const wrongFamily = await readCatalog(read, "xd://?family=mcp%3AARCHIVE&q=retire");
		expect(wrongFamily.total).toBe(0);
		expect(wrongFamily.next).toBeNull();
		xdev.tools.get(RARE_TOOL)!.summary = `${"Archive metadata ".repeat(30)}\nRETENTION_LEDGER`;
		const fullSummaryMatch = await readCatalog(read, "xd://?q=archive+retention_ledger");
		expect(fullSummaryMatch.tools.map(tool => tool.name)).toEqual([RARE_TOOL]);
		expect(Buffer.byteLength(fullSummaryMatch.tools[0]!.summary)).toBeLessThanOrEqual(200);
		const docs = textOf(await read.execute("selected-docs", { path: selected.tools[0]!.path }));
		expect(docs).toContain("delta: number");
		expect(docs).toContain(SERVER_GUIDANCE);
		expect(docs).toContain("archive-server");
		expect(balances.size).toBe(0);

		const result = await write.execute("selected-execute", { path: selected.tools[0]!.path, content: '{"delta":3}' });
		expect(result.isError).toBeUndefined();
		expect(textOf(result)).toBe("balance=3");
		const direct = resolveMountedXdevExecutable(xdev, RARE_TOOL)!;
		expect(textOf(await direct.execute("canonical-direct", { delta: 4 }))).toBe("balance=7");
	});

	it("keeps dispatch and permission policy canonical after a discovered tool is replaced", async () => {
		const { read, write, xdev, balances, createDevice } = createCatalogFixture();
		const selected = await readCatalog(read, "xd://?q=retire");
		const path = selected.tools[0]!.path;
		xdev.tools.set(RARE_TOOL, createDevice(RARE_TOOL, "Retire legacy objects safely", 2));
		let policy: "deny" | "allow" = "deny";
		xdev.decorateExecution = canonical => ({
			...canonical,
			async execute(id, args, signal, onUpdate, context) {
				requiresApproval(canonical, args, "always-ask", { [canonical.name]: policy });
				return canonical.execute(id, args, signal, onUpdate, context);
			},
		});
		const args = { path, content: '{"delta":5}' };
		expect(resolveApproval(write, args, "always-ask", { [RARE_TOOL]: "deny" })).toMatchObject({
			policy: "deny",
			policyKey: RARE_TOOL,
		});
		const denied = await write.execute("device-denied", args);
		expect(denied.isError).toBe(true);
		await expect(
			resolveMountedXdevExecutable(xdev, RARE_TOOL)!.execute("direct-denied", { delta: 5 }),
		).rejects.toThrow("deny");
		expect(balances.size).toBe(0);
		policy = "allow";
		expect(textOf(await write.execute("device-allowed", args))).toBe("balance=10");
		expect(
			textOf(await resolveMountedXdevExecutable(xdev, `XD://${RARE_TOOL}`)!.execute("direct-allowed", { delta: 5 })),
		).toBe("balance=20");
	});

	it("rejects malformed queries and never sends catalog writes to any tool", async () => {
		const { read, write, balances } = createCatalogFixture();
		for (const [path, message] of [
			["xd://?execute=retire", "Unknown"],
			["xd://?q=retire&q=archive", "Duplicate"],
			["xd://?offset=-1", "offset"],
			["xd://?offset=1", "snapshot"],
			["xd://?limit=0", "limit"],
			["xd://?limit=201", "limit"],
			["xd://?limit=1.5", "limit"],
			["xd://?family=", "family"],
			["xd://?q=%FF", "percent encoding"],
			["xd://?q=archive#fragment", "fragments"],
			[`xd://${RARE_TOOL}?q=retire`, "Invalid xd:// URL"],
		]) {
			await expect(read.execute("invalid-query", { path })).rejects.toThrow(message);
		}
		await expect(
			write.execute("catalog-write", { path: "xd://?q=retire", content: '{"delta":100}' }),
		).rejects.toThrow("read-only");
		expect(balances.size).toBe(0);
		expect(parseXdUrl("XD://CanonicalName")).toEqual({ name: "CanonicalName" });
		expect(parseXdUrl("xd://?q=CanonicalName")).toBeNull();
	});

	it("rejects stale pagination only when the enabled inventory changes", async () => {
		const { read, xdev, activeNames, createDevice } = createCatalogFixture();
		const first = await readCatalog(read, "xd://?limit=1");
		if (!first.next) throw new Error("Expected a continuation");
		const reordered = [...xdev.tools].reverse();
		xdev.tools.clear();
		for (const [name, tool] of reordered) xdev.tools.set(name, tool);
		xdev.tools.set("inactive_registration", createDevice("inactive_registration", "Not enabled"));
		const continued = await readCatalog(read, first.next);
		expect(continued.snapshot).toBe(first.snapshot);
		expect(continued.offset).toBe(1);
		activeNames.delete("active_only");
		await expect(read.execute("stale-page", { path: first.next })).rejects.toThrow("snapshot is stale");
		const refreshed = await readCatalog(read, "xd://?limit=200");
		expect(refreshed.total).toBe(127);
		expect(refreshed.tools.map(tool => tool.name)).not.toContain("active_only");
		expect(refreshed.next).toBeNull();
		await expect(read.execute("disabled-docs", { path: "xd://active_only" })).rejects.toThrow("not enabled");
	});

	it("preserves exact registered device names instead of redirecting selector-shaped names", async () => {
		const { read, write, xdev, balances, createDevice } = createCatalogFixture();
		const base = createDevice("literal", "Base device", 1);
		const literal = createDevice("literal:raw", "Exact colon device", 3);
		const encoded = createDevice("literal%3Araw", "Encoded colon device", 5);
		for (const tool of [base, literal, encoded]) {
			xdev.tools.set(tool.name, tool);
			xdev.mountedNames.add(tool.name);
		}
		expect(textOf(await read.execute("literal-name", { path: "xd://literal:raw" }))).toContain("Exact colon device");
		expect(textOf(await read.execute("encoded-name", { path: "xd://literal%3Araw" }))).toContain(
			"Encoded colon device",
		);
		const written = await write.execute("literal-dispatch", { path: "xd://literal:raw", content: '{"delta":2}' });
		expect(textOf(written)).toBe("balance=6");
		expect(balances.has(base.name)).toBe(false);
		xdev.mountedNames.delete(literal.name);
		await expect(read.execute("disabled-literal", { path: "xd://literal:raw" })).rejects.toThrow("not enabled");
	});

	it("keeps selector-shaped catalog query values literal through the native read path", async () => {
		const { read, write, xdev, balances, createDevice } = createCatalogFixture();
		xdev.tools.get(RARE_TOOL)!.summary = "retention:raw";
		xdev.tools.get("mcp__archive_item_123")!.summary = "retention";
		const literal = await readCatalog(read, "xd://?q=retention:raw");
		expect(literal.tools.map(tool => tool.name)).toEqual([RARE_TOOL]);
		const encoded = await readCatalog(read, "xd://?q=retention%3Araw");
		expect(encoded.tools.map(tool => tool.name)).toEqual([RARE_TOOL]);
		const familyDevice = { ...createDevice("mcp__raw_item", "Raw family device"), mcpServerName: "raw" };
		xdev.tools.set(familyDevice.name, familyDevice);
		xdev.mountedNames.add(familyDevice.name);
		const family = await readCatalog(read, "xd://?family=mcp:raw");
		expect(family.tools.map(tool => tool.name)).toEqual([familyDevice.name]);
		const encodedFamily = await readCatalog(read, "xd://?family=mcp%3Araw");
		expect(encodedFamily.tools.map(tool => tool.name)).toEqual([familyDevice.name]);
		await expect(read.execute("invalid-query-selector", { path: "xd://?limit=1:raw" })).rejects.toThrow("limit");
		await expect(
			write.execute("query-write", { path: "xd://?q=retention:raw", content: '{"delta":2}' }),
		).rejects.toThrow("read-only");
		expect(balances.size).toBe(0);
	});

	it("reads full live server guidance through schema, help, and invalid-argument responses", async () => {
		const { read, write, xdev, balances } = createCatalogFixture();
		let instructions = `${"P".repeat(4001)} RETENTION_RULE_ONE`;
		xdev.getMcpServerInstructions = () => instructions;
		const first = await read.execute("full-guidance", { path: `xd://${RARE_TOOL}:raw` });
		expect(textOf(first)).toContain("RETENTION_RULE_ONE");
		instructions = `${"P".repeat(4001)} RETENTION_RULE_TWO`;
		const current = await read.execute("changed-guidance", { path: `xd://${RARE_TOOL}:raw` });
		expect(textOf(current)).toContain("RETENTION_RULE_TWO");
		expect(textOf(current)).not.toContain("RETENTION_RULE_ONE");
		const help = await write.execute("guidance-help", { path: `xd://${RARE_TOOL}`, content: "?" });
		expect(help.details?.xdev?.mode).toBe("help");
		expect(textOf(help)).toContain("RETENTION_RULE_TWO");
		const invalid = await write.execute("invalid-device-args", {
			path: `xd://${RARE_TOOL}`,
			content: '{"delta":"bad"}',
		});
		expect(invalid.isError).toBe(true);
		expect(textOf(invalid)).toContain("RETENTION_RULE_TWO");
		xdev.getDocsMode = () => "builtins";
		const legacy = await read.execute("legacy-guidance", { path: `xd://${RARE_TOOL}:raw` });
		expect(textOf(legacy)).not.toContain("RETENTION_RULE_TWO");
		expect(balances.size).toBe(0);
	});

	it("keeps enabled disconnected tools visible without claiming that unknown names are connected", async () => {
		const { read, xdev, balances } = createCatalogFixture();
		xdev.getMcpServerStatus = () => "disconnected";
		xdev.getMcpServerInstructions = () => undefined;
		const result = await readCatalog(read, "xd://?q=retire");
		expect(result.tools[0]).toMatchObject({ name: RARE_TOOL, mcpStatus: "disconnected" });
		const docs = textOf(await read.execute("disconnected-docs", { path: result.tools[0]!.path }));
		expect(docs).toContain("disconnected");
		expect(docs).not.toContain(SERVER_GUIDANCE);
		await expect(read.execute("unknown-docs", { path: "xd://no_such_tool" })).rejects.toThrow("No such tool");
		expect(balances.size).toBe(0);
	});
});
