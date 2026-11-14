import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent, AgentBusyError, type AgentTelemetryConfig, type Tracer } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, Effort } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionActions, LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import {
	AgentSession,
	type AgentSessionEvent,
	type PromptOptions,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	finalizeSubprocessOutput,
	runSubagentFollowUpTurn,
	runSubprocess,
	SUBAGENT_WARNING_EMPTY_MESSAGE,
	SUBAGENT_WARNING_MISSING_YIELD,
} from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { logger } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "../helpers/session-defaults";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

function createAssistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
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

function createMockSession(
	onPrompt: (params: {
		text: string;
		options?: PromptOptions;
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
		state: { messages: AssistantMessage[] };
	}) => void | Promise<void>,
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	let promptIndex = 0;

	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	const session = {
		...createSessionDefaults(),
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string, options?: PromptOptions) => {
			promptIndex += 1;
			await onPrompt({ text, options, promptIndex, emit, state });
			return true;
		},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		hasPendingAsyncWork: () => false,
	};

	return session as unknown as AgentSession;
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

function mockCreateAgentSession(session: AgentSession) {
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
}

function createRealFollowUpSession(handler: MockHandler = { content: ["REVIVED_FINAL"] }) {
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: "mock/mock-model" },
	});
	const mock = createMockModel({ handler });
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(auth, undefined, { settings }),
	});
	return {
		session,
		mock,
		async close() {
			await session.dispose();
			auth.close();
		},
	};
}

describe("runSubprocess yield reminders", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const baseAgent: AgentDefinition = {
		name: "task",
		description: "test",
		systemPrompt: "test",
		source: "bundled",
	};

	const baseOptions = {
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		id: "subagent-1",
		settings: Settings.isolated(),
		modelRegistry: {
			refresh: async () => {},
		} as unknown as import("@oh-my-pi/pi-coding-agent/config/model-registry").ModelRegistry,
		enableLsp: false,
	};

	it("waits for session_start extension user messages before prompting the subagent", async () => {
		let extensionSendUserMessage: ExtensionActions["sendUserMessage"] | undefined;
		let messageInFlight = false;
		let sendStarted = false;

		const session = createMockSession(({ emit }) => {
			if (messageInFlight) {
				throw new AgentBusyError();
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-extension-session-start",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
		const mutableSession = session as unknown as {
			extensionRunner: NonNullable<AgentSession["extensionRunner"]>;
			sendUserMessage: AgentSession["sendUserMessage"];
		};
		mutableSession.sendUserMessage = async () => {
			sendStarted = true;
			messageInFlight = true;
			await Bun.sleep(20);
			messageInFlight = false;
		};
		mutableSession.extensionRunner = {
			initialize: (actions: ExtensionActions) => {
				extensionSendUserMessage = actions.sendUserMessage;
			},
			onError: () => {},
			emit: async (event: { type: string }) => {
				if (event.type === "session_start") {
					extensionSendUserMessage?.("hello from session_start", { deliverAs: "followUp" });
				}
				return undefined;
			},
		} as unknown as NonNullable<AgentSession["extensionRunner"]>;

		mockCreateAgentSession(session);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-session-start-extension",
		});

		expect(sendStarted).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
	});

	it("skips modelRegistry.refresh when reusing the parent registry", async () => {
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-skip-refresh",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
		const createAgentSessionSpy = mockCreateAgentSession(session);
		const modelRegistry = {
			refresh: async () => {},
		} as unknown as import("@oh-my-pi/pi-coding-agent/config/model-registry").ModelRegistry;
		const refreshSpy = vi.spyOn(modelRegistry, "refresh");

		await runSubprocess({ ...baseOptions, id: "subagent-skip-refresh", modelRegistry });

		expect(refreshSpy).not.toHaveBeenCalled();
		expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
	});

	it("appends the per-spawn subagent prompt after the default blocks so the static prefix stays shared", async () => {
		let userPrompt = "";
		const session = createMockSession(({ text, emit }) => {
			userPrompt = text;
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-context-system",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
		const createAgentSessionSpy = mockCreateAgentSession(session);

		await runSubprocess({
			...baseOptions,
			id: "subagent-context-system",
			task: "Your assignment is below.\nBe thorough and complete fully before yielding.\n\nDo the task.",
		});

		const systemPromptBuilder = createAgentSessionSpy.mock.calls[0]?.[0]?.systemPrompt;
		expect(systemPromptBuilder).toBeFunction();
		if (typeof systemPromptBuilder !== "function") throw new Error("Expected system prompt builder");
		const systemPrompt = systemPromptBuilder(["system", "<project-context>\ncwd\n</project-context>"]);

		expect(systemPrompt).toHaveLength(3);
		expect(systemPrompt?.[0]).toBe("system");
		expect(systemPrompt?.[1]).toBe("<project-context>\ncwd\n</project-context>");
		expect(systemPrompt?.[2]).toContain(baseAgent.systemPrompt);
		// The parent-conversation CONTEXT section is gone: subagents get their
		// background inside the assignment (or a local:// file), never a dump.
		expect(systemPrompt?.[2]).not.toMatch(/CONTEXT\n=+/);
		expect(userPrompt).not.toMatch(/CONTEXT\n=+/);
	});
	it("waits out a running turn before installing the pooled contract", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const waiting = Promise.withResolvers<void>();
		const calls: string[] = [];
		const fixture = createRealFollowUpSession(async context => {
			if (JSON.stringify(context.messages.at(-1)).includes("active turn")) {
				entered.resolve();
				await release.promise;
				return { content: ["ACTIVE_FINAL"] };
			}
			return { content: ["BATCH_FINAL"] };
		});
		const wait = fixture.session.waitForDrivenTurnAvailability.bind(fixture.session);
		vi.spyOn(fixture.session, "waitForDrivenTurnAvailability").mockImplementation(() => {
			calls.push("wait");
			waiting.resolve();
			return wait();
		});
		const install = fixture.session.setWorkPoolYieldItems.bind(fixture.session);
		vi.spyOn(fixture.session, "setWorkPoolYieldItems").mockImplementation(items => {
			calls.push("install");
			return install(items);
		});
		vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockResolvedValue(fixture.session);
		let winner: Promise<void> | undefined;
		let driven: Promise<SingleResult> | undefined;
		try {
			winner = fixture.session.agent.prompt("active turn");
			await entered.promise;
			driven = runSubagentFollowUpTurn({
				...baseOptions,
				id: "subagent-prewait",
				message: "batch work",
				structured: false,
			});
			await waiting.promise;
			expect(calls).toEqual(["wait"]);
			release.resolve();
			await winner;
			const result = await driven;
			expect(calls.slice(0, 2)).toEqual(["wait", "install"]);
			expect(result.output).toBe("BATCH_FINAL");
		} finally {
			release.resolve();
			await Promise.allSettled([winner, driven].filter(promise => promise !== undefined));
			await fixture.close();
		}
	});

	it("fails the follow-up after three competing ownership waits", async () => {
		const fixture = createRealFollowUpSession();
		let blocker = fixture.session.tryAcquireDrivenTurn();
		if (!blocker) throw new Error("expected competing lease");
		const wait = fixture.session.waitForDrivenTurnAvailability.bind(fixture.session);
		let waits = 0;
		vi.spyOn(fixture.session, "waitForDrivenTurnAvailability").mockImplementation(async () => {
			const pending = wait();
			queueMicrotask(() => blocker?.release());
			await pending;
			waits++;
			blocker = fixture.session.tryAcquireDrivenTurn();
			if (!blocker) throw new Error("expected next competing lease");
		});
		const install = vi.spyOn(fixture.session, "setWorkPoolYieldItems");
		vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockResolvedValue(fixture.session);
		try {
			await expect(
				runSubagentFollowUpTurn({ ...baseOptions, id: "subagent-wedged", message: "batch work" }),
			).rejects.toThrow("stayed busy through 3 ownership waits");
			expect(waits).toBe(3);
			expect(install).not.toHaveBeenCalled();
		} finally {
			blocker?.release();
			await fixture.close();
		}
	});

	it("drives the reacquired session when parking replaces the worker mid-install", async () => {
		const calls: string[] = [];
		const stale = createRealFollowUpSession();
		const revived = createRealFollowUpSession();
		const staleInstall = stale.session.setWorkPoolYieldItems.bind(stale.session);
		const revivedInstall = revived.session.setWorkPoolYieldItems.bind(revived.session);
		vi.spyOn(stale.session, "setWorkPoolYieldItems").mockImplementation(items => {
			calls.push("stale");
			return staleInstall(items);
		});
		vi.spyOn(revived.session, "setWorkPoolYieldItems").mockImplementation(items => {
			calls.push("revived");
			return revivedInstall(items);
		});
		const ensureLive = vi
			.spyOn(AgentLifecycleManager.global(), "ensureLive")
			.mockResolvedValueOnce(stale.session)
			.mockResolvedValue(revived.session);
		try {
			const result = await runSubagentFollowUpTurn({
				...baseOptions,
				id: "subagent-revive",
				message: "batch work",
				structured: false,
			});
			expect(ensureLive).toHaveBeenCalledTimes(3);
			expect(calls).toEqual(["stale", "revived"]);
			expect(result.output).toBe("REVIVED_FINAL");
			const released = stale.session.tryAcquireDrivenTurn();
			expect(released).toBeDefined();
			released?.release();
		} finally {
			await stale.close();
			await revived.close();
		}
	});

	it("fails fast when parking replaces the worker on every install", async () => {
		const fixtures = Array.from({ length: 4 }, () => createRealFollowUpSession());
		const ensureLive = vi
			.spyOn(AgentLifecycleManager.global(), "ensureLive")
			.mockResolvedValueOnce(fixtures[0]!.session)
			.mockResolvedValueOnce(fixtures[1]!.session)
			.mockResolvedValueOnce(fixtures[2]!.session)
			.mockResolvedValue(fixtures[3]!.session);
		try {
			await expect(
				runSubagentFollowUpTurn({ ...baseOptions, id: "subagent-churn", message: "batch work" }),
			).rejects.toThrow("was replaced during every install attempt");
			expect(ensureLive).toHaveBeenCalledTimes(4);
			for (const fixture of fixtures) {
				const released = fixture.session.tryAcquireDrivenTurn();
				expect(released).toBeDefined();
				released?.release();
			}
		} finally {
			await Promise.all(fixtures.map(fixture => fixture.close()));
		}
	});

	it("waits out a wake running on the replacement worker before reinstalling", async () => {
		const calls: string[] = [];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const waiting = Promise.withResolvers<void>();
		const stale = createRealFollowUpSession();
		const revived = createRealFollowUpSession(async context => {
			if (JSON.stringify(context.messages.at(-1)).includes("wake")) {
				entered.resolve();
				await release.promise;
				return { content: ["WAKE_FINAL"] };
			}
			return { content: ["REVIVED_FINAL"] };
		});
		const staleInstall = stale.session.setWorkPoolYieldItems.bind(stale.session);
		const revivedInstall = revived.session.setWorkPoolYieldItems.bind(revived.session);
		vi.spyOn(stale.session, "setWorkPoolYieldItems").mockImplementation(items => {
			calls.push("stale");
			return staleInstall(items);
		});
		vi.spyOn(revived.session, "setWorkPoolYieldItems").mockImplementation(items => {
			calls.push("revived");
			return revivedInstall(items);
		});
		const wait = revived.session.waitForDrivenTurnAvailability.bind(revived.session);
		vi.spyOn(revived.session, "waitForDrivenTurnAvailability").mockImplementation(() => {
			calls.push("wait");
			waiting.resolve();
			return wait();
		});
		vi.spyOn(AgentLifecycleManager.global(), "ensureLive")
			.mockResolvedValueOnce(stale.session)
			.mockResolvedValue(revived.session);
		let winner: Promise<void> | undefined;
		let driven: Promise<SingleResult> | undefined;
		try {
			winner = revived.session.agent.prompt("wake");
			await entered.promise;
			driven = runSubagentFollowUpTurn({
				...baseOptions,
				id: "subagent-revive-wake",
				message: "batch work",
				structured: false,
			});
			await waiting.promise;
			expect(calls).toEqual(["stale", "wait"]);
			release.resolve();
			await winner;
			const result = await driven;
			expect(calls).toEqual(["stale", "wait", "revived"]);
			expect(result.output).toBe("REVIVED_FINAL");
		} finally {
			release.resolve();
			await Promise.allSettled([winner, driven].filter(promise => promise !== undefined));
			await stale.close();
			await revived.close();
		}
	});
	it("sends reminder prompt when subagent stops without yield", async () => {
		const prompts: string[] = [];
		const promptOptions: Array<PromptOptions | undefined> = [];
		const session = createMockSession(({ text, options, promptIndex, emit, state }) => {
			prompts.push(text);
			promptOptions.push(options);
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage("did some work");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				return;
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { done: true } },
				},
				isError: false,
			});
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess(baseOptions);
		expect(prompts.length).toBe(2);
		expect(promptOptions).toHaveLength(2);
		expect(promptOptions[0]?.attribution).toBe("agent");
		expect(promptOptions[1]?.attribution).toBe("agent");
		expect(result.output).toContain('"done": true');
		expect(result.output.includes("SYSTEM WARNING")).toBe(false);
	});

	it("returns the final message verbatim, with no yield tool or reminders, when unstructured", async () => {
		const report = "## Summary\nAuth lives in `src/auth.ts:10-40`.";
		const prompts: string[] = [];
		const session = createMockSession(({ text, emit, state }) => {
			prompts.push(text);
			const working: AssistantMessage = {
				...createAssistantStopMessage(""),
				content: [
					{ type: "text", text: "Looking at auth first." },
					{ type: "toolCall", id: "tool-read", name: "read", arguments: { path: "src/auth.ts" } },
				],
				stopReason: "toolUse",
			};
			const final = createAssistantStopMessage(report);
			state.messages.push(working, final);
			emit({ type: "message_end", message: working });
			emit({ type: "message_end", message: final });
			emit({ type: "agent_end", messages: [working, final] });
		});
		const createAgentSessionSpy = mockCreateAgentSession(session);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-prose",
			agent: { ...baseAgent, tools: ["read", "yield"] },
			structured: false,
		});

		const sessionOptions = createAgentSessionSpy.mock.calls[0]?.[0];
		expect(sessionOptions?.requireYieldTool).toBe(false);
		expect(sessionOptions?.toolNames).toEqual(["read"]);
		const systemPromptBuilder = sessionOptions?.systemPrompt;
		if (typeof systemPromptBuilder !== "function") throw new Error("Expected system prompt builder");
		expect(systemPromptBuilder(["system"])?.at(-1)).toContain("your final message is your result");
		expect(prompts).toHaveLength(1);
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe(report);
	});

	it("returns only the text after Cursor's last server-resolved tool call", async () => {
		const report = "## Result\nThe auth lookup is complete.";
		const session = createMockSession(({ emit, state }) => {
			const edit = {
				type: "toolCall" as const,
				id: "tool-edit",
				name: "edit",
				arguments: { path: "src/auth.ts" },
				[kCursorExecResolved]: true as const,
			};
			const read = {
				type: "toolCall" as const,
				id: "tool-read",
				name: "read",
				arguments: { path: "src/auth.ts" },
				[kCursorExecResolved]: true as const,
			};
			const final: AssistantMessage = {
				...createAssistantStopMessage(""),
				api: "cursor-agent",
				provider: "cursor",
				content: [{ type: "text", text: "Checking auth." }, edit, read, { type: "text", text: report }],
			};
			state.messages.push(final);
			emit({ type: "message_end", message: final });
			emit({ type: "agent_end", messages: [final] });
		});
		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-cursor-final", structured: false });

		expect(result.exitCode).toBe(0);
		expect(result.output).toBe(report);
	});

	it("rejects prose after a locally runnable tool call in a stop turn", async () => {
		const session = createMockSession(({ emit, state }) => {
			const unfinished = createAssistantStopMessage("");
			unfinished.content = [
				{ type: "toolCall", id: "tool-read", name: "read", arguments: { path: "src/auth.ts" } },
				{ type: "text", text: "The auth lookup is complete." },
			];
			state.messages.push(unfinished);
			emit({ type: "message_end", message: unfinished });
			emit({ type: "agent_end", messages: [unfinished] });
		});
		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-local-tool-prose", structured: false });

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe(SUBAGENT_WARNING_EMPTY_MESSAGE);
	});

	it("fails an unstructured run that ends without a final message", async () => {
		const prompts: string[] = [];
		const session = createMockSession(({ text, emit, state }) => {
			prompts.push(text);
			const empty = createAssistantStopMessage("");
			state.messages.push(empty);
			emit({ type: "message_end", message: empty });
		});
		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-prose-empty", structured: false });

		expect(prompts).toHaveLength(1);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe(SUBAGENT_WARNING_EMPTY_MESSAGE);
	});

	it("keeps null yield warning when subagent submits success without data", async () => {
		const session = createMockSession(({ promptIndex, emit, state }) => {
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage("partial output");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				return;
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-2",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success" },
				},
				isError: false,
			});
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-2" });
		expect(result.output).toContain("SYSTEM WARNING: Subagent called yield with null data.");
	});

	it("finalizes from the reporting turn when the data-less yield lands in its own turn", async () => {
		// The idle reminder instructs a complete subagent to finalize with
		// `type: string` "from last assistant turn". Models comply across two
		// turns: prose report first, then a text-less turn carrying only the bare
		// `yield`. Sampling the salvage text once at end-of-run saw that empty
		// finalize turn, so `useLastTurn` resolved to nothing and the parent got
		// "null data" stapled onto accumulated narration instead of the report
		// (muse-spark-1.3 on the `lumbridge-fixups` subagent).
		const report = "All four tasks done on content/lumbridge-pass; PR #139 updated in place.";
		const session = createMockSession(({ promptIndex, emit, state }) => {
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage(report);
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				return;
			}
			const finalize: AssistantMessage = {
				...createAssistantStopMessage(""),
				content: [{ type: "toolCall", id: "tool-finalize", name: "yield", arguments: { type: "result" } }],
				stopReason: "toolUse",
			};
			state.messages.push(finalize);
			emit({ type: "message_end", message: finalize });
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-finalize",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", type: "result", useLastTurn: true },
				},
				isError: false,
			});
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-last-turn-finalize" });
		expect(result.output).toBe(report);
		expect(result.output).not.toContain("SYSTEM WARNING");
	});

	it("never harvests mid-work narration as the final result", async () => {
		// Counterpart to the test above: the report turn is the one that started
		// no further work. A turn that narrated and then called a tool is mid-run
		// chatter, so a later data-less finalize must NOT harvest it — handing the
		// parent a stale fragment as the subagent's answer is worse than saying
		// the report is missing.
		const narration = "Checking the failing test first.";
		const session = createMockSession(({ promptIndex, emit, state }) => {
			if (promptIndex === 1) {
				const working: AssistantMessage = {
					...createAssistantStopMessage(""),
					content: [
						{ type: "text", text: narration },
						{ type: "toolCall", id: "tool-bash", name: "bash", arguments: { command: "bun test" } },
					],
					stopReason: "toolUse",
				};
				state.messages.push(working);
				emit({ type: "message_end", message: working });
				return;
			}
			const finalize: AssistantMessage = {
				...createAssistantStopMessage(""),
				content: [{ type: "toolCall", id: "tool-bare", name: "yield", arguments: { type: "result" } }],
				stopReason: "toolUse",
			};
			state.messages.push(finalize);
			emit({ type: "message_end", message: finalize });
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-bare",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", type: "result", useLastTurn: true },
				},
				isError: false,
			});
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-no-stale-harvest" });
		expect(result.output).toContain("SYSTEM WARNING: Subagent called yield with null data.");
		expect(result.output).not.toBe(narration);
	});

	it("invalidates an earlier report turn once the subagent resumes work", async () => {
		// The reminder's option 1 is "resume work", so a prose-only idle turn is
		// routinely followed by more tool calls. Skipping the capture on those
		// turns is not enough — the earlier prose must be invalidated, or a
		// text-less finalize many turns later harvests a report written before
		// all that work and passes it off as the completed result (PR #11746
		// review).
		const staleReport = "Everything is done; nothing left to change.";
		const session = createMockSession(({ promptIndex, emit, state }) => {
			if (promptIndex === 1) {
				const reporting = createAssistantStopMessage(staleReport);
				state.messages.push(reporting);
				emit({ type: "message_end", message: reporting });
				return;
			}
			if (promptIndex === 2) {
				const resumed: AssistantMessage = {
					...createAssistantStopMessage(""),
					content: [
						{ type: "text", text: "Actually one more fix." },
						{ type: "toolCall", id: "tool-resume", name: "bash", arguments: { command: "bun test" } },
					],
					stopReason: "toolUse",
				};
				state.messages.push(resumed);
				emit({ type: "message_end", message: resumed });
				return;
			}
			const finalize: AssistantMessage = {
				...createAssistantStopMessage(""),
				content: [{ type: "toolCall", id: "tool-late", name: "yield", arguments: { type: "result" } }],
				stopReason: "toolUse",
			};
			state.messages.push(finalize);
			emit({ type: "message_end", message: finalize });
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-late",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", type: "result", useLastTurn: true },
				},
				isError: false,
			});
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-resumed-work" });
		expect(result.output).toContain("SYSTEM WARNING: Subagent called yield with null data.");
		expect(result.output).not.toBe(staleReport);
	});

	it("retries when yield tool returns an error before succeeding", async () => {
		const prompts: string[] = [];
		const session = createMockSession(({ text, promptIndex, emit, state }) => {
			prompts.push(text);
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage("attempted yield");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-error",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Output does not match schema" }],
						details: { status: "error", error: "Output does not match schema" },
					},
					isError: true,
				});
				return;
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-success",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-err-then-success" });
		expect(prompts).toHaveLength(2);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('"ok": true');
	});

	it("fails instead of waiting forever when yield submit errors repeat", async () => {
		const promptReleased = Promise.withResolvers<void>();
		let yieldAttempts = 0;
		let abortCalls = 0;
		const session = createMockSession(async ({ emit, state }) => {
			for (let attempt = 1; attempt <= 6; attempt++) {
				const assistant = createAssistantStopMessage(`malformed yield attempt ${attempt}`);
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				emit({
					type: "tool_execution_end",
					toolCallId: `tool-malformed-${attempt}`,
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "result must be an object containing either data or error" }],
						details: { status: "error", error: "result must be an object containing either data or error" },
					},
					isError: true,
				});
				yieldAttempts = attempt;
			}
			await promptReleased.promise;
		});
		const abortableSession = session as unknown as { abort: () => Promise<void> };
		abortableSession.abort = async () => {
			abortCalls += 1;
			promptReleased.resolve();
		};

		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-repeated-malformed-yield" });
		expect(result.exitCode).toBe(1);
		expect(result.aborted).toBe(false);
		expect(result.stderr).toContain("Subagent submitted invalid yield results 6 times");
		expect(result.stderr).toContain("stopping to avoid an infinite submit loop");
		expect(result.stderr).toContain("result must be an object containing either data or error");
		expect(result.error).toBe(result.stderr);
		expect(yieldAttempts).toBe(6);
		expect(abortCalls).toBe(1);
	});

	it("ignores malformed yield siblings after a valid yield", async () => {
		const promptReleased = Promise.withResolvers<void>();
		let abortCalls = 0;
		const session = createMockSession(async ({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-valid",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
			for (let attempt = 1; attempt <= 6; attempt++) {
				emit({
					type: "tool_execution_end",
					toolCallId: `tool-malformed-sibling-${attempt}`,
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "result must be an object containing either data or error" }],
						details: { status: "error", error: "result must be an object containing either data or error" },
					},
					isError: true,
				});
			}
			await promptReleased.promise;
		});
		const abortableSession = session as unknown as { abort: () => Promise<void> };
		abortableSession.abort = async () => {
			abortCalls += 1;
			promptReleased.resolve();
		};

		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-valid-yield-with-bad-siblings" });
		expect(result.exitCode).toBe(0);
		expect(result.aborted).toBe(false);
		expect(result.output).toContain('"ok": true');
		expect(result.stderr).toBe("");
		expect(result.error).toBeUndefined();
		expect(abortCalls).toBe(1);
	});

	it("fails when malformed yields repeat after an incremental yield section", async () => {
		const promptReleased = Promise.withResolvers<void>();
		let abortCalls = 0;
		const session = createMockSession(async ({ emit, state }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-incremental",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Section recorded." }],
					details: { status: "success", data: { note: "partial" }, type: ["section"] },
				},
				isError: false,
			});
			for (let attempt = 1; attempt <= 6; attempt++) {
				const assistant = createAssistantStopMessage(`malformed terminal yield attempt ${attempt}`);
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				emit({
					type: "tool_execution_end",
					toolCallId: `tool-malformed-after-incremental-${attempt}`,
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "result must be an object containing either data or error" }],
						details: { status: "error", error: "result must be an object containing either data or error" },
					},
					isError: true,
				});
			}
			await promptReleased.promise;
		});
		const abortableSession = session as unknown as { abort: () => Promise<void> };
		abortableSession.abort = async () => {
			abortCalls += 1;
			promptReleased.resolve();
		};

		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-incremental-then-malformed-yield" });
		expect(result.exitCode).toBe(1);
		expect(result.aborted).toBe(false);
		expect(result.stderr).toContain("Subagent submitted invalid yield results 6 times");
		expect(abortCalls).toBe(1);
	});
	it("waits for yield-triggered abort cleanup before resolving the subagent", async () => {
		const promptCleanup = Promise.withResolvers<void>();
		const abortCleanup = Promise.withResolvers<void>();
		const validYieldEmitted = Promise.withResolvers<void>();
		let abortCalls = 0;
		const session = createMockSession(async ({ promptIndex, emit, state }) => {
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage("malformed yield attempt");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-malformed",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "result must be an object containing either data or error" }],
						details: { status: "error", error: "result must be an object containing either data or error" },
					},
					isError: true,
				});
				return;
			}

			emit({
				type: "tool_execution_end",
				toolCallId: "tool-success-after-malformed",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
			validYieldEmitted.resolve();
			await promptCleanup.promise;
		});
		(session as unknown as { abort: () => Promise<void> }).abort = async () => {
			abortCalls += 1;
			promptCleanup.resolve();
			await abortCleanup.promise;
		};

		mockCreateAgentSession(session);

		let settled = false;
		const resultPromise = runSubprocess({ ...baseOptions, id: "subagent-yield-abort-cleanup" }).finally(() => {
			settled = true;
		});

		await validYieldEmitted.promise;
		await Bun.sleep(20);
		expect(abortCalls).toBe(1);
		expect(settled).toBe(false);

		abortCleanup.resolve();
		const result = await resultPromise;
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('"ok": true');
	});

	it("keeps a real run failure from being masked by a successful yield", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "partial output",
			exitCode: 1,
			stderr: "Provider returned error finish_reason",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data: { ok: true } }],
			outputSchema: undefined,
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("Provider returned error finish_reason");
		expect(result.rawOutput).toContain('"ok": true');
	});

	it("lets a valid yield clear internal termination without stderr", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 1,
			stderr: "",
			doneAborted: true,
			signalAborted: false,
			yieldItems: [{ status: "success", data: { ok: true } }],
			outputSchema: undefined,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.rawOutput).toContain('"ok": true');
	});
	it("uses provided thinking level when model override has no explicit suffix", async () => {
		vi.clearAllMocks();
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-thinking-fallback",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		const createAgentSessionSpy = mockCreateAgentSession(session);

		const modelRegistry = {
			refresh: async () => {},
			getAvailable: () => [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }],
		} as unknown as import("@oh-my-pi/pi-coding-agent/config/model-registry").ModelRegistry;

		await runSubprocess({
			...baseOptions,
			id: "subagent-thinking-fallback",
			modelOverride: "openai/gpt-4o",
			thinkingLevel: Effort.High,
			modelRegistry,
		});

		expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
		expect(createAgentSessionSpy.mock.calls[0]?.[0]?.thinkingLevel).toBe(Effort.High);
	});
	it("fails after 3 reminders when yield is never called for a structured task", async () => {
		const prompts: string[] = [];
		const session = createMockSession(({ text, promptIndex, emit, state }) => {
			prompts.push(text);
			const assistant = createAssistantStopMessage(promptIndex === 1 ? "did work" : "still no yield");
			state.messages.push(assistant);
			emit({ type: "message_end", message: assistant });
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-3",
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});
		expect(prompts).toHaveLength(4);
		expect(result.exitCode).toBe(1);
		expect(result.aborted).toBe(false);
		expect(result.stderr).toBe(SUBAGENT_WARNING_MISSING_YIELD);
		expect(result.abortReason).toBeUndefined();
	});

	it("surfaces abort reason when yield reports aborted status", async () => {
		const session = createMockSession(({ promptIndex, emit, state }) => {
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage("cannot proceed");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-abort",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Task aborted: blocked by permissions" }],
					details: { status: "aborted", error: "blocked by permissions" },
				},
				isError: false,
			});
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-aborted-yield" });
		expect(result.aborted).toBe(true);
		expect(result.abortReason).toBe("blocked by permissions");
	});

	it("marks pre-aborted subprocess with a concrete reason", async () => {
		const abortController = new AbortController();
		abortController.abort("caller cancelled task");

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-cancelled-before-start",
			signal: abortController.signal,
		});

		expect(result.aborted).toBe(true);
		expect(result.abortReason).toBe("Cancelled before start");
		expect(result.stderr).toBe("Cancelled before start");
	});

	it("attributes a failed assistant turn with its resolved provider and model", async () => {
		const session = createMockSession(({ emit, state }) => {
			const failed: AssistantMessage = {
				...createAssistantStopMessage(""),
				stopReason: "error",
				errorMessage: "Connect error invalid_argument: Error",
			};
			state.messages.push(failed);
			emit({ type: "message_end", message: failed });
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-provider-error" });

		expect(result.exitCode).toBe(1);
		expect(result.error).toBe("[openai/mock] Connect error invalid_argument: Error");
		expect(result.stderr).toBe("[openai/mock] Connect error invalid_argument: Error");
	});

	it("surfaces the assistant abort message instead of 'Cancelled by caller' on an internal turn abort", async () => {
		// No caller signal and no runtime limit: the subagent's own turn ended with
		// stopReason "aborted" (e.g. a merged request-signal abort). abortReason is
		// undefined, so the executor must report the assistant's real errorMessage,
		// not the generic caller-cancellation fallback. This is also what the eval
		// agent() bridge re-raises, so a blank/misleading reason here surfaces as an
		// opaque "bridge call '__agent__' failed".
		const session = createMockSession(({ emit, state }) => {
			const aborted: AssistantMessage = {
				...createAssistantStopMessage(""),
				stopReason: "aborted",
				errorMessage: "Request was aborted",
			};
			state.messages.push(aborted);
			emit({ type: "message_end", message: aborted });
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-internal-abort" });

		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toBe("Request was aborted");
		expect(result.abortReason).not.toBe("Cancelled by caller");
		expect(result.error).toBeUndefined();
		expect(result.stderr).toBe("");
	});
	it("uses modelRegistry.authStorage when only options.modelRegistry is provided", async () => {
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-registry-only",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
		const createAgentSessionSpy = mockCreateAgentSession(session);
		const fakeAuthStorage = { sentinel: "registry-storage" } as unknown as AuthStorage;
		const modelRegistry = {
			authStorage: fakeAuthStorage,
			refresh: async () => {},
		} as unknown as import("@oh-my-pi/pi-coding-agent/config/model-registry").ModelRegistry;

		await runSubprocess({ ...baseOptions, id: "subagent-registry-only", modelRegistry });

		expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
		expect(createAgentSessionSpy.mock.calls[0]?.[0]?.authStorage).toBe(fakeAuthStorage);
	});

	it("rejects when options.authStorage and options.modelRegistry.authStorage are different instances", async () => {
		// Mismatch fails via runSubprocess's standard catch path (exitCode=1 + stderr), not a thrown promise.
		const createAgentSessionSpy = vi.spyOn(sdkModule, "createAgentSession");
		const registryStorage = { sentinel: "registry" } as unknown as AuthStorage;
		const otherStorage = { sentinel: "other" } as unknown as AuthStorage;
		const modelRegistry = {
			authStorage: registryStorage,
			refresh: async () => {},
		} as unknown as import("@oh-my-pi/pi-coding-agent/config/model-registry").ModelRegistry;

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-mismatch",
			authStorage: otherStorage,
			modelRegistry,
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/options\.authStorage.*modelRegistry\.authStorage/);
		expect(createAgentSessionSpy).not.toHaveBeenCalled();
	});

	it("logs reminder-loop aborts at debug, not error (issue #1623)", async () => {
		// Repro: user ^C or compaction aborts pending operations while the
		// yield-reminder loop is awaiting session.prompt. awaitAbortable rejects
		// with ToolAbortError, which previously surfaced as logger.error and
		// polluted operator dashboards.
		const abortController = new AbortController();
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		const session = createMockSession(({ promptIndex, emit, state }) => {
			if (promptIndex === 1) {
				// Initial prompt: stop without yielding so the reminder loop kicks in.
				const assistant = createAssistantStopMessage("no yield yet");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				return;
			}
			// Reminder prompt: abort the run while it is in flight. The follow-up
			// awaitAbortable(session.waitForIdle()) then throws ToolAbortError into
			// the catch we are guarding.
			abortController.abort();
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-abort-during-reminder",
			signal: abortController.signal,
		});

		expect(result.aborted).toBe(true);
		expect(errorSpy).not.toHaveBeenCalledWith("Subagent prompt failed", expect.anything());
		expect(debugSpy).toHaveBeenCalledWith("Subagent prompt aborted");
	});
});

describe("runSubprocess telemetry propagation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const baseAgent: AgentDefinition = {
		name: "reviewer",
		description: "code review specialist",
		systemPrompt: "you are a reviewer",
		source: "bundled",
	};

	const baseOptions = {
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		id: "subagent-telemetry",
		settings: Settings.isolated(),
		modelRegistry: {
			refresh: async () => {},
		} as unknown as import("@oh-my-pi/pi-coding-agent/config/model-registry").ModelRegistry,
		enableLsp: false,
	};

	function buildSession() {
		return createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-telemetry",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
	}

	it("derives subagent telemetry from parent: keeps tracer/hooks, swaps agent identity, clears conversationId", async () => {
		const createAgentSessionSpy = mockCreateAgentSession(buildSession());
		const onSpanStart = () => {};
		const onSpanEnd = () => {};
		const costEstimator = () => undefined;
		const tracer = { startSpan: () => undefined } as unknown as Tracer;
		const parentTelemetry: AgentTelemetryConfig = {
			tracer,
			captureMessageContent: true,
			attributes: { "deployment.id": "prod" },
			agent: { id: "0-Main", name: "main", description: "primary agent" },
			conversationId: "parent-conversation",
			onSpanStart,
			onSpanEnd,
			costEstimator,
		};

		await runSubprocess({ ...baseOptions, id: "subagent-telemetry-derive", parentTelemetry });

		expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
		const forwarded = createAgentSessionSpy.mock.calls[0]?.[0]?.telemetry;
		expect(forwarded).toBeDefined();
		if (!forwarded) throw new Error("expected telemetry on createAgentSession call");
		expect(forwarded.tracer).toBe(tracer);
		expect(forwarded.captureMessageContent).toBe(true);
		expect(forwarded.attributes).toEqual({ "deployment.id": "prod" });
		expect(forwarded.onSpanStart).toBe(onSpanStart);
		expect(forwarded.onSpanEnd).toBe(onSpanEnd);
		expect(forwarded.costEstimator).toBe(costEstimator);
		expect(forwarded.agent).toEqual({
			id: "subagent-telemetry-derive",
			name: baseAgent.name,
			description: baseAgent.description,
		});
		// Child loop falls back to its own session id for gen_ai.conversation.id.
		expect(forwarded.conversationId).toBeUndefined();
	});

	it("forwards no telemetry when the parent has none", async () => {
		const createAgentSessionSpy = mockCreateAgentSession(buildSession());

		await runSubprocess({ ...baseOptions, id: "subagent-telemetry-none" });

		expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
		expect(createAgentSessionSpy.mock.calls[0]?.[0]?.telemetry).toBeUndefined();
	});
});
