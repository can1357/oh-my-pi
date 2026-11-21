import { describe, expect, it } from "bun:test";
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	buildSessionCut,
	PINNED_ENTRIES,
	type SessionCutCall,
	type SessionCutEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-cut";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

function user(text: string): AgentMessage {
	return { role: "user", content: text, attribution: "user", timestamp: 0 };
}

/** One assistant turn: optional reasoning, reply text, and a bash call with its result. */
function turn(index: number, text: string, command: string, output: string, thinking?: string): AgentMessage[] {
	const id = `call-${index}`;
	const content: AssistantMessage["content"] = [];
	if (thinking) content.push({ type: "thinking", thinking });
	content.push({ type: "text", text }, { type: "toolCall", id, name: "bash", arguments: { command } });
	return [
		{
			role: "assistant",
			content,
			api: "openai-responses",
			provider: "openai",
			model: "gpt-test",
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: index,
		},
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: output }],
			isError: false,
			timestamp: index,
		},
	];
}

describe("buildSessionCut", () => {
	it("builds the goal from the last three requests and notes each result in place of its output", () => {
		const messages: AgentMessage[] = [
			user("first request"),
			user("second request"),
			user("third request"),
			user(`fourth request ${"x".repeat(600)}`),
			{ role: "user", content: "harness reminder", synthetic: true, attribution: "agent", timestamp: 0 },
			...turn(
				1,
				"Running the tests.",
				"bun test test/app.test.ts",
				"test/app.test.ts:\n 3 pass\n 1 fail\nRan 4 tests across 1 file.",
				"secret plan",
			),
		];

		const cut = buildSessionCut(messages, 24_576);

		const goal = cut.goal.split("\n");
		expect(goal).toHaveLength(3);
		expect(goal[0]).toBe("second request");
		expect(goal[2]).toHaveLength(500);
		const entries = cut.history as SessionCutEntry[];
		expect(entries.map(entry => entry.role)).toEqual(["user", "user", "user", "user", "harness", "assistant"]);
		const assistant = entries.at(-1)!;
		// Reasoning never reaches the judge; the reply text does.
		expect(assistant.text).toBe("Running the tests.");
		expect(JSON.stringify(cut)).not.toContain("secret plan");
		const call = assistant.tool_calls![0] as SessionCutCall;
		expect(call.tool).toBe("bash");
		expect(call.result).toStartWith("ok, 60 chars (omitted): 3 pass; 1 fail; Ran 4 tests across 1 file.; starts ");
	});

	it("fits the budget by wearing down old entries, keeping the first message and the newest entries whole", () => {
		const request = `Make the parser tolerate empty input. ${"context ".repeat(40)}`;
		const messages: AgentMessage[] = [user(request)];
		for (let i = 1; i <= 40; i++) {
			messages.push(
				...turn(
					i,
					`Step ${i}: ${"reasoning about the parser ".repeat(30)}`,
					`rg parser src --step ${i}`,
					"x".repeat(2000),
				),
			);
		}
		const budget = 3000;

		const cut = buildSessionCut(messages, budget);

		expect(new Tokenizer().countTokens(JSON.stringify(cut))).toBeLessThanOrEqual(budget);
		const entries = cut.history.filter((entry): entry is SessionCutEntry => "role" in entry);
		const first = entries[0]!;
		expect(first.i).toBe(0);
		expect(first.text).toBe(request.trim());
		// The newest entries keep their structured calls; the text of the very newest stays whole.
		const newest = entries.slice(-PINNED_ENTRIES);
		expect(newest.map(entry => entry.i)).toEqual([35, 36, 37, 38, 39, 40]);
		for (const entry of newest) expect(typeof entry.tool_calls![0]).toBe("object");
		// Older entries were collapsed, shortened, or left out to make room.
		expect(cut.history.length).toBeLessThan(messages.length);
		expect(cut.history.some(entry => "left_out" in entry || (entry as SessionCutEntry).text.startsWith("[…"))).toBe(
			true,
		);
	});

	it("leaves a session that fits untouched", () => {
		const messages: AgentMessage[] = [user("fix it"), ...turn(1, "Looking.", "rg foo", "src/foo.ts:1:foo")];

		const cut = buildSessionCut(messages, 24_576);

		expect(cut.history).toEqual([
			{ i: 0, role: "user", text: "fix it" },
			{
				i: 1,
				role: "assistant",
				text: "Looking.",
				tool_calls: [
					{
						id: "t1",
						tool: "bash",
						input: '{"command":"rg foo"}',
						result: 'ok, 16 chars (omitted): starts "src/foo.ts:1:foo"',
					},
				],
			},
		]);
	});

	it("pairs each call with its own result when two calls share an id", () => {
		const messages: AgentMessage[] = [
			user("fix it"),
			...turn(1, "First look.", "rg foo", "first output"),
			...turn(1, "Second look.", "rg bar", "second output, longer"),
		];

		const cut = buildSessionCut(messages, 24_576);

		const results = (cut.history as SessionCutEntry[])
			.filter(entry => entry.role === "assistant")
			.map(entry => (entry.tool_calls![0] as SessionCutCall).result);
		expect(results).toEqual([
			'ok, 12 chars (omitted): starts "first output"',
			'ok, 21 chars (omitted): starts "second output, longer"',
		]);
	});
});
