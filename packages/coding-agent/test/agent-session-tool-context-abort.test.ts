import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadedCustomCommand } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

/**
 * A tool or command context's `abort()` is the user's interrupt: it must run
 * `AgentSession.abort`, which also cancels the pending retry, usage preflights
 * and title work. `agent.abort()` alone stops only the agent loop. The title
 * signal shows which one ran: only the session abort aborts it.
 */
let session: AgentSession | undefined;

afterEach(async () => {
	await session?.dispose();
	session = undefined;
});

function createSession(customCommands: LoadedCustomCommand[] = []): AgentSession {
	const model = buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
	const main = createMockModel({ handler: { content: ["done"] } });
	session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: main.stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
		modelRegistry: { getApiKey: async () => "test-key" } as never,
		toolRegistry: new Map(),
		customCommands,
	});
	return session;
}

describe("tool and command context abort", () => {
	it("cancels title work when a /tree ask re-answer is cancelled", () => {
		const target = createSession();
		const titleSignal = target.titleGenerationSignal;

		target.buildAskReanswerContext({} as ExtensionUIContext).abort();

		expect(titleSignal.aborted).toBe(true);
	});

	it("cancels title work when an MCP tool aborts through its context", async () => {
		const target = createSession();
		const tool = {
			name: "mcp__probe_stop",
			label: "probe/stop",
			description: "Aborts the session",
			parameters: type({ q: "string" }),
			strict: true,
			mcpServerName: "probe",
			mcpToolName: "stop",
			async execute(_toolCallId, _params, _onUpdate, ctx) {
				ctx.abort();
				return { content: [{ type: "text", text: "stopped" }] };
			},
		} as CustomTool;
		await target.refreshMCPTools([tool]);
		const titleSignal = target.titleGenerationSignal;

		await target.getToolByName(tool.name)?.execute("call_1", { q: "x" });

		expect(titleSignal.aborted).toBe(true);
	});

	// Control: a command context already aborts through the session; the two tool contexts above must match it.
	it("cancels title work when a custom command aborts through its context", async () => {
		const target = createSession([
			{
				path: "stop.ts",
				resolvedPath: "stop.ts",
				source: "project",
				command: {
					name: "stop",
					description: "Aborts the session",
					execute(_args, ctx) {
						ctx.abort();
						return undefined;
					},
				},
			},
		]);
		const titleSignal = target.titleGenerationSignal;

		await target.prompt("/stop");

		expect(titleSignal.aborted).toBe(true);
	});
});
