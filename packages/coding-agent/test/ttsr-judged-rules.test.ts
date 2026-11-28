import { describe, expect, it } from "bun:test";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { JudgmentRequest } from "@oh-my-pi/pi-ai";
import { JUDGED_CONTENT_MAX_TOKENS } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { countTokens, Encoding } from "@oh-my-pi/pi-natives";
import { assistant, fakeJudge, judgedRule, setup } from "./helpers/ttsr-judged-rules";

/** `content` field of a judged `{ output, content }` state. */
function sentContent(request: JudgmentRequest): string {
	const { state } = request;
	if (typeof state === "object" && "content" in state) {
		const { content } = state;
		if (typeof content === "string") return content;
	}
	throw new Error("judgment state has no string `content`");
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

	it("sends as much output as fits Jev's state budget, measured in Jev tokens", async () => {
		const { judge, requests } = fakeJudge({});
		const { coordinator } = setup([judgedRule("no-todo", { question: HAS_TODO, scope: ["text"] })], judge);
		// One Jev token per character: 60k characters would overflow the ~33k-token branch limit.
		const chinese = "人人生而自由，在尊严和权利上一律平等。他们赋有理性和良心，并应以兄弟关系的精神相对待。".repeat(
			1_500,
		);
		// ~20k tokens in 96k characters: fits whole despite its length.
		const english = "The quick brown fox jumps over the lazy dog while the tests keep passing. ".repeat(1_300);
		for (const text of [chinese, english]) coordinator.onAssistantMessageEnd(assistant([{ type: "text", text }]));
		await coordinator.settleJudgments();

		const sent = requests.map(sentContent);
		expect(chinese.startsWith(sent[0])).toBe(true);
		const tokens = countTokens(sent[0], Encoding.Jev);
		expect(tokens).toBeLessThanOrEqual(JUDGED_CONTENT_MAX_TOKENS);
		expect(tokens).toBeGreaterThan(JUDGED_CONTENT_MAX_TOKENS - 50);
		expect(sent[1]).toBe(english);
	});
});
