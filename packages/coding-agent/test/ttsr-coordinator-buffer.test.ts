import { describe, expect, it, vi } from "bun:test";
import type { Agent, AgentEvent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { TtsrCoordinator, type TtsrCoordinatorHost } from "@oh-my-pi/pi-coding-agent/session/ttsr-coordinator";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const CONDITION = "FORBIDDEN";

function makeRule(scope: string): Rule {
	const name = `stream-boundary-${scope.replaceAll(/[^a-z0-9]+/gi, "-")}`;
	return {
		name,
		path: `${name}.md`,
		content: "Test reminder",
		condition: [CONDITION],
		scope: [scope],
		_source: {
			provider: "test",
			providerName: "test",
			path: `${name}.md`,
			level: "project",
		},
	};
}

function makeHost() {
	const emitSessionEvent = vi.fn(async (_event: AgentSessionEvent) => undefined);
	const host = {
		agent: {
			state: { messages: [], tools: [] },
			abort: vi.fn(),
		} as unknown as Agent,
		sessionManager: {} as SessionManager,
		settings: {} as Settings,
		emitSessionEvent,
		schedulePostPromptTask: vi.fn(),
		scheduleAgentContinue: vi.fn(),
		promptGeneration: () => 0,
	} as unknown as TtsrCoordinatorHost;
	return { host, emitSessionEvent };
}

function assistantMessage(content: unknown[] = []): AgentMessage {
	return { role: "assistant", content, timestamp: Date.now() } as AgentMessage;
}

function update(message: AgentMessage, assistantMessageEvent: AssistantMessageEvent): AgentEvent {
	return {
		type: "message_update",
		message,
		assistantMessageEvent,
	} as unknown as AgentEvent;
}

function start(message: AgentMessage): AgentEvent {
	return update(message, {
		type: "start",
		partial: message as AssistantMessage,
	});
}

function textDelta(message: AgentMessage, delta: string): AgentEvent {
	return update(message, {
		type: "text_delta",
		contentIndex: 0,
		delta,
		partial: message as AssistantMessage,
	});
}

function toolDelta(message: AgentMessage, delta: string): AgentEvent {
	return update(message, {
		type: "toolcall_delta",
		contentIndex: 0,
		delta,
		partial: message as AssistantMessage,
	});
}

function coordinatorFor(scope: string) {
	const { host, emitSessionEvent } = makeHost();
	const manager = new TtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "always",
		repeatMode: "after-gap",
		repeatGap: 0,
	});
	expect(manager.addRule(makeRule(scope))).toBe(true);
	return { coordinator: new TtsrCoordinator(host, manager), emitSessionEvent };
}

describe("TTSR stream buffers", () => {
	it("does not carry text from one assistant message into the next", async () => {
		const { coordinator, emitSessionEvent } = coordinatorFor("text");
		const first = assistantMessage();
		const second = assistantMessage();

		coordinator.onTurnStart();
		await coordinator.checkMessageUpdate(start(first));
		await coordinator.checkMessageUpdate(textDelta(first, CONDITION));
		await coordinator.checkMessageUpdate(start(second));
		await coordinator.checkMessageUpdate(textDelta(second, "safe"));

		expect(emitSessionEvent).toHaveBeenCalledTimes(1);
	});

	it("does not carry a fallback-key tool buffer into the next assistant message", async () => {
		const { coordinator, emitSessionEvent } = coordinatorFor("tool:bash");
		const first = assistantMessage([{ type: "toolCall", id: "", name: "bash", arguments: {} }]);
		const second = assistantMessage([{ type: "toolCall", id: "", name: "bash", arguments: {} }]);

		coordinator.onTurnStart();
		await coordinator.checkMessageUpdate(start(first));
		await coordinator.checkMessageUpdate(toolDelta(first, CONDITION));
		await coordinator.checkMessageUpdate(start(second));
		await coordinator.checkMessageUpdate(toolDelta(second, "safe"));

		expect(emitSessionEvent).toHaveBeenCalledTimes(1);
	});

	it("keeps buffering deltas within one assistant message", async () => {
		const { coordinator, emitSessionEvent } = coordinatorFor("text");
		const message = assistantMessage();

		coordinator.onTurnStart();
		await coordinator.checkMessageUpdate(start(message));
		await coordinator.checkMessageUpdate(textDelta(message, "FOR"));
		await coordinator.checkMessageUpdate(textDelta(message, "BIDDEN"));

		expect(emitSessionEvent).toHaveBeenCalledTimes(1);
	});
});
