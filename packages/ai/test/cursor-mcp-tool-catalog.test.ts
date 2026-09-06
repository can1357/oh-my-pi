import { describe, expect, it } from "bun:test";
import { buildMcpToolDefinitions } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Tool } from "@oh-my-pi/pi-ai/types";

const tool = (name: string): Tool => ({
	name,
	description: `${name} tool`,
	parameters: { type: "object", properties: {} },
});

describe("cursor buildMcpToolDefinitions", () => {
	it("forwards the write transport alongside preview-staging devices so xd:// resolution stays reachable", () => {
		// A Cursor session with xdev on: ast_edit is a mounted device, write is the
		// xd:// transport carried top-level. ast_edit always stages a preview whose
		// resolution rides `write xd://resolve` / `write xd://reject`.
		const defs = buildMcpToolDefinitions([
			tool("read"),
			tool("write"),
			tool("bash"),
			tool("todo"),
			tool("ast_edit"),
			tool("task"),
		]);
		const names = defs.map(def => def.name);

		expect(names).toContain("ast_edit");
		expect(names).toContain("task");
		// `write` is the sole native-filtered tool re-included: without it the
		// staged preview can never be resolved and the SoftToolRequirement('write')
		// escalation aborts the turn.
		expect(names).toContain("write");
		expect(names).not.toContain("read");
		expect(names).not.toContain("bash");
		expect(names).not.toContain("todo");

		// The forwarded write must be a routable pi-agent MCP tool, so Cursor
		// dispatches it back through the coding-agent write tool's xd:// handler.
		const writeDef = defs.find(def => def.name === "write");
		expect(writeDef?.providerIdentifier).toBe("pi-agent");
		expect(writeDef?.toolName).toBe("write");
	});

	it("keeps write out when only native tools are advertised (no pi-agent device needs resolution)", () => {
		const names = buildMcpToolDefinitions([tool("read"), tool("write"), tool("bash")]).map(def => def.name);
		expect(names).toEqual([]);
	});

	it("advertises lsp, which Cursor has no native equivalent for", () => {
		// `lsp` is deliberately absent from the native-filtered set: Cursor's own
		// tools cover none of definition/references/rename, so filtering it out
		// leaves the model with no way to reach them at all.
		const defs = buildMcpToolDefinitions([tool("read"), tool("bash"), tool("lsp")]);

		const lspDef = defs.find(def => def.name === "lsp");
		expect(lspDef).toBeDefined();
		expect(lspDef?.providerIdentifier).toBe("pi-agent");
		expect(lspDef?.toolName).toBe("lsp");
	});

	it("advertises hashline edit, which Cursor has no native equivalent for", () => {
		// Native StrReplace is `editToolCall`, not hashline. Filtering `edit`
		// would leave the model with no way to apply a tagged section rewrite.
		const defs = buildMcpToolDefinitions([tool("read"), tool("bash"), tool("edit")]);
		const editDef = defs.find(def => def.name === "edit");
		expect(editDef).toBeDefined();
		expect(editDef?.providerIdentifier).toBe("pi-agent");
		expect(editDef?.toolName).toBe("edit");
		expect(defs.map(def => def.name)).not.toContain("read");
	});
});
