import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { callSessionTool, type JsStatusEvent } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

/**
 * Under Code Mode edit/write leave the direct tool surface and run through the
 * eval bridge, so the turn-level result is `eval`. The bridge flags a nested
 * workspace-mutating call on the emitted status event so the prewalk coordinator
 * can recognize it (issue #11018). Read-only calls and read-tier `xd://` device
 * dispatches carry no flag, preserving the mid-investigation exclusion (#7312).
 */
const emptySchema = type({});

function stubTool(name: string, details: unknown): AgentTool {
	const tool: AgentTool<typeof emptySchema, unknown> = {
		name,
		label: name,
		description: `stub ${name}`,
		parameters: emptySchema,
		async execute(): Promise<AgentToolResult<unknown>> {
			return { content: [{ type: "text", text: "ok" }], details };
		},
	};
	return tool as AgentTool;
}

async function bridgeStatus(tool: AgentTool): Promise<JsStatusEvent> {
	const events: JsStatusEvent[] = [];
	const session = {
		getToolByName: (name: string) => (name === tool.name ? tool : undefined),
	} as unknown as ToolSession;
	await callSessionTool(tool.name, {}, { session, emitStatus: event => events.push(event) });
	const settled = events.filter(event => event.error === undefined);
	expect(settled).toHaveLength(1);
	return settled[0];
}

describe("eval bridge implementation-action flag", () => {
	it("flags a direct write", async () => {
		const event = await bridgeStatus(stubTool("write", undefined));
		expect(event.op).toBe("write");
		expect(event.implementationAction).toBe(true);
	});

	it("flags a direct edit", async () => {
		const event = await bridgeStatus(stubTool("edit", { edited: true }));
		expect(event.implementationAction).toBe(true);
	});

	it("flags a write-tier xd:// device dispatched through write", async () => {
		const event = await bridgeStatus(stubTool("write", { xdev: { tool: "lsp", mode: "execute", tier: "write" } }));
		expect(event.implementationAction).toBe(true);
	});

	it("does not flag a read", async () => {
		const event = await bridgeStatus(stubTool("read", { lines: 3 }));
		expect(event.op).toBe("read");
		expect(event.implementationAction).toBeUndefined();
	});

	it("does not flag a read-tier xd:// device dispatched through write", async () => {
		const event = await bridgeStatus(stubTool("write", { xdev: { tool: "lsp", mode: "execute", tier: "read" } }));
		expect(event.implementationAction).toBeUndefined();
	});
});
