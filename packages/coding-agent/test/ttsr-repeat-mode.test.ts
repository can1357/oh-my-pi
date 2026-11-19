import { describe, expect, it, vi } from "bun:test";
import type { Agent, AgentEvent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { buildRuleFromMarkdown, createSourceMeta } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { TtsrManager, type TtsrMatchContext } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TtsrCoordinator, type TtsrCoordinatorHost } from "@oh-my-pi/pi-coding-agent/session/ttsr-coordinator";

const TEXT: TtsrMatchContext = { source: "text" };

/** A probe-check rule loaded from markdown, so the frontmatter parse is part of the path under test. */
function probeRule(frontmatter: string) {
	const content = String.raw`---
condition: '(?i)\bprobes?\b'
scope: text
${frontmatter}---
Check the claim before continuing.
`;
	return buildRuleFromMarkdown(
		"probe-check.md",
		content,
		"probe-check.md",
		createSourceMeta("test", "probe-check.md", "project"),
	);
}

/** One completed assistant text whose reminder lands inside the turn: stream it, record what fired, end the turn. */
function completeTurn(manager: TtsrManager, text: string): string[] {
	manager.resetBuffer();
	const matches = manager.checkDelta(text, TEXT, { final: true });
	manager.markInjected(matches);
	manager.incrementMessageCount();
	return matches.map(rule => rule.name);
}

/** A coordinator over a minimal session host, plus a driver that streams one assistant turn through it. */
function harness(frontmatter: string, { retryTaskFirst = false }: { retryTaskFirst?: boolean } = {}) {
	const messages: AgentMessage[] = [];
	const queued: AgentMessage[] = [];
	let postPromptTask: (() => Promise<void>) | undefined;
	const scheduleAgentContinue = vi.fn();
	const host = {
		agent: {
			state: { messages, tools: [], isStreaming: false },
			abort: vi.fn(),
			followUp: (message: AgentMessage) => queued.push(message),
			hasQueuedMessages: () => queued.length > 0,
			replaceMessages: (next: AgentMessage[]) => messages.splice(0, messages.length, ...next),
			appendMessage: (message: AgentMessage) => messages.push(message),
		} as unknown as Agent,
		sessionManager: {
			getCwd: () => "/tmp",
			appendCustomMessageEntry: vi.fn(),
			appendTtsrInjection: vi.fn(),
		} as unknown as SessionManager,
		emitSessionEvent: vi.fn(async () => undefined),
		schedulePostPromptTask: (task: () => Promise<void>) => {
			postPromptTask = task;
		},
		scheduleAgentContinue,
		promptGeneration: () => 0,
	} as unknown as TtsrCoordinatorHost;
	const manager = new TtsrManager({ interruptMode: "always", repeatMode: "once" });
	manager.addRule(probeRule(frontmatter));
	const coordinator = new TtsrCoordinator(host, manager);
	let timestamp = 0;

	/**
	 * Streams one assistant turn in agent-loop order: queued follow-ups are delivered (and committed via
	 * message_end) at the start of the next turn. An interrupt's reminder is appended by a timer-driven
	 * post-prompt task, which `retryTaskFirst` runs before the aborted turn's turn_end reaches the coordinator.
	 * Returns true when TTSR aborted the turn.
	 */
	async function respond(text: string): Promise<boolean> {
		for (const delivered of queued.splice(0)) {
			messages.push(delivered);
			if (delivered.role === "custom") coordinator.markInjectedFromDetails(delivered.details);
		}
		const message = { role: "assistant", content: [], timestamp: ++timestamp } as unknown as AssistantMessage;
		messages.push(message);
		coordinator.onTurnStart();
		coordinator.onAssistantMessageStart();
		const event = {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: message },
		} as unknown as AgentEvent;
		const interrupted = await coordinator.checkMessageUpdate(event);
		coordinator.onAssistantMessageEnd({
			...message,
			stopReason: interrupted ? "aborted" : "stop",
		} as AssistantMessage);
		if (interrupted && retryTaskFirst) await postPromptTask?.();
		coordinator.onTurnEnd();
		if (interrupted && !retryTaskFirst) await postPromptTask?.();
		postPromptTask = undefined;
		return interrupted;
	}

	return { respond, queued, scheduleAgentContinue };
}

describe("TTSR per-rule repeatMode", () => {
	it("re-triggers a repeatMode: always rule on every matching turn", () => {
		const manager = new TtsrManager({ repeatMode: "once" });
		manager.addRule(probeRule("repeatMode: always\n"));

		expect(completeTurn(manager, "I'll probe the endpoint.")).toEqual(["probe-check"]);
		expect(completeTurn(manager, "Probe results look fine.")).toEqual(["probe-check"]);
		expect(completeTurn(manager, "Two probes came back empty.")).toEqual(["probe-check"]);
		expect(completeTurn(manager, "The build is green.")).toEqual([]);
	});

	it("keeps the global once policy for rules without a repeatMode", () => {
		const manager = new TtsrManager({ repeatMode: "once" });
		manager.addRule(probeRule(""));

		expect(completeTurn(manager, "I'll probe the endpoint.")).toEqual(["probe-check"]);
		expect(completeTurn(manager, "I'll probe again.")).toEqual([]);
	});

	it("applies a rule's own after-gap window even when the global policy is once", () => {
		const manager = new TtsrManager({ repeatMode: "once", repeatGap: 3 });
		manager.addRule(probeRule("repeatMode: after-gap\n"));

		expect(completeTurn(manager, "I'll probe the endpoint.")).toEqual(["probe-check"]);
		expect(completeTurn(manager, "Probe again.")).toEqual([]);
		expect(completeTurn(manager, "Probe once more.")).toEqual([]);
		expect(completeTurn(manager, "And probe a third time.")).toEqual(["probe-check"]);
	});

	it.each([
		["after", false],
		["before", true],
	])(
		"never re-interrupts the retry its own interrupt scheduled (retry task %s turn_end)",
		async (_, retryTaskFirst) => {
			const { respond, scheduleAgentContinue } = harness("repeatMode: always\n", { retryTaskFirst });

			expect(await respond("I'll probe the endpoint.")).toBe(true);
			expect(scheduleAgentContinue).toHaveBeenCalledTimes(1);
			// The retry repeats the violation: no second interrupt, no second retry.
			expect(await respond("I'll probe the endpoint.")).toBe(false);
			expect(scheduleAgentContinue).toHaveBeenCalledTimes(1);
			expect(await respond("Probe results look fine.")).toBe(true);
			expect(scheduleAgentContinue).toHaveBeenCalledTimes(2);
		},
	);

	it("never re-queues a deferred reminder from the continuation it spawned, then fires on the next turn", async () => {
		const { respond, queued, scheduleAgentContinue } = harness("repeatMode: always\ninterruptMode: never\n");

		await respond("I'll probe the endpoint.");
		expect(queued).toHaveLength(1);
		expect(scheduleAgentContinue).toHaveBeenCalledTimes(1);
		// The continuation answering the reminder repeats the match: queuing again would continue forever.
		await respond("I'll probe the endpoint.");
		expect(queued).toHaveLength(0);
		expect(scheduleAgentContinue).toHaveBeenCalledTimes(1);
		await respond("Probe results look fine.");
		expect(queued).toHaveLength(1);
		expect(scheduleAgentContinue).toHaveBeenCalledTimes(2);
	});
});
