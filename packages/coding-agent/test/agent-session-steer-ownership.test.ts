/**
 * Steer admission must follow run ownership: a `joinActiveTurn` steer may only
 * inject into a run claimed by a client prompt dispatch (`session.prompt`) or a
 * continuation of that turn (recovery retry, compaction length-stop retry, text
 * rule retry, or a code-rule retry checked before a tool runs). An autonomous
 * run — a queued-hidden drain, a background turn's retry — streaming while a
 * client prompt is still dispatching must never swallow the steer: it parks
 * until the client's own run goes live, and refuses when the dispatch settles
 * first.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { CustomMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as piUtils from "@oh-my-pi/pi-utils";

const withTimeout = piUtils.withTimeout;

/** Retriable terminal error (503 overload): the turn's automatic retry backs
 *  off briefly and claims again. */
const OVERLOADED_RETRYABLE = "503 service unavailable: overloaded_error";

function emptyStop(): MockResponse {
	return { content: [], stopReason: "stop" };
}

function userIndexContaining(messages: readonly AgentMessage[], text: string): number {
	return messages.findIndex(message => message.role === "user" && JSON.stringify(message.content).includes(text));
}

function assistantIndexContaining(messages: readonly AgentMessage[], text: string): number {
	return messages.findIndex(message => message.role === "assistant" && JSON.stringify(message.content).includes(text));
}

function deferredBackgroundMessage(): CustomMessage {
	return {
		role: "custom",
		customType: "background",
		content: "do background work",
		display: false,
		timestamp: Date.now(),
	};
}

describe("AgentSession steer run ownership", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	const restores: Array<() => void> = [];

	afterEach(async () => {
		for (const restore of restores.splice(0)) restore();
		await session?.dispose();
		authStorage?.close();
	});

	async function createSession(
		responses: Array<() => MockResponse | Promise<MockResponse>>,
		options: {
			/** Per-call session-level key resolution (call numbers start at 1). */
			getApiKey?: (call: number) => string | undefined | Promise<string | undefined>;
			settings?: Record<string, unknown>;
			ttsrManager?: TtsrManager;
			/** Identity stamped on mock responses; compaction recovery requires it to match the session model. */
			mockIdentity?: { provider: string; id: string };
			tools?: AgentTool[];
		} = {},
	) {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const mock = createMockModel({ responses, ...options.mockIdentity });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: bundled, systemPrompt: ["Test"], tools: options.tools ?? [] },
			streamFn: mock.stream,
		});
		const modelRegistry = new ModelRegistry(authStorage);
		if (options.getApiKey) {
			const resolve = options.getApiKey;
			let calls = 0;
			const spy = spyOn(modelRegistry, "getApiKey").mockImplementation(async () => await resolve(++calls));
			restores.push(() => spy.mockRestore());
		}
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": false,
				"retry.baseDelayMs": 50,
				...options.settings,
			}),
			modelRegistry,
			...(options.ttsrManager ? { ttsrManager: options.ttsrManager } : {}),
		});
		return { session, mock };
	}

	function waitForSessionEvent(match: (event: AgentSessionEvent) => boolean): Promise<void> {
		if (!session) throw new Error("Session not created yet");
		const { promise, resolve } = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (match(event)) {
				unsubscribe();
				resolve();
			}
		});
		return promise;
	}

	/** Starts the client prompt and parks it inside dispatch setup at its gated
	 *  key lookup: in flight (its bracket raised), its run not claimed yet. The
	 *  gated key is the FIRST session-level key lookup; the drain's own lookups
	 *  (later call numbers) resolve immediately. */
	function parkClientPromptInSetup(clientSession: AgentSession, keyRequested: Promise<void>) {
		const promptDone = clientSession.prompt("client question");
		void promptDone.catch(() => undefined);
		return {
			promptDone,
			parked: withTimeout(keyRequested, 2_000, "Client prompt never reached key validation"),
		};
	}

	/** Proves `steer` neither admitted nor refused within a beat. */
	async function expectParked(steer: Promise<boolean>): Promise<void> {
		await Bun.sleep(30);
		let settled = false;
		void steer.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await Bun.sleep(30);
		expect(settled).toBe(false);
		if (!session) throw new Error("Session gone");
		expect(session.getQueuedMessages().steering).toEqual([]);
	}

	it("parks a steer behind a queued-hidden drain until the owning client prompt claims its own run", async () => {
		const drainStarted = Promise.withResolvers<void>();
		const releaseDrain = Promise.withResolvers<void>();
		const keyRequested = Promise.withResolvers<void>();
		const keyGate = Promise.withResolvers<void>();
		const { session } = await createSession(
			[
				async () => {
					drainStarted.resolve();
					await releaseDrain.promise;
					return { content: ["background drain done"] };
				},
				() => ({ content: ["client first answer"] }),
				() => ({ content: ["steer answer"] }),
			],
			{
				getApiKey: call =>
					call === 1 ? (keyRequested.resolve(), keyGate.promise.then(() => "test-key")) : "test-key",
			},
		);

		// The client prompt enters dispatch setup and parks at its gated key
		// lookup: in flight, its run not claimed yet.
		const { promptDone, parked } = parkClientPromptInSetup(session, keyRequested.promise);
		await parked;

		// A deferred hidden message starts its own turn (the queued-hidden
		// drain) while the client prompt is still dispatching: an autonomous
		// run with no client forwarder.
		session.queueDeferredMessage(deferredBackgroundMessage());
		await withTimeout(drainStarted.promise, 2_000, "Queued-hidden drain never streamed");
		expect(session.agent.state.isStreaming).toBe(true);

		// The steer must park instead of injecting into the drain.
		const steer = session.joinActiveTurn("steer the client turn");
		await expectParked(steer);

		// The drain settles and the client prompt leaves setup, busy-waits, and
		// claims its own run — the parked steer admits into THAT run and is
		// answered by it.
		releaseDrain.resolve();
		keyGate.resolve();
		expect(await steer).toBe(true);
		await promptDone;
		await session.waitForIdle();

		const messages = session.agent.state.messages;
		const drainAnswer = assistantIndexContaining(messages, "background drain done");
		const steerMessage = userIndexContaining(messages, "steer the client turn");
		const steerAnswer = assistantIndexContaining(messages, "steer answer");
		expect(drainAnswer).toBeGreaterThanOrEqual(0);
		expect(steerMessage).toBeGreaterThan(drainAnswer);
		expect(steerAnswer).toBeGreaterThan(steerMessage);
	});

	it("refuses a steer whose owning prompt fails in setup while an autonomous run owns the stream", async () => {
		const drainStarted = Promise.withResolvers<void>();
		const releaseDrain = Promise.withResolvers<void>();
		const keyRequested = Promise.withResolvers<void>();
		const keyGate = Promise.withResolvers<void>();
		const { session } = await createSession(
			[
				async () => {
					drainStarted.resolve();
					await releaseDrain.promise;
					return { content: ["background drain done"] };
				},
			],
			{
				getApiKey: call =>
					call === 1 ? (keyRequested.resolve(), keyGate.promise.then(() => undefined)) : "test-key",
			},
		);

		const { promptDone, parked } = parkClientPromptInSetup(session, keyRequested.promise);
		await parked;
		session.queueDeferredMessage(deferredBackgroundMessage());
		await withTimeout(drainStarted.promise, 2_000, "Queued-hidden drain never streamed");

		// The steer parks (the only streaming run is the autonomous drain). The
		// owning prompt then fails in setup — its run never went live — so the
		// parked steer refuses and the caller keeps its content.
		const admitted = session.joinActiveTurn("steer the failing prompt");
		keyGate.resolve();
		await expect(promptDone).rejects.toThrow("No API key found");
		expect(await admitted).toBe(false);

		releaseDrain.resolve();
		await session.waitForIdle();
		expect(session.getQueuedMessages().steering).toEqual([]);
		expect(userIndexContaining(session.agent.state.messages, "steer the failing prompt")).toBe(-1);
	});

	it("parks a steer behind a background turn's retry, which never inherits the client owner", async () => {
		const retryStarted = Promise.withResolvers<void>();
		const releaseRetry = Promise.withResolvers<void>();
		const keyRequested = Promise.withResolvers<void>();
		const keyGate = Promise.withResolvers<void>();
		const { session } = await createSession(
			[
				() => ({ throw: OVERLOADED_RETRYABLE }),
				async () => {
					retryStarted.resolve();
					await releaseRetry.promise;
					return { content: ["background retry done"] };
				},
				() => ({ content: ["client first answer"] }),
				() => ({ content: ["steer answer"] }),
			],
			{
				getApiKey: call =>
					call === 1 ? (keyRequested.resolve(), keyGate.promise.then(() => "test-key")) : "test-key",
			},
		);
		const retryScheduled = waitForSessionEvent(event => event.type === "auto_retry_start");

		const { promptDone, parked } = parkClientPromptInSetup(session, keyRequested.promise);
		await parked;

		// The deferred drain turn fails retriablely; its automatic retry is an
		// autonomous successor of an autonomous turn.
		session.queueDeferredMessage(deferredBackgroundMessage());
		await withTimeout(retryScheduled, 4_000, "Background retry never scheduled");

		// The retry claims and streams while the client prompt is still
		// dispatching behind it.
		await withTimeout(retryStarted.promise, 4_000, "Background retry never streamed");
		expect(session.agent.state.isStreaming).toBe(true);

		// The steer must park: the retry did not inherit the dispatching client
		// prompt's ownership from the turn it retries.
		const steer = session.joinActiveTurn("steer the client turn");
		await expectParked(steer);

		// The retry settles and the client prompt claims its own run — the
		// parked steer admits into THAT run.
		releaseRetry.resolve();
		keyGate.resolve();
		expect(await steer).toBe(true);
		await promptDone;
		await session.waitForIdle();

		const messages = session.agent.state.messages;
		const retryAnswer = assistantIndexContaining(messages, "background retry done");
		const steerMessage = userIndexContaining(messages, "steer the client turn");
		const steerAnswer = assistantIndexContaining(messages, "steer answer");
		expect(retryAnswer).toBeGreaterThanOrEqual(0);
		expect(steerMessage).toBeGreaterThan(retryAnswer);
		expect(steerAnswer).toBeGreaterThan(steerMessage);
	});

	it("admits a steer into the client prompt's own empty-stop retry", async () => {
		const retryStarted = Promise.withResolvers<void>();
		const releaseRetry = Promise.withResolvers<void>();
		const { session } = await createSession([
			() => emptyStop(),
			async () => {
				retryStarted.resolve();
				await releaseRetry.promise;
				return { content: ["retry answer"] };
			},
			() => ({ content: ["steer answer"] }),
		]);

		const promptDone = session.prompt("client question");
		await withTimeout(retryStarted.promise, 2_000, "Empty-stop retry never streamed");
		expect(session.agent.state.isStreaming).toBe(true);

		// The retry inherited the client prompt's owner, so a steer arriving
		// while it streams admits immediately — it never parks or refuses.
		expect(await session.joinActiveTurn("steer the client retry")).toBe(true);

		releaseRetry.resolve();
		await promptDone;
		await session.waitForIdle();

		const messages = session.agent.state.messages;
		const retryAnswer = assistantIndexContaining(messages, "retry answer");
		const steerMessage = userIndexContaining(messages, "steer the client retry");
		const steerAnswer = assistantIndexContaining(messages, "steer answer");
		expect(retryAnswer).toBeGreaterThanOrEqual(0);
		expect(steerMessage).toBeGreaterThan(retryAnswer);
		expect(steerAnswer).toBeGreaterThan(steerMessage);
	});

	it("admits a steer into the client prompt's length-stop compaction retry", async () => {
		const retryStarted = Promise.withResolvers<void>();
		const releaseRetry = Promise.withResolvers<void>();
		const { session } = await createSession(
			[
				() => ({ content: [], stopReason: "length" }),
				async () => {
					retryStarted.resolve();
					await releaseRetry.promise;
					return { content: ["continued after length stop"] };
				},
				() => ({ content: ["steer answer"] }),
			],
			{
				settings: { "compaction.enabled": true, "contextPromotion.enabled": false },
				mockIdentity: { provider: "anthropic", id: "claude-sonnet-4-5" },
			},
		);

		const promptDone = session.prompt("client question");
		await withTimeout(retryStarted.promise, 4_000, "Length-stop retry never streamed");
		expect(session.agent.state.isStreaming).toBe(true);

		// The compaction retry continues the client's turn, so a steer joins it
		// instead of waiting until the prompt ends and then being refused.
		expect(await withTimeout(session.joinActiveTurn("steer the length retry"), 1_000, "steer parked")).toBe(true);

		releaseRetry.resolve();
		await promptDone;
		await session.waitForIdle();
		const messages = session.agent.state.messages;
		expect(assistantIndexContaining(messages, "continued after length stop")).toBeGreaterThanOrEqual(0);
		expect(userIndexContaining(messages, "steer the length retry")).toBeGreaterThanOrEqual(0);
		expect(assistantIndexContaining(messages, "steer answer")).toBeGreaterThan(
			userIndexContaining(messages, "steer the length retry"),
		);
	});

	it("admits a steer into the client prompt's rule-triggered retry", async () => {
		const ttsrManager = new TtsrManager({ enabled: true, interruptMode: "always" });
		const rule: Rule = {
			name: "no-unwrap",
			path: "/tmp/no-unwrap.md",
			content: "Do not use .unwrap()",
			condition: ["\\.unwrap\\("],
			interruptMode: "always",
			_source: { provider: "test", providerName: "test", path: "/tmp/no-unwrap.md", level: "project" },
		};
		ttsrManager.addRule(rule);
		const retryStarted = Promise.withResolvers<void>();
		const releaseRetry = Promise.withResolvers<void>();
		const { session } = await createSession(
			[
				() => ({ content: ["let val = result.unwrap("] }),
				async () => {
					retryStarted.resolve();
					await releaseRetry.promise;
					return { content: ["fixed the unwrap"] };
				},
				() => ({ content: ["steer answer"] }),
			],
			{ ttsrManager },
		);

		const promptDone = session.prompt("write some rust");
		await withTimeout(retryStarted.promise, 4_000, "Rule retry never streamed");
		expect(session.agent.state.isStreaming).toBe(true);

		expect(await withTimeout(session.joinActiveTurn("steer the rule retry"), 1_000, "steer parked")).toBe(true);

		releaseRetry.resolve();
		await promptDone;
		await session.waitForIdle();
		const messages = session.agent.state.messages;
		expect(assistantIndexContaining(messages, "fixed the unwrap")).toBeGreaterThanOrEqual(0);
		expect(userIndexContaining(messages, "steer the rule retry")).toBeGreaterThanOrEqual(0);
		expect(assistantIndexContaining(messages, "steer answer")).toBeGreaterThan(
			userIndexContaining(messages, "steer the rule retry"),
		);
	});

	it("admits a steer into the client prompt's code-rule retry", async () => {
		const parameters = type({ path: "string", content: "string" });
		let writes = 0;
		const writeTool: AgentTool<typeof parameters> = {
			name: "write",
			label: "Write",
			description: "Write a file",
			parameters,
			matcherDigest: args => {
				if (!args || typeof args !== "object" || !("content" in args)) return undefined;
				return typeof args.content === "string" ? args.content : undefined;
			},
			execute: async () => {
				writes += 1;
				return { content: [{ type: "text", text: "written" }] };
			},
		};
		const ttsrManager = new TtsrManager({ enabled: true, interruptMode: "always" });
		const rule: Rule = {
			name: "no-console",
			path: "/tmp/no-console.md",
			content: "Do not add console.log calls.",
			astCondition: ["console.log($$$)"],
			scope: ["tool:write(*.ts)"],
			interruptMode: "always",
			_source: { provider: "test", providerName: "test", path: "/tmp/no-console.md", level: "project" },
		};
		ttsrManager.addRule(rule);
		const retryStarted = Promise.withResolvers<void>();
		const releaseRetry = Promise.withResolvers<void>();
		const { session } = await createSession(
			[
				() => ({
					content: [
						{
							type: "toolCall",
							name: "write",
							arguments: { path: "probe.ts", content: "console.log('blocked');" },
						},
					],
				}),
				async () => {
					retryStarted.resolve();
					await releaseRetry.promise;
					return { content: ["rewrote without console.log"] };
				},
				() => ({ content: ["steer answer"] }),
			],
			{ ttsrManager, tools: [writeTool] },
		);

		const promptDone = session.prompt("write the file");
		await withTimeout(retryStarted.promise, 4_000, "Code-rule retry never streamed");
		expect(session.agent.state.isStreaming).toBe(true);
		// The rule blocked the write and retried from the tool check, not from
		// the text stream. A steer joins that retry only when the check kept
		// the client run's owner.
		expect(writes).toBe(0);
		expect(
			session.agent.state.messages.some(
				message => message.role === "custom" && message.customType === "ttsr-injection",
			),
		).toBe(true);

		expect(await withTimeout(session.joinActiveTurn("steer the code-rule retry"), 1_000, "steer parked")).toBe(true);

		releaseRetry.resolve();
		await promptDone;
		await session.waitForIdle();
		const messages = session.agent.state.messages;
		expect(assistantIndexContaining(messages, "rewrote without console.log")).toBeGreaterThanOrEqual(0);
		expect(userIndexContaining(messages, "steer the code-rule retry")).toBeGreaterThanOrEqual(0);
		expect(assistantIndexContaining(messages, "steer answer")).toBeGreaterThan(
			userIndexContaining(messages, "steer the code-rule retry"),
		);
	});
});
