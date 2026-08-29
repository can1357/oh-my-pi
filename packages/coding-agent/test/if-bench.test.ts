import { describe, expect, it } from "bun:test";
import type {
	Api,
	ApiKeyResolver,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
} from "@oh-my-pi/pi-ai";
import type { BenchModelRegistry } from "@oh-my-pi/pi-coding-agent/cli/bench-runtime";
import { runIfBenchCommand } from "@oh-my-pi/pi-coding-agent/if-bench";
import { applyActions, initialArray, makeActions } from "@oh-my-pi/pi-coding-agent/if-bench/actions";
import { assessResponse, buildTurnPrompt } from "@oh-my-pi/pi-coding-agent/if-bench/protocol";

const LENGTH = 24;
const NYA_MAX = 8;

const model = {
	provider: "acme",
	id: "if-bench-model",
	name: "if-bench-model",
	api: "openai-completions",
	maxTokens: 4096,
	contextWindow: 128_000,
} as unknown as Model<Api>;

const registry: BenchModelRegistry = {
	getAll: () => [model],
	getAvailable: () => [model],
	getApiKey: async () => "sk-test",
	resolver: () => (() => Promise.resolve("sk-test")) as unknown as ApiKeyResolver,
};

function replyStream(text: string): AssistantMessageEventStream {
	const message = {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: { input: 10, output: 5 },
		duration: 100,
	} as unknown as AssistantMessage;
	const events = [{ type: "done", message }] as unknown as AssistantMessageEvent[];
	const iterator = (async function* () {
		for (const event of events) yield event;
	})();
	return Object.assign(iterator, { result: async () => message }) as unknown as AssistantMessageEventStream;
}
function errorStream(errorMessage: string): AssistantMessageEventStream {
	const events = [{ type: "error", error: { errorMessage } }] as unknown as AssistantMessageEvent[];
	const iterator = (async function* () {
		for (const event of events) yield event;
	})();
	return Object.assign(iterator, {
		result: async () => {
			throw new Error(errorMessage);
		},
	}) as unknown as AssistantMessageEventStream;
}

/** Replay the machine locally to answer turn `turn` of a run exactly as a perfect model would. */
function perfectResult(turn: number): string {
	let state = initialArray(LENGTH);
	let applied = 0;
	for (let index = 1; index <= turn; index += 1) {
		state = applyActions(state, makeActions(LENGTH, applied, index));
		applied += index;
	}
	return state;
}

interface CapturedTurn {
	messages: Context["messages"];
	prompt: string;
}

/** Drive the command with a scripted reply per turn; the reply may be built from the turn's expected array. */
async function runScripted(reply: (turn: number, expected: string) => string, flags: Record<string, unknown> = {}) {
	const captured: CapturedTurn[] = [];
	const summary = await runIfBenchCommand(
		{ models: ["acme/if-bench-model"], flags: { turns: 4, par: 1, ...flags } },
		{
			createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
			randomSessionId: () => "sess-0",
			writeStdout: () => {},
			writeStderr: () => {},
			setExitCode: () => {},
			now: () => 0,
			stdoutIsTTY: false,
			streamSimple: (_model, context) => {
				const turn = captured.length + 1;
				const last = context.messages[context.messages.length - 1];
				captured.push({
					messages: [...context.messages],
					prompt: typeof last?.content === "string" ? last.content : "",
				});
				return replyStream(reply(turn, perfectResult(turn)));
			},
		},
	);
	return { summary, captured };
}

describe("if-bench machine", () => {
	it("permutes without losing characters and stays reproducible per absolute action index", () => {
		const start = initialArray(LENGTH);
		expect(start).not.toBe("ABCDEFGHIJKLMNOPQRSTUVWX");
		// Every action kind is a permutation: 40 actions cover all ten kinds four times.
		const permuted = applyActions(start, makeActions(LENGTH, 0, 40));
		expect(permuted).not.toBe(start);
		expect([...permuted].sort().join("")).toBe([...start].sort().join(""));
		// Turn boundaries are cosmetic: actions are indexed globally, so 1+2+3
		// actions must equal one run of 6 from index 0.
		let staged = start;
		let applied = 0;
		for (const count of [1, 2, 3]) {
			staged = applyActions(staged, makeActions(LENGTH, applied, count));
			applied += count;
		}
		expect(staged).toBe(applyActions(start, makeActions(LENGTH, 0, 6)));
	});

	it("rejects array lengths the weave action cannot split", () => {
		expect(() => initialArray(11)).toThrow(/even/);
		expect(() => initialArray(4)).toThrow(/\[8, 26\]/);
	});
});

describe("if-bench scoring", () => {
	const expected = "ABCDEF";

	it("reads the array through padding and an inlined cat sound", () => {
		expect(assessResponse("<ABC DEF> nya", expected, NYA_MAX)).toMatchObject({ passed: true });
		expect(assessResponse("<ABCDEF nyaa>", expected, NYA_MAX)).toMatchObject({ passed: true, reported: expected });
	});

	it("separates the two contracts and reports which one broke", () => {
		expect(assessResponse("<ABCDEF>", expected, NYA_MAX)).toMatchObject({ failure: "cat" });
		expect(assessResponse("<FEDCBA> nya", expected, NYA_MAX)).toMatchObject({ failure: "result" });
		expect(assessResponse("<FEDCBA>", expected, NYA_MAX)).toMatchObject({ failure: "result+cat" });
		expect(assessResponse("ABCDEF nya", expected, NYA_MAX)).toMatchObject({ failure: "format" });
	});

	it("refuses an over-long sound and the echoed directive itself", () => {
		expect(assessResponse(`<${expected}> nyaaaaaaaaa`, expected, NYA_MAX)).toMatchObject({ failure: "cat" });
		expect(assessResponse(`<${expected}> matching nya{1,8}`, expected, NYA_MAX)).toMatchObject({ failure: "cat" });
	});
});

describe("if-bench prompts", () => {
	it("rotates the cat directive through the prompt and only seeds the array once", () => {
		const actions = makeActions(LENGTH, 0, 4);
		const first = buildTurnPrompt({ turn: 1, start: "ABCD", actions, nyaMax: NYA_MAX });
		expect(first.placement).toBe("beginning");
		expect(first.content.startsWith("Include one lowercase cat sound")).toBe(true);
		expect(first.content).toContain("START <ABCD>");

		const second = buildTurnPrompt({ turn: 2, actions, nyaMax: NYA_MAX });
		expect(second.placement).toBe("middle");
		expect(second.content).not.toContain("START");
		// A middle directive is only observable when actions surround it.
		const lines = second.content.split("\n");
		const directive = lines.findIndex(line => line.startsWith("Include one"));
		expect(lines[directive - 1]?.startsWith("ACTIONS ")).toBe(true);
		expect(lines[directive + 1]?.startsWith("ACTIONS ")).toBe(true);

		const third = buildTurnPrompt({ turn: 3, actions, nyaMax: NYA_MAX });
		expect(third.placement).toBe("end");
		expect(third.content.split("\n").at(-1)?.startsWith("Include one")).toBe(true);
	});
});

describe("if-bench run", () => {
	it("carries state through the model's own replies and scores the depth reached", async () => {
		const { summary, captured } = await runScripted((turn, expected) =>
			turn === 3 ? `<${expected}>` : `<${expected}> nya`,
		);
		const report = summary.models[0]!;
		expect(report.turnsPassed).toBe(2);
		// Turn 3 issues 3 actions, so the surviving depth is 1 + 2 actions.
		expect(report.actionsPassed).toBe(3);
		expect(report.failure).toMatchObject({ turn: 3, kind: "cat" });
		expect(summary.failures).toBe(1);
		// The thread grows: turn 3 replays two user turns plus the two accepted answers.
		expect(captured[2]!.messages.filter(entry => entry.role === "assistant")).toHaveLength(2);
		expect(captured[2]!.messages.filter(entry => entry.role === "user")).toHaveLength(3);
		// Later turns must not restate the array.
		expect(captured[1]!.prompt).not.toContain("START");
	});

	it("survives the full budget when every turn holds both contracts", async () => {
		const { summary } = await runScripted((_turn, expected) => `nya <${expected}>`, { turns: 3 });
		const report = summary.models[0]!;
		expect(report.turnsPassed).toBe(3);
		expect(report.actionsPassed).toBe(6);
		expect(report.failure).toBeUndefined();
		expect(summary.failures).toBe(0);
	});
	it("retries a transient cyber refusal instead of ending the run", async () => {
		// The Anthropic cyber classifier refuses stochastically near the threshold;
		// the first attempt refuses, the retry answers, and the turn must pass.
		let attempts = 0;
		const summary = await runIfBenchCommand(
			{ models: ["acme/if-bench-model"], flags: { turns: 2, par: 1 } },
			{
				createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
				randomSessionId: () => `sess-${crypto.randomUUID()}`,
				sleep: () => Promise.resolve(),
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				now: () => 0,
				stdoutIsTTY: false,
				streamSimple: (_m, context) => {
					attempts += 1;
					// Turn number == user messages so far; turn 1's first attempt refuses.
					const turn = context.messages.filter(m => m.role === "user").length;
					return attempts === 1
						? errorStream("Refusal (cyber): This request triggered restrictions on violative cyber content")
						: replyStream(`<${perfectResult(turn)}> nya`);
				},
			},
		);
		const report = summary.models[0]!;
		expect(report.turns[0]!.passed).toBe(true);
		expect(report.turnsPassed).toBe(2);
		expect(report.failure).toBeUndefined();
	});

	it("scores a run-ending provider failure only after the refusal budget is spent", async () => {
		const summary = await runIfBenchCommand(
			{ models: ["acme/if-bench-model"], flags: { turns: 1, par: 1 } },
			{
				createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
				randomSessionId: () => "sess-x",
				sleep: () => Promise.resolve(),
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				now: () => 0,
				stdoutIsTTY: false,
				streamSimple: () => errorStream("Refusal (cyber): blocked"),
			},
		);
		const report = summary.models[0]!;
		expect(report.turnsPassed).toBe(0);
		expect(report.failure).toMatchObject({ turn: 1, kind: "provider" });
	});

	it("classifies a provider failure separately from a wrong answer", async () => {
		const captured: string[] = [];
		const summary = await runIfBenchCommand(
			{ models: ["acme/if-bench-model"], flags: { turns: 2, par: 1 } },
			{
				createRuntime: async () => ({ modelRegistry: registry, close: () => {} }),
				randomSessionId: () => "sess-0",
				writeStdout: () => {},
				writeStderr: text => captured.push(text),
				setExitCode: () => {},
				now: () => 0,
				stdoutIsTTY: false,
				streamSimple: () => {
					throw new Error("upstream refused");
				},
			},
		);
		const report = summary.models[0]!;
		expect(report.turnsPassed).toBe(0);
		expect(report.failure).toMatchObject({ turn: 1, kind: "provider", detail: "upstream refused" });
	});
});
