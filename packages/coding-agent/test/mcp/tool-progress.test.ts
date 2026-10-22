import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { DeferredMCPTool, MCPTool, PROGRESS_UPDATE_INTERVAL_MS } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type {
	MCPRequestOptions,
	MCPServerConnection,
	MCPToolCallResult,
	MCPTransport,
} from "@oh-my-pi/pi-coding-agent/mcp/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { MCPProgress, MCPToolDetails } from "@oh-my-pi/pi-tui/tools/mcp";

const definition = { name: "progress_tool", inputSchema: { type: "object" as const } };
const result: MCPToolCallResult = {
	content: [{ type: "text", text: "done" }],
	isError: true,
	structuredContent: { rows: [1], cursor: "next:opaque" },
};
let auth: AuthStorage;
let context: CustomToolContext;

beforeEach(async () => {
	auth = await AuthStorage.create(":memory:");
	context = {
		sessionManager: SessionManager.inMemory(),
		modelRegistry: new ModelRegistry(auth),
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
	// Progress updates are throttled; tests drive the interval instead of waiting it out.
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	auth.close();
});

function connectionFor(handler: (options?: MCPRequestOptions) => MCPToolCallResult): MCPServerConnection {
	return {
		name: "progress-server",
		config: { type: "stdio", command: "fixture" },
		capabilities: { tools: {} },
		serverInfo: { name: "fixture", version: "1" },
		_source: { provider: "fixture", providerName: "Fixture", path: "/fixture", level: "native" },
		transport: {
			connected: true,
			request: (async (_method, _params, options) => handler(options)) as MCPTransport["request"],
			async notify() {},
			async close() {},
		},
	};
}

/** Report progress as a server pacing its notifications at least one update interval apart. */
function report(options: MCPRequestOptions | undefined, step: MCPProgress): void {
	options?.onProgress?.(step);
	vi.advanceTimersByTime(PROGRESS_UPDATE_INTERVAL_MS);
}

function withSteps(steps: MCPProgress[]): MCPServerConnection {
	return connectionFor(options => {
		for (const step of steps) report(options, step);
		return result;
	});
}

describe("MCP tools/call progress updates", () => {
	for (const kind of ["connected", "deferred"] as const) {
		it(`${kind}: emits coalesced progress partials without changing the final result`, async () => {
			const connection = withSteps([
				{ progress: 1, message: "Fetching\n\trows" },
				{ progress: 2, message: "Fetching rows" },
				{ progress: 3, total: 4, message: "Fetching rows" },
				{ progress: 4, total: 4 },
				{ progress: 5 },
			]);
			const tool =
				kind === "connected"
					? new MCPTool(connection, definition)
					: new DeferredMCPTool(connection.name, definition, async () => connection, connection._source);
			const updates: AgentToolResult<MCPToolDetails>[] = [];
			const actual = await tool.execute("progress", {}, partial => updates.push(partial), context);
			const baseline = await tool.execute("no-progress", {}, undefined, context);

			expect(updates.map(update => update.content[0])).toEqual([
				{ type: "text", text: "Fetching rows" },
				{ type: "text", text: "Fetching rows (3/4)" },
				{ type: "text", text: "4/4" },
				{ type: "text", text: "5" },
			]);
			expect(updates[0]?.details).toEqual({
				serverName: connection.name,
				mcpToolName: definition.name,
				provider: "fixture",
				providerName: "Fixture",
				progress: { progress: 1, message: "Fetching\n\trows" },
			});
			expect(
				updates.every(update => !Object.hasOwn(update, "isError") && !Object.hasOwn(update.details!, "isError")),
			).toBe(true);
			expect(actual).toEqual(baseline);
			expect(actual.isError).toBe(true);
			expect(actual.details?.structuredContent).toEqual(result.structuredContent);
			expect(actual.details).not.toHaveProperty("progress");
			// Coalescing belongs to one execute call, not to the reusable tool instance.
			const next: AgentToolResult<MCPToolDetails>[] = [];
			await tool.execute("next", {}, partial => next.push(partial), context);
			expect(next).toHaveLength(4);
		});
	}

	it("caps and sanitizes a multiline server message in the partial's text, keeping the count", async () => {
		const message = `first\n\t${"x".repeat(400)}`;
		const tool = new MCPTool(
			withSteps([
				{ progress: 1, message },
				{ progress: 2, total: 3, message },
			]),
			definition,
		);
		const updates: AgentToolResult<MCPToolDetails>[] = [];
		await tool.execute("bounded-message", {}, partial => updates.push(partial), context);
		const texts = updates.map(update => {
			const content = update.content[0];
			if (content?.type !== "text") throw new Error("missing progress text");
			return content.text;
		});
		expect(texts).toHaveLength(2);
		for (const text of texts) {
			expect(text).toStartWith("first ");
			expect(text).not.toMatch(/[\n\t]/);
			expect(visibleWidth(text)).toBeLessThanOrEqual(200);
		}
		expect(texts[1]).toEndWith(" (2/3)");
	});

	it("shows home paths in the partial's text as ~ and keeps the raw message in details", async () => {
		const message = `Indexing ${os.homedir()}/private/repo`;
		const tool = new MCPTool(withSteps([{ progress: 1, total: 2, message }]), definition);
		const updates: AgentToolResult<MCPToolDetails>[] = [];
		await tool.execute("home-path", {}, partial => updates.push(partial), context);
		expect(updates.map(update => update.content[0])).toEqual([
			{ type: "text", text: "Indexing ~/private/repo (1/2)" },
		]);
		expect(updates[0]?.details?.progress).toEqual({ progress: 1, total: 2, message });
	});

	for (const kind of ["connected", "deferred"] as const) {
		for (const failure of ["auth", "connection"] as const) {
			it(`${kind}: retains progress on a ${failure} retry`, async () => {
				const first = connectionFor(options => {
					report(options, { progress: 1, message: "initial" });
					if (failure === "connection") throw new Error("Transport closed");
					return {
						content: [{ type: "text", text: "authorize" }],
						isError: true,
						_meta: { "mcp/www_authenticate": ["Bearer realm=fixture"] },
					};
				});
				const next = withSteps([{ progress: 2, message: "retry" }]);
				const tool =
					kind === "connected"
						? new MCPTool(first, definition, async () => next)
						: new DeferredMCPTool(
								first.name,
								definition,
								async () => first,
								first._source,
								async () => next,
							);
				const messages: string[] = [];
				await tool.execute("retry", {}, partial => messages.push(partial.details!.progress!.message!), context);
				expect(messages).toEqual(["initial", "retry"]);
			});
		}
	}

	it("retains progress when a deferred connection lookup needs reconnecting", async () => {
		const connection = withSteps([{ progress: 1, message: "reconnected" }]);
		const tool = new DeferredMCPTool(
			connection.name,
			definition,
			async () => {
				throw new Error("not connected");
			},
			connection._source,
			async () => connection,
		);
		const updates: AgentToolResult<MCPToolDetails>[] = [];
		await tool.execute("lookup-retry", {}, partial => updates.push(partial), context);
		expect(updates.map(update => update.details?.progress)).toEqual([{ progress: 1, message: "reconnected" }]);
	});

	it("coalesces a progress burst to its newest step and drops one still waiting when the call ends", async () => {
		const tool = new MCPTool(
			connectionFor(options => {
				for (const progress of [1, 2, 3]) options?.onProgress?.({ progress, total: 9 });
				vi.advanceTimersByTime(PROGRESS_UPDATE_INTERVAL_MS);
				for (const progress of [4, 5]) options?.onProgress?.({ progress, total: 9 });
				return result;
			}),
			definition,
		);
		const texts: unknown[] = [];
		await tool.execute("burst", {}, partial => texts.push(partial.content[0]), context);
		vi.advanceTimersByTime(PROGRESS_UPDATE_INTERVAL_MS * 2);
		expect(texts).toEqual([
			{ type: "text", text: "1/9" },
			{ type: "text", text: "3/9" },
		]);
	});
});
