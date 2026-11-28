import { expect, vi } from "bun:test";
import type { Agent, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Judge, JudgmentRequest, NoulAnswer } from "@oh-my-pi/pi-ai";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TtsrCoordinator, type TtsrCoordinatorHost } from "@oh-my-pi/pi-coding-agent/session/ttsr-coordinator";

export function judgedRule(name: string, fields: Partial<Rule>): Rule {
	return {
		name,
		path: `/rules/${name}.md`,
		content: `${name} guidance`,
		_source: { provider: "test", providerName: "test", path: `/rules/${name}.md`, level: "project" },
		...fields,
	};
}

/** Judge answering each question with the yes-probability its instructions map to (default 0). */
export function fakeJudge(verdicts: Record<string, number>, gate?: Promise<void>) {
	const requests: JudgmentRequest[] = [];
	const judge = {
		label: "fake",
		judge: async (request: JudgmentRequest) => {
			requests.push(request);
			await gate;
			const answers: Record<string, NoulAnswer> = {};
			for (const id in request.questions) {
				answers[id] = { type: "noul", noul: verdicts[request.questions[id].instructions] ?? 0 };
			}
			return { api: "fake", provider: "fake", model: "fake", answers, usage: {} };
		},
	} as unknown as Judge;
	return { judge, requests };
}

/** A coordinator over `rules` whose host judges with `judge` (undefined: judged rules off) and holds `tools`. */
export function setup(rules: Rule[], judge: Judge | undefined, settings = {} as Settings, tools: AgentTool[] = []) {
	const manager = new TtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "always",
		repeatMode: "once",
		repeatGap: 0,
	});
	for (const rule of rules) expect(manager.addRule(rule)).toBe(true);
	let generation = 0;
	const abort = vi.fn();
	const warnings: { content: string; rules: string[] }[] = [];
	const events: AgentSessionEvent[] = [];
	const host = {
		agent: { state: { messages: [], tools }, abort } as unknown as Agent,
		sessionManager: { getCwd: () => "/work", appendTtsrInjection: vi.fn() } as unknown as SessionManager,
		settings,
		emitSessionEvent: async (event: AgentSessionEvent) => {
			events.push(event);
		},
		schedulePostPromptTask: vi.fn(),
		scheduleAgentContinue: vi.fn(),
		promptGeneration: () => 0,
		ruleJudge: () => judge,
		deliverRuleWarning: async (content: string, ruleNames: string[]) => {
			warnings.push({ content, rules: ruleNames });
		},
		sessionGeneration: () => generation,
	} satisfies TtsrCoordinatorHost;
	return {
		coordinator: new TtsrCoordinator(host, manager),
		manager,
		host,
		abort,
		warnings,
		events,
		replaceSession: () => generation++,
	};
}

export function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") {
	return { role: "assistant", content, stopReason, timestamp: Date.now() } as AssistantMessage;
}
