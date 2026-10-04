import { describe, expect, it, type Mock, vi } from "bun:test";
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

interface CoordinatorHostBundle {
	host: TtsrCoordinatorHost;
	emitSessionEvent: Mock<(event: AgentSessionEvent) => Promise<void>>;
	followUp: Mock<(message: AgentMessage) => void>;
	hasQueuedMessages: Mock<() => boolean>;
	scheduleAgentContinue: Mock<(options: Parameters<TtsrCoordinatorHost["scheduleAgentContinue"]>[0]) => void>;
}

function makeHost(): CoordinatorHostBundle {
	const emitSessionEvent = vi.fn(async (_event: AgentSessionEvent) => undefined);
	const followUp = vi.fn((_message: AgentMessage) => undefined);
	const hasQueuedMessages = vi.fn(() => true);
	const scheduleAgentContinue = vi.fn(
		(_options: Parameters<TtsrCoordinatorHost["scheduleAgentContinue"]>[0]) => undefined,
	);
	const host = {
		agent: {
			state: { messages: [], tools: [] },
			abort: vi.fn(),
			followUp,
			hasQueuedMessages,
		} as unknown as Agent,
		sessionManager: { getCwd: () => "/tmp", appendTtsrInjection: vi.fn() } as unknown as SessionManager,
		settings: {} as Settings,
		emitSessionEvent,
		schedulePostPromptTask: vi.fn(),
		scheduleAgentContinue,
		promptGeneration: () => 0,
	} as unknown as TtsrCoordinatorHost;
	return { host, emitSessionEvent, followUp, hasQueuedMessages, scheduleAgentContinue };
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

/**
 * The agent loop turns the first provider `start` of a response into an
 * `AgentEvent` of type `message_start`, which the session routes to
 * `onAssistantMessageStart`; only a later `start` inside the same response
 * reaches `checkMessageUpdate`. Tests call `onAssistantMessageStart` where the
 * session would, so the reset is exercised on the event that actually occurs.
 */
function restart(message: AgentMessage): AgentEvent {
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
	it("does not re-queue a deferred rule before its first injection is persisted", async () => {
		const { host, scheduleAgentContinue } = makeHost();
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "never",
			repeatMode: "after-gap",
			repeatGap: 6,
		});
		expect(manager.addRule(makeRule("text"))).toBe(true);
		const coordinator = new TtsrCoordinator(host, manager);
		const first = assistantMessage();
		const second = assistantMessage();

		coordinator.onAssistantMessageStart();
		await coordinator.checkMessageUpdate(textDelta(first, CONDITION));
		coordinator.onAssistantMessageEnd({ ...first, stopReason: "stop" } as AssistantMessage);

		coordinator.onAssistantMessageStart();
		await coordinator.checkMessageUpdate(textDelta(second, CONDITION));
		coordinator.onAssistantMessageEnd({ ...second, stopReason: "stop" } as AssistantMessage);

		expect(host.agent.followUp).toHaveBeenCalledTimes(1);
		const scheduled = scheduleAgentContinue.mock.calls[0]?.[0];
		scheduled?.onSkip?.("should-continue-false");

		const third = assistantMessage();
		coordinator.onAssistantMessageStart();
		await coordinator.checkMessageUpdate(textDelta(third, CONDITION));
		coordinator.onAssistantMessageEnd({ ...third, stopReason: "stop" } as AssistantMessage);

		expect(host.agent.followUp).toHaveBeenCalledTimes(1);
	});

	it("commits repeatGap on persistence and counts completed turns", async () => {
		const { host, followUp } = makeHost();
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "never",
			repeatMode: "after-gap",
			repeatGap: 6,
		});
		expect(manager.addRule(makeRule("text"))).toBe(true);
		const coordinator = new TtsrCoordinator(host, manager);
		const first = assistantMessage();

		coordinator.onAssistantMessageStart();
		await coordinator.checkMessageUpdate(textDelta(first, CONDITION));
		coordinator.onAssistantMessageEnd({ ...first, stopReason: "stop" } as AssistantMessage);
		const delivery = followUp.mock.calls[0]?.[0];
		if (delivery?.role !== "custom") throw new Error("Expected a custom TTSR delivery");
		coordinator.markInjectedFromDetails(delivery.details);

		for (let turn = 0; turn < 5; turn++) coordinator.onTurnEnd();
		const beforeGap = assistantMessage();
		coordinator.onAssistantMessageStart();
		await coordinator.checkMessageUpdate(textDelta(beforeGap, CONDITION));
		coordinator.onAssistantMessageEnd({ ...beforeGap, stopReason: "stop" } as AssistantMessage);
		expect(host.agent.followUp).toHaveBeenCalledTimes(1);

		coordinator.onTurnEnd();
		const afterGap = assistantMessage();
		coordinator.onAssistantMessageStart();
		await coordinator.checkMessageUpdate(textDelta(afterGap, CONDITION));
		coordinator.onAssistantMessageEnd({ ...afterGap, stopReason: "stop" } as AssistantMessage);
		expect(host.agent.followUp).toHaveBeenCalledTimes(2);
	});

	it("rolls back only the cancelled deferred delivery", async () => {
		const { host, followUp, scheduleAgentContinue } = makeHost();
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "never",
			repeatMode: "after-gap",
			repeatGap: 6,
		});
		expect(manager.addRule(makeRule("text"))).toBe(true);
		const coordinator = new TtsrCoordinator(host, manager);
		const queueMatch = async () => {
			const message = assistantMessage();
			coordinator.onAssistantMessageStart();
			await coordinator.checkMessageUpdate(textDelta(message, CONDITION));
			coordinator.onAssistantMessageEnd({ ...message, stopReason: "stop" } as AssistantMessage);
		};

		await queueMatch();
		const firstDelivery = followUp.mock.calls[0]?.[0];
		if (firstDelivery?.role !== "custom") throw new Error("Expected a custom TTSR delivery");
		scheduleAgentContinue.mock.calls[0]?.[0].onSkip?.("stale-generation");
		await queueMatch();
		expect(host.agent.followUp).toHaveBeenCalledTimes(2);

		coordinator.markInjectedFromDetails(firstDelivery.details);
		for (let turn = 0; turn < 6; turn++) coordinator.onTurnEnd();
		await queueMatch();
		expect(host.agent.followUp).toHaveBeenCalledTimes(2);
	});

	it("allows retry when a deferred delivery is no longer queued", async () => {
		const { host, hasQueuedMessages, scheduleAgentContinue } = makeHost();
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "never",
			repeatMode: "after-gap",
			repeatGap: 6,
		});
		expect(manager.addRule(makeRule("text"))).toBe(true);
		const coordinator = new TtsrCoordinator(host, manager);
		const first = assistantMessage();

		coordinator.onAssistantMessageStart();
		await coordinator.checkMessageUpdate(textDelta(first, CONDITION));
		coordinator.onAssistantMessageEnd({ ...first, stopReason: "stop" } as AssistantMessage);
		hasQueuedMessages.mockReturnValue(false);
		expect(scheduleAgentContinue.mock.calls[0]?.[0].shouldContinue?.()).toBe(false);

		hasQueuedMessages.mockReturnValue(true);
		const second = assistantMessage();
		coordinator.onAssistantMessageStart();
		await coordinator.checkMessageUpdate(textDelta(second, CONDITION));
		coordinator.onAssistantMessageEnd({ ...second, stopReason: "stop" } as AssistantMessage);
		expect(host.agent.followUp).toHaveBeenCalledTimes(2);
	});

	it("releases a reservation when a queued delivery is discarded", async () => {
		const { host, followUp } = makeHost();
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "never",
			repeatMode: "after-gap",
			repeatGap: 6,
		});
		expect(manager.addRule(makeRule("text"))).toBe(true);
		const coordinator = new TtsrCoordinator(host, manager);
		const first = assistantMessage();

		coordinator.onAssistantMessageStart();
		await coordinator.checkMessageUpdate(textDelta(first, CONDITION));
		coordinator.onAssistantMessageEnd({ ...first, stopReason: "stop" } as AssistantMessage);
		const delivery = followUp.mock.calls[0]?.[0];
		if (delivery?.role !== "custom") throw new Error("Expected a custom TTSR delivery");

		coordinator.releaseDeferredReservationFromDetails(delivery.details);
		const second = assistantMessage();
		coordinator.onAssistantMessageStart();
		await coordinator.checkMessageUpdate(textDelta(second, CONDITION));
		coordinator.onAssistantMessageEnd({ ...second, stopReason: "stop" } as AssistantMessage);

		expect(host.agent.followUp).toHaveBeenCalledTimes(2);
	});

	it("does not carry a fallback-key tool buffer into the next assistant message", async () => {
		const { coordinator, emitSessionEvent } = coordinatorFor("tool:bash");
		const first = assistantMessage([{ type: "toolCall", id: "", name: "bash", arguments: {} }]);
		const second = assistantMessage([{ type: "toolCall", id: "", name: "bash", arguments: {} }]);

		coordinator.onTurnStart();
		coordinator.onAssistantMessageStart();
		await coordinator.checkMessageUpdate(toolDelta(first, CONDITION));
		coordinator.onAssistantMessageStart();
		await coordinator.checkMessageUpdate(toolDelta(second, "safe"));

		expect(emitSessionEvent).toHaveBeenCalledTimes(1);
	});

	it("does not carry text from a discarded response into its restart", async () => {
		const { coordinator, emitSessionEvent } = coordinatorFor("text");
		const message = assistantMessage();

		coordinator.onTurnStart();
		coordinator.onAssistantMessageStart();
		await coordinator.checkMessageUpdate(textDelta(message, CONDITION));
		await coordinator.checkMessageUpdate(restart(message));
		await coordinator.checkMessageUpdate(textDelta(message, "safe"));

		expect(emitSessionEvent).toHaveBeenCalledTimes(1);
	});

	it("keeps buffering deltas within one assistant message", async () => {
		const { coordinator, emitSessionEvent } = coordinatorFor("text");
		const message = assistantMessage();

		coordinator.onTurnStart();
		coordinator.onAssistantMessageStart();
		await coordinator.checkMessageUpdate(textDelta(message, "FOR"));
		await coordinator.checkMessageUpdate(textDelta(message, "BIDDEN"));

		expect(emitSessionEvent).toHaveBeenCalledTimes(1);
	});

	it("emits one ttsr_triggered when a delta match is re-confirmed at toolcall_end (issue #12184)", async () => {
		const { coordinator, emitSessionEvent } = coordinatorFor("tool:edit");
		const message = assistantMessage([{ type: "toolCall", id: "call-1", name: "edit", arguments: {} }]);

		coordinator.onTurnStart();
		coordinator.onAssistantMessageStart();
		await coordinator.checkMessageUpdate(toolDelta(message, `{"path":"src/foo.ts","input":"${CONDITION}"}`));
		await coordinator.checkMessageUpdate(
			update(message, {
				type: "toolcall_end",
				contentIndex: 0,
				partial: message as never,
				toolCall: {
					type: "toolCall",
					id: "call-1",
					name: "edit",
					arguments: { path: "src/foo.ts", input: CONDITION },
				},
			}),
		);

		const isTrigger = (event: AgentSessionEvent): boolean => event.type === "ttsr_triggered";
		expect(emitSessionEvent.mock.calls.filter(([event]) => isTrigger(event))).toHaveLength(1);
	});
});

/**
 * AST rules match whole-file structure, so they run once on the finalized
 * tool call — never per streamed delta. Awaiting native `astMatch` per delta
 * serialized hundreds of milliseconds onto the streaming event path and
 * wedged the loop (ui.loop-blocked on large edits).
 */
describe("TTSR AST deferral", () => {
	function astRule(): Rule {
		return {
			name: "no-inline-cast",
			path: "no-inline-cast.md",
			content: "Test reminder",
			astCondition: ["($X as { $$$BODY }).$PROP"],
			scope: ["tool:edit(*.ts)"],
			_source: { provider: "test", providerName: "test", path: "no-inline-cast.md", level: "project" },
		};
	}

	function messageWithEditCall(id: string, args: Record<string, unknown>): AgentMessage {
		return assistantMessage([{ type: "toolCall", id, name: "edit", arguments: args }]);
	}

	it("does not run AST matching on toolcall deltas", async () => {
		const { host } = makeHost();
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "never",
			repeatMode: "after-gap",
			repeatGap: 0,
		});
		expect(manager.addRule(astRule())).toBe(true);
		const coordinator = new TtsrCoordinator(host, manager);
		const checkAst = vi.spyOn(manager, "checkAstSnapshot");

		const message = messageWithEditCall("call-1", { path: "src/foo.ts", input: "const a = 1;" });
		coordinator.onAssistantMessageStart();
		await coordinator.checkMessageUpdate(toolDelta(message, '{"path":"src/foo.ts"'));
		await coordinator.checkMessageUpdate(toolDelta(message, ',"input":"const a = 1;"'));

		expect(checkAst).not.toHaveBeenCalled();
	});
});
