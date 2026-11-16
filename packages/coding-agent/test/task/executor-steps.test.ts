/**
 * Stepped spawns: the executor sends each step prompt only after the previous
 * one was delivered (a terminal `yield`, or without `yield` the final message),
 * returns the last step's result, reports each earlier step to the spawner, and
 * records progress `omp --restore` reads.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { readStepProgress } from "@oh-my-pi/pi-coding-agent/task/steps";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
const PROMPTS = ["STEP-ONE", "STEP-TWO", "STEP-THREE"];

function assistantStop(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface Child {
	yield(details: { status: "success"; data: unknown } | { status: "aborted"; error: string }): void;
	say(text: string): void;
}

/** A mock child that answers each prompt through `answer`, recording prompts and step entries. */
function stepSession(answer: (prompt: string, child: Child) => void, tools: string[]) {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: AssistantMessage[] = [];
	const prompts: string[] = [];
	const entries: FileEntry[] = [];
	let calls = 0;
	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};
	const child: Child = {
		yield: details => {
			calls += 1;
			emit({
				type: "tool_execution_end",
				toolCallId: `yield-${calls}`,
				toolName: "yield",
				result: { content: [{ type: "text", text: "Result submitted." }], details },
			} as AgentSessionEvent);
		},
		say: text => {
			const message = assistantStop(text);
			messages.push(message);
			emit({ type: "message_end", message } as AgentSessionEvent);
		},
	};
	const session = {
		...createSessionDefaults(),
		state: { messages },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
			appendCustomEntry: (customType: string, data: unknown) => {
				entries.push({ type: "custom", customType, data } as FileEntry);
			},
		},
		getActiveToolNames: () => tools,
		getEnabledToolNames: () => tools,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		prompt: async (text: string) => {
			prompts.push(text);
			answer(text, child);
			return true;
		},
		getLastAssistantMessage: () => messages.at(-1),
		getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
	};
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session: session as unknown as AgentSession,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} as CreateAgentSessionResult);
	return { prompts, entries };
}

/** Records the step reports the spawner `Main` receives. */
function spawnerInbox() {
	const send = vi.spyOn(IrcBus.global(), "send").mockResolvedValue({ to: "Main", outcome: "injected" });
	return () => send.mock.calls.map(([message]) => message);
}

describe("runSubprocess stepped spawns", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
		IrcBus.resetGlobalForTests();
	});

	it("sends each step after the previous yield, reports it to the spawner, and returns the last step's result", async () => {
		const harness = stepSession(
			(prompt, child) => child.yield({ status: "success", data: { report: `done ${prompt}` } }),
			["read", "yield"],
		);
		const received = spawnerInbox();

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: PROMPTS[0],
			steps: PROMPTS,
			index: 0,
			id: "steps-structured",
			parentAgentId: "Main",
		});

		expect(harness.prompts).toEqual(PROMPTS);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("done STEP-THREE");
		expect(result.output).not.toContain("done STEP-ONE");
		// Steps one and two reach the spawner, each with only its own yield; step three is the result.
		const reports = received();
		expect(reports).toMatchObject([
			{ from: "steps-structured", to: "Main", progress: true },
			{ from: "steps-structured", to: "Main", progress: true },
		]);
		expect(reports[0].body).toContain("done STEP-ONE");
		expect(reports[1].body).toContain("done STEP-TWO");
		expect(reports[1].body).not.toContain("done STEP-ONE");
		// Restore reads every prompt as sent: nothing is left to resend.
		expect(readStepProgress(harness.entries)).toEqual({ prompts: PROMPTS, sent: PROMPTS.length });
	});

	it("ends the chain on a failed step yield", async () => {
		const harness = stepSession(
			(_prompt, child) => child.yield({ status: "aborted", error: "blocked: schema file missing" }),
			["read", "yield"],
		);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: PROMPTS[0],
			steps: PROMPTS,
			index: 0,
			id: "steps-failed-yield",
		});

		expect(harness.prompts).toEqual([PROMPTS[0]]);
		expect(`${result.output}\n${result.stderr}\n${result.error ?? ""}`).toContain("blocked: schema file missing");
		expect(readStepProgress(harness.entries)?.sent).toBe(1);
	});

	it("without yield, sends the next step after each final message and reports it to the spawner", async () => {
		const harness = stepSession((prompt, child) => child.say(`report ${prompt}`), ["read"]);
		const received = spawnerInbox();

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: PROMPTS[0],
			steps: PROMPTS,
			structured: false,
			index: 0,
			id: "steps-unstructured",
			parentAgentId: "Main",
		});

		expect(harness.prompts).toEqual(PROMPTS);
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("report STEP-THREE");
		expect(received().map(report => report.body)).toEqual([
			expect.stringContaining("report STEP-ONE"),
			expect.stringContaining("report STEP-TWO"),
		]);
	});
});
