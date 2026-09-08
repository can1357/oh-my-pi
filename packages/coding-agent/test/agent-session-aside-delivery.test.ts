import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { IrcBridge, type IrcBridgeHost } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionAdvisors } from "@oh-my-pi/pi-coding-agent/session/session-advisors";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("AgentSession aside delivery", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-aside-delivery-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("an aside delivered mid-run neither aborts the in-flight tool nor waits for the run to end", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];

		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let abortedDuringTool = false;
		let abortSeen = false;

		const slowTool: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Blocks until released",
			parameters: type({}),
			execute: async (_id, _params, signal) => {
				started.resolve();
				abortedDuringTool = signal?.aborted ?? false;
				signal?.addEventListener("abort", () => {
					abortSeen = true;
				});
				await release.promise;
				return { content: [{ type: "text", text: "SLOW_DONE" }] };
			},
		};

		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [slowTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const isFirstCall = callCount === 0;
				callCount++;
				const message: AssistantMessage = isFirstCall
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: "tc-0", name: "slow", arguments: {} }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Done." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: isFirstCall ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[slowTool.name, slowTool]]),
		});

		const run = session.prompt("go");
		await started.promise;

		await session.sendCustomMessage(
			{ customType: "ext-aside", content: "ASIDE_BODY", display: false, attribution: "agent" },
			{ deliverAs: "aside" },
		);

		expect(abortSeen).toBe(false);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);

		release.resolve();
		await run;
		await session.waitForIdle();

		expect(abortedDuringTool).toBe(false);
		expect(JSON.stringify(contexts[1]!.messages)).toContain("SLOW_DONE");
		expect(JSON.stringify(contexts[1]!.messages)).toContain("ASIDE_BODY");
		const asides = session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "ext-aside",
		);
		expect(asides).toHaveLength(1);
	});

	it("sendUserMessage delivered as an aside mid-run injects at the next step boundary without draining agent-core queues", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];

		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();

		const slowTool: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Blocks until released",
			parameters: type({}),
			execute: async () => {
				started.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "SLOW_DONE" }] };
			},
		};

		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [slowTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const isFirstCall = callCount === 0;
				callCount++;
				const message: AssistantMessage = isFirstCall
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: "tc-0", name: "slow", arguments: {} }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Done." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: isFirstCall ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[slowTool.name, slowTool]]),
		});

		const run = session.prompt("go");
		await started.promise;

		await session.sendUserMessage("USER_ASIDE_BODY", { deliverAs: "aside" });

		// Not a steer/follow-up: neither agent-core queue drained the aside, so the tool batch
		// keeps running uninterrupted.
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);
		expect(session.agent.peekFollowUpQueue()).toHaveLength(0);

		release.resolve();
		await run;
		await session.waitForIdle();

		expect(JSON.stringify(contexts[1]!.messages)).toContain("SLOW_DONE");
		expect(JSON.stringify(contexts[1]!.messages)).toContain("USER_ASIDE_BODY");
		const userAsides = session.agent.state.messages.filter(
			message => message.role === "user" && JSON.stringify(message.content).includes("USER_ASIDE_BODY"),
		);
		expect(userAsides).toHaveLength(1);
	});

	it("a user aside stranded past run completion resumes as a wake turn carrying the user text", async () => {
		const modelRegistry = new ModelRegistry(authStorage);
		const started = Promise.withResolvers<void>();
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 60_000 };
				},
				{ content: ["peer reply"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		let observedRecords: unknown[] | undefined;
		session.setIrcWakeTurnObserver(records => {
			observedRecords = records;
			return undefined;
		});

		const run = session.prompt("go");
		await started.promise;
		await session.sendUserMessage("STRANDED_USER_ASIDE", { deliverAs: "aside" });

		// A non-user abort (e.g. an internal mode transition) does not suppress auto-resume like
		// a user Esc does; it just skips the loop's final aside poll on the way out, stranding the
		// aside with no loop left to drain it — exactly the settle race #resumeStrandedIrcAsides /
		// #queueUserMessage's post-queueAside call cover.
		await session.abort({ reason: "internal" });
		await session.waitForIdle();
		await run.catch(() => {});

		expect(observedRecords).toBeDefined();
		expect(JSON.stringify(observedRecords)).toContain("STRANDED_USER_ASIDE");
		const persisted = session.agent.state.messages.some(
			message => message.role === "user" && JSON.stringify(message.content).includes("STRANDED_USER_ASIDE"),
		);
		expect(persisted).toBe(true);
		expect(mock.calls.length).toBe(2);
	});

	it("an idle session receiving an aside starts a turn", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "Acknowledged." }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		const startedTurn = await session.sendCustomMessage(
			{ customType: "ext-aside", content: "IDLE_ASIDE_BODY", display: false, attribution: "agent" },
			{ deliverAs: "aside" },
		);
		await session.waitForIdle();

		expect(startedTurn).toBe(true);
		expect(contexts).toHaveLength(1);
		expect(JSON.stringify(contexts[0]!.messages)).toContain("IDLE_ASIDE_BODY");
	});

	it("a stranded aside queued during an aborted turn does not leak into a fresh session (newSession)", async () => {
		const modelRegistry = new ModelRegistry(authStorage);
		const started = Promise.withResolvers<void>();
		const contexts: Context[] = [];
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 60_000 };
				},
				context => {
					contexts.push(context);
					return { content: ["fresh reply"] };
				},
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		const run = session.prompt("go");
		await started.promise;
		await session.sendUserMessage("LEAK_CANDIDATE_ASIDE", { deliverAs: "aside" });

		// newSession() aborts the run first; the abort skips the loop's final aside poll, so
		// without a clear the queued aside would still be sitting in IrcBridge and would flush
		// into the new session's transcript at the first ordinary prompt below.
		expect(await session.newSession()).toBe(true);
		await run.catch(() => {});
		await session.waitForIdle();

		expect(
			session.agent.state.messages.some(message => JSON.stringify(message).includes("LEAK_CANDIDATE_ASIDE")),
		).toBe(false);

		await session.prompt("ping");
		await session.waitForIdle();

		expect(contexts).toHaveLength(1);
		expect(JSON.stringify(contexts[0]!.messages)).not.toContain("LEAK_CANDIDATE_ASIDE");
	});

	it("a stranded aside queued during an aborted turn does not leak into the target session (switchSession)", async () => {
		const sessionDir = path.join(tempDir.path(), "sessions");
		const modelRegistry = new ModelRegistry(authStorage);
		const started = Promise.withResolvers<void>();
		const contexts: Context[] = [];
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 60_000 };
				},
				context => {
					contexts.push(context);
					return { content: ["target reply"] };
				},
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir.path(), sessionDir),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		const targetManager = SessionManager.create(tempDir.path(), sessionDir);
		targetManager.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
		await targetManager.ensureOnDisk();
		const targetFile = targetManager.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file");
		await targetManager.close();

		const run = session.prompt("go");
		await started.promise;
		await session.sendUserMessage("LEAK_CANDIDATE_ASIDE", { deliverAs: "aside" });

		expect(await session.switchSession(targetFile)).toBe(true);
		await run.catch(() => {});
		await session.waitForIdle();

		expect(
			session.agent.state.messages.some(message => JSON.stringify(message).includes("LEAK_CANDIDATE_ASIDE")),
		).toBe(false);

		await session.prompt("ping");
		await session.waitForIdle();

		expect(contexts).toHaveLength(1);
		expect(JSON.stringify(contexts[0]!.messages)).not.toContain("LEAK_CANDIDATE_ASIDE");
	});

	it("prompt()'s internal streaming re-check queues streamingBehavior 'aside' as a non-interrupting aside, not a steer", async () => {
		// Regression for the race sendUserMessage(..., { deliverAs: "aside" }) hands to prompt():
		// prompt() awaits manual-compaction cleanup / image normalization between its idle
		// observation and dispatch, so a turn can start streaming in that gap. Its internal
		// isStreaming re-check must honor the caller's original "aside" intent (via
		// `streamingBehavior: "aside"`) instead of degrading it into a tool-aborting steer.
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];

		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let abortSeen = false;

		const slowTool: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Blocks until released",
			parameters: type({}),
			execute: async (_id, _params, signal) => {
				started.resolve();
				signal?.addEventListener("abort", () => {
					abortSeen = true;
				});
				await release.promise;
				return { content: [{ type: "text", text: "SLOW_DONE" }] };
			},
		};

		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [slowTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const isFirstCall = callCount === 0;
				callCount++;
				const message: AssistantMessage = isFirstCall
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: "tc-0", name: "slow", arguments: {} }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Done." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: isFirstCall ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[slowTool.name, slowTool]]),
		});

		const run = session.prompt("go");
		await started.promise;

		// Simulates prompt()'s own internal isStreaming re-check landing while the tool is still
		// running — exactly what sendUserMessage's race threads through as streamingBehavior: "aside".
		await session.prompt("RACE_ASIDE_TEXT", {
			expandPromptTemplates: false,
			streamingBehavior: "aside",
		});

		expect(abortSeen).toBe(false);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);

		release.resolve();
		await run;
		await session.waitForIdle();

		expect(JSON.stringify(contexts[1]!.messages)).toContain("SLOW_DONE");
		expect(JSON.stringify(contexts[1]!.messages)).toContain("RACE_ASIDE_TEXT");
	});

	it("#queueCustomMessage resumes a stranded aside instead of leaving it queued with no loop to drain it", async () => {
		// Regression for the race Codex flagged in #queueCustomMessage: it awaits image
		// normalization before calling IrcBridge.queueAside, so the active run can settle to
		// idle during that await. If the queueAside call doesn't also resume stranded asides
		// (as #queueUserMessage's aside branch already does), the record sits in the queue with
		// no loop left to drain it until an unrelated prompt happens to flush it. Exercising
		// promptCustomMessage's queueOnly path (used by main.ts's synthetic-continue queue) on an
		// already-idle session hits the exact same #queueCustomMessage code path this covers.
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "Acknowledged." }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		let observedRecords: unknown[] | undefined;
		session.setIrcWakeTurnObserver(records => {
			observedRecords = records;
			return undefined;
		});

		await session.promptCustomMessage(
			{ customType: "ext-aside", content: "SETTLED_RACE_ASIDE", display: false, attribution: "agent" },
			{ streamingBehavior: "aside", queueOnly: true },
		);
		await session.waitForIdle();

		expect(observedRecords).toBeDefined();
		expect(JSON.stringify(observedRecords)).toContain("SETTLED_RACE_ASIDE");
		expect(contexts).toHaveLength(1);
		expect(JSON.stringify(contexts[0]!.messages)).toContain("SETTLED_RACE_ASIDE");
	});

	it("sendCustomMessage(deliverAs: 'aside') folds into context instead of starting a turn when a user interrupt outlasted normalization", async () => {
		// Regression: this branch is only reached once isStreaming reads false — which can happen
		// either because the session was already idle, or because image normalization above
		// outlasted a user Esc that settled the run in the meantime. The old code treated both
		// cases identically and always started a fresh autonomous turn, undoing a deliberate
		// interrupt. Simulate the second case directly: abort with a user interrupt (which sets
		// autoResumeSuppressed), then send the aside on the now-idle session.
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];

		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const slowTool: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Blocks until released",
			parameters: type({}),
			execute: async (_id, _params, _signal) => {
				started.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "SLOW_DONE" }] };
			},
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [slowTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc-0", name: "slow", arguments: {} }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[slowTool.name, slowTool]]),
		});

		const run = session.prompt("go");
		await started.promise;
		release.resolve();
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await run.catch(() => {});
		await session.waitForIdle();
		contexts.length = 0;

		const dispatched = await session.sendCustomMessage(
			{ customType: "ext-aside", content: "SUPPRESSED_ASIDE", display: false, attribution: "agent" },
			{ deliverAs: "aside" },
		);

		expect(dispatched).toBe(false);
		expect(contexts).toHaveLength(0);
		const persisted = session.agent.state.messages.some(
			message => message.role === "custom" && message.customType === "ext-aside",
		);
		expect(persisted).toBe(true);
	});

	it("sendCustomMessage(deliverAs: 'aside'/'nextTurn') reports false when the agent-initiated turn never dispatches", async () => {
		// Regression: #promptAgentInitiatedMessage used to return void, so its callers hard-coded
		// `return true` unconditionally. If an abort races the usage-aware preflight (which
		// registers an AbortController and captures the prompt generation before its first real
		// await), the helper returns before ever calling agent.prompt — callers that treat the
		// boolean as proof of dispatched agent work (e.g. RPC's hasAgentMessageTask gate) must see
		// `false`, not a stale `true` that leaves them waiting on events that never arrive.
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "Acknowledged." }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		const dispatchedPromise = session.sendCustomMessage(
			{ customType: "ext-aside", content: "PREFLIGHT_RACE_ASIDE", display: false, attribution: "agent" },
			{ deliverAs: "aside" },
		);
		// #beginInFlight() (which flips isStreaming) and the usage-aware preflight's abort
		// controller registration + generation capture run synchronously together with no
		// intervening await; poll until the first observable side effect (isStreaming) confirms
		// that stretch has run, then abort — landing inside the preflight's own first await,
		// exactly the race the fix covers.
		while (!session.isStreaming) {
			await Promise.resolve();
		}
		await session.abort({ reason: "internal" });

		expect(await dispatchedPromise).toBe(false);
		await session.waitForIdle();
		expect(contexts).toHaveLength(0);
	});

	it("IrcBridge.restorePending merges a rolled-back snapshot ahead of records queued during the rollback instead of discarding them", () => {
		// Regression: restorePending used to overwrite the queues wholesale, silently dropping any
		// record queued between clearPending() and restorePending() (e.g. an in-flight IRC
		// auto-reply appending while a rolled-back switchSession's async load/hooks were still
		// running). Exercise the bridge directly with a minimal host stub — the queue ops under
		// test never touch the host.
		const host: IrcBridgeHost = {
			agent: {} as Agent,
			sessionManager: {} as SessionManager,
			settings: {} as Settings,
			isDisposed: () => false,
			isStreaming: () => false,
			planModeEnabled: () => false,
			emitSessionEvent: async () => {},
			wakeForIrc: () => {},
			runEphemeralTurn: async () => ({ replyText: "" }),
		};
		const irc = new IrcBridge(host);

		const original: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "ORIGINAL" }],
			attribution: "user",
			timestamp: Date.now(),
		};
		irc.queueAside([original]);
		const snapshot = irc.clearPending();
		expect(irc.hasPending()).toBe(false);

		// Simulates a record arriving while the rolled-back transition's async work was in flight.
		const duringRollback: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "DURING_ROLLBACK" }],
			attribution: "user",
			timestamp: Date.now(),
		};
		irc.queueAside([duringRollback]);

		irc.restorePending(snapshot);

		const drained = irc.drainPending();
		expect(drained).toHaveLength(2);
		expect(drained[0]).toBe(original);
		expect(drained[1]).toBe(duringRollback);
	});

	it("drops a queued aside whose normalization outlives a concurrent newSession()", async () => {
		// Regression: #queueUserMessage's aside branch used to enqueue into IrcBridge
		// unconditionally after its normalization/vision-description awaits. If a
		// newSession()/switchSession() completes (clearing the queue and, per the earlier
		// stranded-aside fix, discarding whatever was queued at that instant) WHILE this
		// call's own normalization is still in flight, the record lands in the queue only
		// after the clear already ran — leaking the outgoing session's aside into the new
		// session's transcript. Gate normalizeImagesForModel (always awaited, even without
		// images) to force that exact interleaving.
		const modelRegistry = new ModelRegistry(authStorage);
		const started = Promise.withResolvers<void>();
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 60_000 };
				},
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		const run = session.prompt("go");
		await started.promise;

		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});
		try {
			const asidePromise = session.sendUserMessage("GENERATION_RACE_ASIDE", { deliverAs: "aside" });
			await normalizeStarted.promise;

			// The session transition completes (clearing the queue and bumping
			// #sessionGeneration) while the aside above is still gated in normalization.
			await session.newSession();
			await run.catch(() => {});

			releaseNormalize.resolve();
			await asidePromise;
			await session.waitForIdle();

			expect(JSON.stringify(session.agent.state.messages)).not.toContain("GENERATION_RACE_ASIDE");
		} finally {
			normalizeSpy.mockRestore();
		}
	});

	it("routes a custom aside folded in plan mode through the event-emitting path so message_end fires", async () => {
		// Regression: the plan-mode (and adjacent post-Esc-suppression) fold branches in
		// sendCustomMessage used to append directly to agent state + session storage, emitting
		// no message_end. The interactive extension sender skips its own transcript rebuild
		// when the send began while streaming because it expects that event — without it the
		// persisted message stays invisible until an unrelated rebuild. Plan mode is the
		// deterministic way to reach the fold branch without racing a real stream settle.
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: () => new AssistantMessageEventStream(),
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });

		const messageEndTypes: string[] = [];
		const messageEndSeen = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "custom") {
				messageEndTypes.push(event.message.customType);
				messageEndSeen.resolve();
			}
		});

		expect(session.isStreaming).toBe(false);
		const dispatched = await session.sendCustomMessage(
			{ customType: "ext-aside", content: "PLAN_MODE_FOLD_ASIDE", display: true, attribution: "agent" },
			{ deliverAs: "aside" },
		);
		await messageEndSeen.promise;

		expect(dispatched).toBe(false);
		expect(messageEndTypes).toContain("ext-aside");
		const persisted = session.agent.state.messages.some(
			message => message.role === "custom" && message.customType === "ext-aside",
		);
		expect(persisted).toBe(true);
	});

	it("validates the session generation before an idle sendCustomMessage aside dispatch", async () => {
		// Regression: the streaming branch of sendCustomMessage's aside delivery checks
		// #sessionGeneration before enqueueing (#queueCustomMessage), but the idle branch (plan
		// mode fold / post-interrupt fold / #promptAgentInitiatedMessage) never compared its own
		// captured generation. An image attachment whose normalization outlives a concurrent
		// newSession() used to prompt or fold the stale message into the newly created session.
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel({ provider: "openai", id: "gpt-test" });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});
		try {
			expect(session.isStreaming).toBe(false);
			const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
			const dispatched = session.sendCustomMessage(
				{
					customType: "ext-aside",
					content: [{ type: "text", text: "IDLE_GENERATION_ASIDE" }, image],
					display: true,
					attribution: "agent",
				},
				{ deliverAs: "aside" },
			);
			await normalizeStarted.promise;

			await session.newSession();
			releaseNormalize.resolve();

			expect(await dispatched).toBe(false);
			expect(JSON.stringify(session.agent.state.messages)).not.toContain("IDLE_GENERATION_ASIDE");
		} finally {
			normalizeSpy.mockRestore();
		}
	});

	it("does not wake a stranded aside into an agent disconnected by an in-flight newSession()", async () => {
		// Regression: #disconnectFromAgent() runs at the very top of newSession(), well before
		// #sessionGeneration bumps (which happens only after agent.reset() and
		// sessionManager.newSession() complete). A user aside's normalization that resolves in
		// that gap sees an unchanged generation and a non-streaming agent, so
		// #resumeStrandedIrcAsides used to wake a fresh agent.prompt() on the disconnected agent,
		// racing the transition's own reset.
		const modelRegistry = new ModelRegistry(authStorage);
		const started = Promise.withResolvers<void>();
		let callCount = 0;
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses: [
				() => {
					started.resolve();
					callCount++;
					return { content: ["working"], delayMs: 60_000 };
				},
				() => {
					callCount++;
					return { content: ["woken reply"] };
				},
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		const run = session.prompt("go");
		await started.promise;

		const advisorsGateReached = Promise.withResolvers<void>();
		const releaseAdvisorsGate = Promise.withResolvers<void>();
		const originalDrainAndDetachRecorders = SessionAdvisors.prototype.drainAndDetachRecorders;
		const advisorsSpy = spyOn(SessionAdvisors.prototype, "drainAndDetachRecorders").mockImplementation(
			async function (this: SessionAdvisors) {
				advisorsGateReached.resolve();
				await releaseAdvisorsGate.promise;
				return originalDrainAndDetachRecorders.call(this);
			},
		);
		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});

		try {
			const asidePromise = session.sendUserMessage("DISCONNECTED_ASIDE", { deliverAs: "aside" });
			await normalizeStarted.promise;

			const newSessionPromise = session.newSession();
			// #disconnectFromAgent()/abort() have run; agent.reset() and the generation bump have not.
			await advisorsGateReached.promise;

			releaseNormalize.resolve();
			await asidePromise;
			// Flush any fire-and-forget microtask chain a stray #wakeForIrc call would have started
			// (agent.prompt() is invoked asynchronously, not synchronously, from #wakeForIrc).
			for (let i = 0; i < 5; i++) await Promise.resolve();

			expect(callCount).toBe(1);

			releaseAdvisorsGate.resolve();
			expect(await newSessionPromise).toBe(true);
			await run.catch(() => {});
			await session.waitForIdle();

			expect(JSON.stringify(session.agent.state.messages)).not.toContain("DISCONNECTED_ASIDE");
		} finally {
			normalizeSpy.mockRestore();
			advisorsSpy.mockRestore();
		}
	});

	it("preserves a normalized aside across a rolled-back switchSession()", async () => {
		// Regression: the #sessionGeneration guard in #queueUserMessage's aside branch used to
		// discard a record outright on any generation mismatch. switchSession() bumps the
		// generation before its transition and only rolls it back to the exact prior value in its
		// catch block, so a record whose normalization resolved during that window was lost even
		// though the switch ultimately failed and the original session stayed live.
		const sessionDir = path.join(tempDir.path(), "sessions");
		const modelRegistry = new ModelRegistry(authStorage);
		const started = Promise.withResolvers<void>();
		const contexts: Context[] = [];
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 60_000 };
				},
				context => {
					contexts.push(context);
					return { content: ["woken reply"] };
				},
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir.path(), sessionDir),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		const targetManager = SessionManager.create(tempDir.path(), sessionDir);
		targetManager.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
		await targetManager.ensureOnDisk();
		const targetFile = targetManager.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file");
		await targetManager.close();

		const run = session.prompt("go");
		await started.promise;

		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});
		const setSessionFileReached = Promise.withResolvers<void>();
		const releaseSetSessionFileFailure = Promise.withResolvers<void>();
		const setSessionFileSpy = spyOn(SessionManager.prototype, "setSessionFile").mockImplementation(async () => {
			setSessionFileReached.resolve();
			await releaseSetSessionFileFailure.promise;
			throw new Error("forced switchSession failure");
		});

		try {
			const asidePromise = session.sendUserMessage("ROLLBACK_ASIDE", { deliverAs: "aside" });
			await normalizeStarted.promise;

			const switchedPromise = session.switchSession(targetFile);
			// #sessionGeneration has bumped by now; setSessionFile is paused before it fails.
			await setSessionFileReached.promise;

			releaseNormalize.resolve();
			releaseSetSessionFileFailure.resolve();

			await expect(switchedPromise).rejects.toThrow("forced switchSession failure");
			await asidePromise;
			await run.catch(() => {});
			await session.waitForIdle();

			expect(contexts).toHaveLength(1);
			expect(JSON.stringify(contexts[0]!.messages)).toContain("ROLLBACK_ASIDE");
		} finally {
			normalizeSpy.mockRestore();
			setSessionFileSpy.mockRestore();
		}
	});
});
