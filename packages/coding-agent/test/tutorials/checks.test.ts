import { afterAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import {
	emptyObservation,
	findFailingCheck,
	recordSessionEvent,
	type StepObservation,
} from "@oh-my-pi/pi-coding-agent/tutorials/checks";
import type { StepCheck } from "@oh-my-pi/pi-coding-agent/tutorials/lesson";
import { TempDir } from "@oh-my-pi/pi-utils";

const repo = TempDir.createSync("@pi-tutorial-checks-");
afterAll(() => repo.removeSync());
await Bun.write(path.join(repo.path(), "src/cart.ts"), "for (let i = 0; i < lines.length; i++) {}\n");

function event(value: unknown): AgentSessionEvent {
	return value as AgentSessionEvent;
}

/** Feed a scripted turn: user prompt, tool calls, final assistant text. */
function observe(turn: {
	user?: string;
	tools?: [string, unknown][];
	reply?: string;
	yielded?: boolean;
}): StepObservation {
	const observation = emptyObservation();
	if (turn.user !== undefined) {
		recordSessionEvent(observation, event({ type: "message_start", message: { role: "user", content: turn.user } }));
	}
	for (const [toolName, args] of turn.tools ?? []) {
		recordSessionEvent(observation, event({ type: "tool_execution_start", toolCallId: toolName, toolName, args }));
	}
	recordSessionEvent(
		observation,
		event({
			type: "agent_end",
			yielded: turn.yielded,
			messages: [{ role: "assistant", content: [{ type: "text", text: turn.reply ?? "" }] }],
		}),
	);
	return observation;
}

const rows: { check: StepCheck; pass: StepObservation; fail: StepObservation }[] = [
	{
		check: { kind: "turn" },
		pass: observe({}),
		// A non-yielded end (retry/continuation) is not a finished turn.
		fail: observe({ yielded: false }),
	},
	{
		check: { kind: "keyword", word: "jevify" },
		pass: observe({ user: "jevify: which files change behaviour?" }),
		// Inside inline code the word is not a magic keyword.
		fail: observe({ user: "what does `jevify` do?" }),
	},
	{
		check: { kind: "tool", name: "eval", match: /judge\(/i },
		pass: observe({ tools: [["eval", { code: "await judge(items, q)" }]] }),
		fail: observe({
			tools: [
				["eval", { code: "print(1)" }],
				["read", { path: "judge(" }],
			],
		}),
	},
	{
		check: { kind: "command", name: "btw" },
		pass: { ...emptyObservation(), commands: ["btw"] },
		fail: { ...emptyObservation(), commands: ["tan"] },
	},
	{
		check: { kind: "reply", pattern: /refund\.ts/i },
		pass: observe({ reply: "Changed: src/handlers/refund.ts" }),
		fail: observe({ reply: "Nothing changed." }),
	},
];

describe("findFailingCheck", () => {
	it.each(rows)("$check.kind passes on matching events and fails otherwise", async ({ check, pass, fail }) => {
		expect(await findFailingCheck([check], pass, repo.path())).toBeUndefined();
		expect(await findFailingCheck([check], fail, repo.path())).toEqual(check);
	});

	it("file checks read the repo after the turn, including a missing file", async () => {
		const fixed: StepCheck = { kind: "file", path: "src/cart.ts", matches: /^(?![\s\S]*<=\s*lines\.length)/i };
		const buggy: StepCheck = { kind: "file", path: "src/cart.ts", matches: /<=\s*lines\.length/i };
		const missing: StepCheck = { kind: "file", path: "src/none.ts", matches: /./ };
		expect(await findFailingCheck([fixed], emptyObservation(), repo.path())).toBeUndefined();
		expect(await findFailingCheck([buggy], emptyObservation(), repo.path())).toEqual(buggy);
		expect(await findFailingCheck([missing], emptyObservation(), repo.path())).toEqual(missing);
	});

	it("a step passes only when every check passes, reporting the first failure", async () => {
		const keyword: StepCheck = { kind: "keyword", word: "jevify" };
		const tool: StepCheck = { kind: "tool", name: "eval", match: /judge\(/i };
		const keywordOnly = observe({ user: "jevify the commit", tools: [["read", { path: "a.ts" }]] });
		expect(await findFailingCheck([keyword, tool], keywordOnly, repo.path())).toEqual(tool);
	});
});
