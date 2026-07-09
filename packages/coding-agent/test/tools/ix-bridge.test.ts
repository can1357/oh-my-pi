import { describe, expect, it } from "bun:test";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { createIxBridgeTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/ix-bridge";

interface FetchCall {
	url: string;
	init?: RequestInit;
}

function createSession(fetchImpl: typeof fetch): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		fetch: fetchImpl,
	} as unknown as ToolSession;
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("ix_bridge tool", () => {
	it("GET /ix-bridge/status on action=status", async () => {
		const calls: FetchCall[] = [];
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			return new Response(JSON.stringify({ running: true, extension_connected: true }), { status: 200 });
		}) as unknown as typeof fetch;

		const tool = createIxBridgeTool(createSession(fetchImpl));
		const result = await tool.execute("id", { action: "status" });

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("http://127.0.0.1:18086/ix-bridge/status");
		expect(calls[0].init?.method).toBeUndefined();
		expect(result.isError).toBeFalsy();
		expect(getText(result)).toContain("extension_connected");
	});

	it("POST /ix-bridge/command with lane/session/args on action=command", async () => {
		const calls: FetchCall[] = [];
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			return new Response(JSON.stringify({ success: true, refs: ["@e1"] }), { status: 200 });
		}) as unknown as typeof fetch;

		const tool = createIxBridgeTool(createSession(fetchImpl));
		const result = await tool.execute("id", {
			action: "command",
			command: "snapshot",
			session: "task-1",
			args: { interactiveOnly: false },
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("http://127.0.0.1:18086/ix-bridge/command");
		expect(calls[0].init?.method).toBe("POST");
		const body = JSON.parse(String(calls[0].init?.body));
		expect(body).toEqual({
			lane: "agent-a",
			action: "snapshot",
			args: { interactiveOnly: false },
			session: "task-1",
		});
		expect(result.isError).toBeFalsy();
		expect(getText(result)).toContain("success");
	});

	it("errors when action=command omits a command", async () => {
		const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
		const tool = createIxBridgeTool(createSession(fetchImpl));
		const result = await tool.execute("id", { action: "command" });

		expect(result.isError).toBe(true);
		expect(getText(result)).toContain("requires a `command`");
	});

	it("maps a connection failure to an actionable hint", async () => {
		const fetchImpl = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const tool = createIxBridgeTool(createSession(fetchImpl));
		const result = await tool.execute("id", { action: "status" });

		expect(result.isError).toBe(true);
		expect(getText(result)).toContain("Is the daemon running");
	});

	it("marks non-2xx responses as errors", async () => {
		const fetchImpl = (async () => new Response("lane not found", { status: 404 })) as unknown as typeof fetch;
		const tool = createIxBridgeTool(createSession(fetchImpl));
		const result = await tool.execute("id", { action: "command", command: "click", args: { selector: "@e9" } });

		expect(result.isError).toBe(true);
		expect(getText(result)).toContain("404");
	});
});
