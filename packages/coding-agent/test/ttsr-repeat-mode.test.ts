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

/** One completed assistant text: stream it, record what fired, then advance the turn counters. */
function completeTurn(manager: TtsrManager, text: string): string[] {
	manager.resetBuffer();
	const matches = manager.checkDelta(text, TEXT, { final: true });
	manager.markInjected(matches);
	manager.incrementMessageCount();
	manager.completeTurn();
	return matches.map(rule => rule.name);
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

	it("fires a repeatMode: always rule at most once per turn, so an interrupt retry cannot loop", async () => {
		const messages: AgentMessage[] = [];
		let postPromptTask: (() => Promise<void>) | undefined;
		const scheduleAgentContinue = vi.fn();
		const host = {
			agent: {
				state: { messages, tools: [] },
				abort: vi.fn(),
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
		manager.addRule(probeRule("repeatMode: always\n"));
		const coordinator = new TtsrCoordinator(host, manager);

		/** Streams one assistant response; true when TTSR aborted it to inject the rule. */
		async function respond(text: string, timestamp: number): Promise<boolean> {
			const message = { role: "assistant", content: [], timestamp } as unknown as AssistantMessage;
			messages.push(message);
			coordinator.onTurnStart();
			coordinator.onAssistantMessageStart();
			const event = {
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: message },
			} as unknown as AgentEvent;
			const interrupted = await coordinator.checkMessageUpdate(event);
			const ended = { ...message, stopReason: interrupted ? "aborted" : "stop" } as AssistantMessage;
			coordinator.onAssistantMessageEnd(ended);
			coordinator.onTurnEnd(ended);
			if (interrupted) {
				// The session's post-prompt task injects the reminder and schedules the retry.
				await postPromptTask?.();
				postPromptTask = undefined;
			}
			return interrupted;
		}

		expect(await respond("I'll probe the endpoint.", 1)).toBe(true);
		expect(scheduleAgentContinue).toHaveBeenCalledTimes(1);
		// The retry repeats the violation inside the same turn: no second interrupt, no second retry.
		expect(await respond("I'll probe the endpoint.", 2)).toBe(false);
		expect(scheduleAgentContinue).toHaveBeenCalledTimes(1);
		// That retry completed the turn, so the next matching turn fires again.
		expect(await respond("Probe results look fine.", 3)).toBe(true);
		expect(scheduleAgentContinue).toHaveBeenCalledTimes(2);
	});
});
