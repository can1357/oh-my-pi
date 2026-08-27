/**
 * TtsrCoordinator's `afterToolCall` must hand back a bare `ToolFactBody`, not
 * a fact carrying its own coordinator-minted id: the presentation stream is
 * the sole `FactId` authority (`${streamId}:fN`), and the agent loop declares
 * the effect's fact on that stream itself when one is open.
 */

import { describe, expect, it } from "bun:test";
import type { AfterToolCallContext, AgentEvent } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import type { Rule } from "../src/capability/rule";
import { Settings } from "../src/config/settings";
import { TtsrManager } from "../src/export/ttsr";
import { SessionManager } from "../src/session/session-manager";
import { TtsrCoordinator, type TtsrCoordinatorHost } from "../src/session/ttsr-coordinator";

const rule: Rule = {
	name: "no-unwrap",
	path: "/tmp/no-unwrap.md",
	content: "Do not use .unwrap()",
	condition: ["\\.unwrap\\("],
	scope: ["tool"],
	interruptMode: "never",
	_source: { provider: "test", providerName: "test", path: "/tmp/no-unwrap.md", level: "project" },
};

function makeToolCallMessage(toolCall: ToolCall): AssistantMessage {
	return {
		role: "assistant",
		content: [toolCall],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function makeCoordinator(): TtsrCoordinator {
	const ttsrManager = new TtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "always",
		repeatMode: "once",
		repeatGap: 10,
	});
	ttsrManager.addRule(rule);
	const host: TtsrCoordinatorHost = {
		agent: new Agent({}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		emitSessionEvent: async () => {},
		schedulePostPromptTask: () => {},
		scheduleAgentContinue: () => {},
		promptGeneration: () => 0,
	};
	return new TtsrCoordinator(host, ttsrManager);
}

describe("TtsrCoordinator.afterToolCall guidance fact shape", () => {
	it("returns a bare model_guidance ToolFactBody, with no coordinator-minted FactId", async () => {
		const coordinator = makeCoordinator();
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-guidance-1",
			name: "bash",
			arguments: { command: "" },
		};
		const message = makeToolCallMessage(toolCall);
		const event: AgentEvent = {
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: 'bash -c "x.unwrap("',
				partial: message,
			},
		};

		// A tool-scoped, `interruptMode: "never"` match queues a per-tool
		// injection instead of aborting the stream.
		const interrupted = await coordinator.checkMessageUpdate(event);
		expect(interrupted).toBe(false);

		const ctx: AfterToolCallContext = {
			assistantMessage: message,
			toolCall,
			args: { command: "" },
			result: { content: [{ type: "text", text: "ran" }], details: {} },
			isError: false,
			context: { systemPrompt: [], messages: [] },
		};
		const effect = coordinator.afterToolCall(ctx);
		if (effect === undefined || effect.kind !== "add_guidance_fact") {
			throw new Error("expected an add_guidance_fact effect");
		}
		expect(effect.fact.kind).toBe("model_guidance");
		expect(effect.fact.source).toBe("ttsr");
		expect(effect.fact.text).toContain("no-unwrap");
		// The old coordinator-minted `ttsr:<toolCallId>` id is gone entirely —
		// the effect carries only the body, never an `id` field.
		expect(Object.hasOwn(effect.fact, "id")).toBe(false);

		// A second call for the same tool call id has nothing pending.
		expect(coordinator.afterToolCall(ctx)).toBeUndefined();
	});
});
