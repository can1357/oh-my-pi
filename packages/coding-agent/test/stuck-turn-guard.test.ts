import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool, type AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ChoiceAnswer, Context, Judge, JudgmentRequest } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as judgment from "@oh-my-pi/pi-coding-agent/judgment";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type CustomMessage, convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	STUCK_TURN_NUDGE_TYPE,
	StuckTurnGuard,
	type StuckTurnGuardHost,
	type StuckTurnMode,
} from "@oh-my-pi/pi-coding-agent/session/stuck-turn-guard";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

type Verdict = Partial<Record<StuckTurnMode, number>> | "throw" | "hang" | ChoiceAnswer<StuckTurnMode>;

/** P(re_investigating) + P(retrying) = 0.9: a strike at the default 0.8 threshold. */
const STUCK: Verdict = { re_investigating: 0.6, retrying: 0.3, advancing: 0.1 };
const ADVANCING: Verdict = { advancing: 0.85, re_investigating: 0.1, retrying: 0.05 };

function choiceAnswer(probabilities: Partial<Record<StuckTurnMode, number>>): ChoiceAnswer<StuckTurnMode> {
	const [choice] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
	return {
		type: "choice",
		choice: choice as StuckTurnMode,
		probabilities: probabilities as Record<StuckTurnMode, number>,
		confidence: 0.9,
	};
}

/** A judge answering the `mode` question with each verdict in turn. */
function scriptedJudge(verdicts: Verdict[], states: unknown[] = []): Judge {
	let index = 0;
	return {
		label: "scripted",
		judge: async (request: JudgmentRequest, options) => {
			states.push(request.state);
			const verdict = verdicts[index++] ?? ADVANCING;
			if (verdict === "throw") throw new Error("judgment: no judge model available");
			if (verdict === "hang") {
				const { promise, reject } = Promise.withResolvers<never>();
				options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
				return promise;
			}
			return {
				api: "stub",
				provider: "stub",
				model: "stub",
				answers: { mode: typeof verdict === "object" && "type" in verdict ? verdict : choiceAnswer(verdict) },
				usage: zeroUsage,
			} as never;
		},
	};
}

function assistantTurn(index: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: "src/app.ts" } }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: zeroUsage,
		stopReason: "toolUse",
		timestamp: index,
	};
}

interface Harness {
	guard: StuckTurnGuard;
	messages: AgentMessage[];
	journal: { customType: string; details: unknown }[];
	judgeCalls: () => number;
	/** Runs one tool-call turn end through the guard. */
	turn(options?: { willContinue?: boolean; corrected?: boolean }): Promise<void>;
	nextPrompt(): void;
	setPlanMode(enabled: boolean): void;
}

function harness(verdicts: Verdict[], overrides: Record<string, unknown> = {}, timeoutMs?: number): Harness {
	const settings = Settings.isolated({ "model.stuckTurnGuard.enabled": true, ...overrides });
	const messages: AgentMessage[] = [
		{ role: "user", content: "fix the flaky test", attribution: "user", timestamp: 0 },
	];
	const journal: Harness["journal"] = [];
	let calls = 0;
	let generation = 1;
	let planMode = false;
	const judge = scriptedJudge(verdicts);
	const host: StuckTurnGuardHost = {
		settings,
		agent: { state: { messages }, appendMessage: () => {} } as unknown as StuckTurnGuardHost["agent"],
		sessionManager: {
			appendCustomMessageEntry: (customType: string, _content: unknown, _display: boolean, details: unknown) => {
				journal.push({ customType, details });
				return "entry";
			},
		} as unknown as StuckTurnGuardHost["sessionManager"],
		promptGeneration: () => generation,
		planModeEnabled: () => planMode,
		judge: () => {
			calls++;
			return judge;
		},
	};
	const guard = new StuckTurnGuard(host, timeoutMs);
	let index = 0;
	return {
		guard,
		messages,
		journal,
		judgeCalls: () => calls,
		async turn({ willContinue = true, corrected = false } = {}) {
			const message = assistantTurn(++index);
			messages.push(message, {
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "read",
				content: [{ type: "text", text: "export const app = 1;" }],
				isError: false,
				timestamp: index,
			});
			const context: AgentTurnEndContext = { message, toolResults: [], additionalMessages: [], willContinue };
			const pending = guard.ask(messages, context, undefined);
			if (pending) await guard.settle(messages, pending, { corrected });
		},
		nextPrompt: () => {
			generation++;
		},
		setPlanMode: enabled => {
			planMode = enabled;
		},
	};
}

function nudges(messages: AgentMessage[]): CustomMessage[] {
	return messages.filter(
		(message): message is CustomMessage => message.role === "custom" && message.customType === STUCK_TURN_NUDGE_TYPE,
	);
}

describe("StuckTurnGuard", () => {
	it("nudges once after three stuck turns in a row, then counts a fresh streak", async () => {
		const run = harness([STUCK, STUCK, STUCK, STUCK, STUCK, STUCK]);

		await run.turn();
		await run.turn();
		expect(nudges(run.messages)).toHaveLength(0);
		await run.turn();
		expect(nudges(run.messages)).toHaveLength(1);
		expect(nudges(run.messages)[0]!.display).toBe(false);
		expect(run.journal).toEqual([
			{
				customType: STUCK_TURN_NUDGE_TYPE,
				details: { strikes: 3, threshold: 0.8, choice: "re_investigating", stuckProbability: 0.8999999999999999 },
			},
		]);

		// The counter reset: two more stuck turns are not enough for a second nudge.
		await run.turn();
		await run.turn();
		expect(nudges(run.messages)).toHaveLength(1);
		await run.turn();
		expect(nudges(run.messages)).toHaveLength(2);
	});

	it("breaks the streak on a non-stuck verdict, counting P(re_investigating) + P(retrying) against the threshold", async () => {
		// 0.5 + 0.29 = 0.79 sits just under the 0.8 threshold; `unclear` also breaks a streak.
		const justUnder: Verdict = { re_investigating: 0.5, retrying: 0.29, advancing: 0.21 };
		const unclear: Verdict = { unclear: 0.6, re_investigating: 0.2, retrying: 0.1, advancing: 0.1 };
		const run = harness([STUCK, STUCK, justUnder, STUCK, STUCK, unclear, STUCK, STUCK, ADVANCING]);

		for (let i = 0; i < 9; i++) await run.turn();

		expect(nudges(run.messages)).toHaveLength(0);
	});

	it("honors the configured threshold and strike count", async () => {
		const run = harness(
			[
				{ retrying: 0.55, advancing: 0.45 },
				{ retrying: 0.55, advancing: 0.45 },
			],
			{
				"model.stuckTurnGuard.threshold": 0.5,
				"model.stuckTurnGuard.strikes": 2,
			},
		);

		await run.turn();
		await run.turn();

		expect(nudges(run.messages)).toHaveLength(1);
	});

	it("fails open: a failed or timed-out verdict injects nothing and breaks the streak", async () => {
		const run = harness([STUCK, STUCK, "throw", STUCK, STUCK, "hang", STUCK], {}, 20);

		for (let i = 0; i < 7; i++) await run.turn();

		expect(run.judgeCalls()).toBe(7);
		expect(nudges(run.messages)).toHaveLength(0);
		expect(run.journal).toHaveLength(0);
	});

	it("treats a choice without probabilities as a failed verdict", async () => {
		const bare = { type: "choice", choice: "retrying", confidence: 1 } as unknown as ChoiceAnswer<StuckTurnMode>;
		const run = harness([STUCK, STUCK, bare, STUCK, STUCK]);

		for (let i = 0; i < 5; i++) await run.turn();

		expect(run.judgeCalls()).toBe(5);
		expect(nudges(run.messages)).toHaveLength(0);
	});

	it("treats out-of-range or unknown-option probabilities as a failed verdict", async () => {
		const run = harness([
			STUCK,
			STUCK,
			{ re_investigating: 5 },
			STUCK,
			STUCK,
			{ retrying: 0.9, advancing: -0.5 },
			STUCK,
			STUCK,
			{ retrying: 0.9, bogus: 0.1 } as Verdict,
			STUCK,
			STUCK,
			{ retrying: Number.NaN, re_investigating: 0.9 },
		]);

		for (let i = 0; i < 12; i++) await run.turn();

		expect(run.judgeCalls()).toBe(12);
		expect(nudges(run.messages)).toHaveLength(0);
	});

	it("does not ask while disabled or for a turn that ends the run, and never carries strikes into a new prompt", async () => {
		const off = harness([STUCK, STUCK, STUCK], { "model.stuckTurnGuard.enabled": false });
		for (let i = 0; i < 3; i++) await off.turn();
		expect(off.judgeCalls()).toBe(0);

		const run = harness([STUCK, STUCK, STUCK, STUCK]);
		await run.turn({ willContinue: false });
		expect(run.judgeCalls()).toBe(0);
		await run.turn();
		await run.turn();
		run.nextPrompt();
		await run.turn();
		expect(nudges(run.messages)).toHaveLength(0);
	});

	it("resets the streak on a turn another guard corrected, giving that corrective a full streak", async () => {
		// Reviewer's scenario: stuck, stuck + loop-guard redirect, stuck. Without the reset
		// the third turn would stack a stuck nudge right after the redirect.
		const run = harness([STUCK, STUCK, STUCK, STUCK, STUCK]);

		await run.turn();
		await run.turn({ corrected: true });
		await run.turn();
		expect(nudges(run.messages)).toHaveLength(0);
		await run.turn();
		await run.turn();
		expect(nudges(run.messages)).toHaveLength(1);
	});

	it("does not ask while plan mode is on, and drops the streak it had", async () => {
		const run = harness([STUCK, STUCK, STUCK, STUCK]);

		await run.turn();
		await run.turn();
		run.setPlanMode(true);
		await run.turn();
		expect(run.judgeCalls()).toBe(2);
		run.setPlanMode(false);
		await run.turn();
		await run.turn();
		expect(nudges(run.messages)).toHaveLength(0);
	});
});

describe("AgentSession stuck-turn guard", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-stuck-turn-guard-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("puts the nudge into the request after the third stuck turn", async () => {
		const states: unknown[] = [];
		const judge = scriptedJudge([STUCK, STUCK, STUCK], states);
		const original = judgment.resolveJudge;
		const resolveJudge = spyOn(judgment, "resolveJudge").mockImplementation(deps =>
			deps.purpose === "stuck-turn" ? (judge as never) : original(deps),
		);
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Mock read tool",
			parameters: type({ "path?": "string" }),
			execute: async () => ({ content: [{ type: "text" as const, text: "export const app = 1;" }] }),
		};
		const contexts: Context[] = [];
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [readTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const toolCallTurn = callCount < 3;
				const id = `tc-${callCount++}`;
				const message: AssistantMessage = {
					role: "assistant",
					content: toolCallTurn
						? [{ type: "toolCall", id, name: "read", arguments: { path: `src/${id}.ts` } }]
						: [{ type: "text", text: "Done." }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: toolCallTurn ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: toolCallTurn ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.stuckTurnGuard.enabled": true,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map([[readTool.name, readTool]]),
		});

		await session.prompt("fix the flaky test");
		await session.waitForIdle();

		expect(resolveJudge.mock.calls.filter(([deps]) => deps.purpose === "stuck-turn")).toHaveLength(3);
		expect(states[2]).toMatchObject({ goal: "fix the flaky test" });
		expect(contexts).toHaveLength(4);
		expect(JSON.stringify(contexts[2]!.messages)).not.toContain("stuck_turns_detected");
		expect(JSON.stringify(contexts[3]!.messages)).toContain("stuck_turns_detected");
		expect(nudges(session.agent.state.messages)).toHaveLength(1);
	});
});
