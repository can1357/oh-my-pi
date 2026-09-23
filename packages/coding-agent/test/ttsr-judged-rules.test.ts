import { describe, expect, it, vi } from "bun:test";
import type { Agent, AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Judge, JudgmentRequest, NoulAnswer } from "@oh-my-pi/pi-ai";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TtsrCoordinator, type TtsrCoordinatorHost } from "@oh-my-pi/pi-coding-agent/session/ttsr-coordinator";

function judgedRule(name: string, fields: Partial<Rule>): Rule {
	return {
		name,
		path: `/rules/${name}.md`,
		content: `${name} guidance`,
		_source: { provider: "test", providerName: "test", path: `/rules/${name}.md`, level: "project" },
		...fields,
	};
}

/** Judge answering each question with the yes-probability its instructions map to (default 0). */
function fakeJudge(verdicts: Record<string, number>, gate?: Promise<void>) {
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

function setup(rules: Rule[], judge: Judge) {
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
	const host = {
		agent: { state: { messages: [], tools: [] }, abort } as unknown as Agent,
		sessionManager: { getCwd: () => "/work", appendTtsrInjection: vi.fn() } as unknown as SessionManager,
		settings: {} as Settings,
		emitSessionEvent: async () => {},
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
		abort,
		warnings,
		replaceSession: () => generation++,
	};
}

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") {
	return { role: "assistant", content, stopReason, timestamp: Date.now() } as AssistantMessage;
}

const PROMISES_TESTS = "Does the reply claim tests pass without having run them?";
const HAS_TODO = "Does the text leave a TODO for later?";

describe("TTSR judged rules", () => {
	it("never interrupts mid-stream and warns once on completion, asking only in-scope questions", async () => {
		const { judge, requests } = fakeJudge({ [PROMISES_TESTS]: 0.9 });
		const { coordinator, abort, warnings } = setup(
			[
				judgedRule("honest-tests", { question: PROMISES_TESTS, scope: ["text", "thinking"] }),
				judgedRule("rust-only", { question: HAS_TODO, scope: ["tool:edit(*.rs)"] }),
			],
			judge,
		);
		const message = assistant([
			{ type: "thinking", thinking: "tests probably pass" },
			{ type: "text", text: "All tests pass." },
		]);
		const streamed = await coordinator.checkMessageUpdate({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "All tests pass.", partial: message },
		} as AgentEvent);
		expect(streamed).toBe(false);
		expect(abort).not.toHaveBeenCalled();

		coordinator.onAssistantMessageEnd(message);
		await coordinator.settleJudgments();

		// Reply and reasoning are judged separately; the edit-scoped rule is never asked.
		expect(requests.map(request => Object.values(request.questions).map(q => q.instructions))).toEqual([
			[PROMISES_TESTS],
			[PROMISES_TESTS],
		]);
		// Both outputs flag the rule; it is delivered once.
		expect(warnings).toHaveLength(1);
		expect(warnings[0].rules).toEqual(["honest-tests"]);
		expect(warnings[0].content).toContain("honest-tests guidance");
	});

	it("asks only when the condition prefilter matches and ignores low-probability verdicts", async () => {
		const { judge, requests } = fakeJudge({ [HAS_TODO]: 0.4 });
		const { coordinator, warnings } = setup(
			[judgedRule("no-todo", { question: HAS_TODO, condition: ["TODO"], scope: ["text"] })],
			judge,
		);

		coordinator.onAssistantMessageEnd(assistant([{ type: "text", text: "Done, nothing left." }]));
		await coordinator.settleJudgments();
		expect(requests).toHaveLength(0);

		coordinator.onAssistantMessageEnd(assistant([{ type: "text", text: "TODO: wire the rest later." }]));
		await coordinator.settleJudgments();
		expect(requests).toHaveLength(1);
		expect(warnings).toHaveLength(0);
	});

	it("drops verdicts for aborted messages and for sessions replaced mid-judgment", async () => {
		const gate = Promise.withResolvers<void>();
		const { judge, requests } = fakeJudge({ [PROMISES_TESTS]: 1 }, gate.promise);
		const { coordinator, warnings, replaceSession } = setup(
			[judgedRule("honest-tests", { question: PROMISES_TESTS, scope: ["text"] })],
			judge,
		);

		coordinator.onAssistantMessageEnd(assistant([{ type: "text", text: "All tests pass." }], "aborted"));
		coordinator.onAssistantMessageEnd(assistant([{ type: "text", text: "All tests pass." }]));
		replaceSession();
		gate.resolve();
		await coordinator.settleJudgments();

		expect(requests).toHaveLength(1);
		expect(warnings).toHaveLength(0);
	});
});
