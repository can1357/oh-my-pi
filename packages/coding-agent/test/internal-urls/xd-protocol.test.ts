import { describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolContext } from "@pk-nerdsaver-ai/pi-agent-core";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { InternalUrlRouter, parseInternalUrl } from "@pk-nerdsaver-ai/pi-coding-agent/internal-urls";
import { XdProtocolHandler } from "@pk-nerdsaver-ai/pi-coding-agent/internal-urls/xd-protocol";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { ReadTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/read";
import { WriteTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/write";
import { XdevRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/tools/xdev";
import { type } from "arktype";

function createTool(): AgentTool {
	return {
		name: "mcp__demo__lookup",
		label: "Demo lookup",
		description: "Looks up a required value.",
		parameters: type({ value: "string" }),
		async execute() {
			return { content: [{ type: "text", text: "unused" }] };
		},
	};
}

function createRegistry(): XdevRegistry {
	const registry = new XdevRegistry({ enabled: true });
	registry.reconcile([createTool()]);
	return registry;
}

describe("XdProtocolHandler", () => {
	it("lists mounted devices and renders per-tool schema docs", async () => {
		const registry = createRegistry();
		const router = new InternalUrlRouter();
		const context = { xdev: { getRegistry: () => registry } };

		const listing = await router.resolve("xd://", context);
		expect(listing.content).toContain("xd://mcp__demo__lookup");

		const docs = await router.resolve("xd://mcp__demo__lookup", context);
		expect(docs.content).toContain("Looks up a required value.");
		expect(docs.content).toContain('"value"');
		expect(docs.immutable).toBe(true);
	});

	it("reports disabled and unknown devices clearly", async () => {
		const handler = new XdProtocolHandler();
		await expect(handler.resolve(parseInternalUrl("xd://"))).rejects.toThrow("tools.xdev");

		const registry = createRegistry();
		await expect(
			handler.resolve(parseInternalUrl("xd://missing"), { xdev: { getRegistry: () => registry } }),
		).rejects.toThrow("Unknown xd:// tool");
	});

	it("validates JSON arguments and forwards normalized execution", async () => {
		const registry = createRegistry();
		const handler = new XdProtocolHandler();
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const result = await handler.write(parseInternalUrl("xd://mcp__demo__lookup"), '{"value":"needle"}', {
			xdev: {
				getRegistry: () => registry,
				execute: async (name, args) => {
					calls.push({ name, args });
					return { content: [{ type: "text", text: "found" }] };
				},
			},
		});

		expect(result.content).toEqual([{ type: "text", text: "found" }]);
		expect(calls).toEqual([{ name: "mcp__demo__lookup", args: { value: "needle" } }]);
	});

	it("rejects malformed, non-object, and schema-invalid arguments", async () => {
		const registry = createRegistry();
		const handler = new XdProtocolHandler();
		const context = {
			xdev: {
				getRegistry: () => registry,
				execute: async () => ({ content: [{ type: "text" as const, text: "should not run" }] }),
			},
		};
		const url = parseInternalUrl("xd://mcp__demo__lookup");

		await expect(handler.write(url, "{", context)).rejects.toThrow("Invalid JSON");
		await expect(handler.write(url, "[]", context)).rejects.toThrow("must be a JSON object");
		await expect(handler.write(url, "{}", context)).rejects.toThrow("accepted JSON schema");
	});

	it("treats help and empty writes as documentation requests without executing", async () => {
		const registry = createRegistry();
		const handler = new XdProtocolHandler();
		let executions = 0;
		const context = {
			xdev: {
				getRegistry: () => registry,
				execute: async () => {
					executions++;
					return { content: [{ type: "text" as const, text: "unexpected" }] };
				},
			},
		};
		const url = parseInternalUrl("xd://mcp__demo__lookup");

		await expect(handler.write(url, "help", context)).rejects.toThrow("Read xd://mcp__demo__lookup");
		await expect(handler.write(url, "", context)).rejects.toThrow("Read xd://mcp__demo__lookup");
		expect(executions).toBe(0);
	});

	it("routes xd:// reads through the session registry", async () => {
		const registry = createRegistry();
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			enableLsp: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getXdevRegistry: () => registry,
		};
		const result = await new ReadTool(session).execute("xd-read", { path: "xd://mcp__demo__lookup" });
		const text = result.content.find(block => block.type === "text");
		expect(text?.type === "text" ? text.text : "").toContain("Looks up a required value.");

		const disabledSession: ToolSession = { ...session, getXdevRegistry: () => undefined };
		await expect(new ReadTool(disabledSession).execute("xd-disabled", { path: "xd://" })).rejects.toThrow(
			"tools.xdev",
		);
	});

	it("surfaces mounted tool output through the write tool", async () => {
		const registry = createRegistry();
		const invocationContext = {} as AgentToolContext;
		let forwardedContext: AgentToolContext | undefined;
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			enableLsp: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getXdevRegistry: () => registry,
			executeXdevTool: async (_name, args, _signal, context) => {
				forwardedContext = context;
				return {
					content: [
						{ type: "text", text: `found:${String(args.value)}` },
						{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
					],
					details: { source: "mounted-tool" },
				};
			},
		};
		const tool = new WriteTool(session);
		if (typeof tool.approval !== "function") throw new Error("write approval must be dynamic");
		expect(tool.approval({ path: "[XD://mcp__demo__lookup:raw#ABCD]" })).toBe("exec");
		expect(tool.approval({ path: "notes-xd://mcp__demo__lookup" })).toBe("write");
		const result = await tool.execute(
			"xd-write",
			{ path: "xd://mcp__demo__lookup", content: '{"value":"needle"}' },
			undefined,
			undefined,
			invocationContext,
		);
		const text = result.content.find(block => block.type === "text");

		expect(text?.type === "text" ? text.text : "").toBe("found:needle");
		expect(result.content).toContainEqual({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" });
		expect(forwardedContext).toBe(invocationContext);
		expect(result.details?.xdev).toEqual({
			toolName: "mcp__demo__lookup",
			details: { source: "mounted-tool" },
		});
	});
});
