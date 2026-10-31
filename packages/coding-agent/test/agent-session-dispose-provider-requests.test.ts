/**
 * Once a session has begun disposing, nothing reaches the provider that was not already on its
 * way there: a steer or follow-up queued on the session is not delivered and its images are not
 * described, an extension's aside is refused, a side request (`runEphemeralTurn`) is refused or
 * cancelled, a manual compaction, handoff or branch summary is refused or stopped, and the
 * auto-prewalk classifier of a queued task stops. Each of these used to send a request from the
 * closing session.
 *
 * The cases count requests at local endpoints that speak HTTPS on `localhost`, because what must
 * not happen is a request reaching the provider.
 *
 * The branch each request takes, and production's:
 *
 * - Turns, steers and follow-ups, asides, side requests, compaction, handoff, branch summaries and
 *   image descriptions: provider `anthropic` over `anthropic-messages` on an `https` URL, no `fetch`
 *   of the caller's own, no proxy, so the request leaves `fetch` for `node:https` (`coworkFetch`), as
 *   production's Anthropic traffic does. After each case the fixture checks that no request reached
 *   the provider endpoint through `globalThis.fetch`, which only the fallback branch calls.
 * - The judges (the prewalk classifier, `createJudge`, the TTSR rule judge, the table chart judge):
 *   the native judge (`typesafe`), whose transport is the global fetch, there and in production.
 *
 * One property differs from production and cannot match it: each base URL is a local endpoint, not
 * the provider's own host. The transport is chosen by provider, API and scheme, not by host; the
 * host only drops what the catalog scopes to the official API (request-body compression, the
 * official endpoint's headers and its warm-up).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compaction from "@oh-my-pi/pi-agent-core/compaction";
import type { Api, ImageContent, Model } from "@oh-my-pi/pi-ai";
import type { ApiKeyResolveContext, ApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { pickTableChart } from "@oh-my-pi/pi-coding-agent/auto-graph/planner";
import type { ApiKeyResolverModel } from "@oh-my-pi/pi-coding-agent/config/api-key-resolver";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { planChart } from "@oh-my-pi/pi-tui/charts/chart-plan";
import { analyzeTable } from "@oh-my-pi/pi-tui/charts/table-data";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { LOOPBACK_TLS, loopbackOrigin, trustLoopbackTls } from "./helpers/loopback-tls";

/** A 1×1 PNG. */
const IMAGE: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=",
};

/** One Anthropic streaming response: a text reply, or a single call to `noop`. */
function anthropicResponse(reply: "text" | "tool"): Response {
	const block =
		reply === "tool"
			? [
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "toolu_1", name: "noop", input: {} },
					},
					{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
				]
			: [
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
				];
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_test",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		...block,
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: reply === "tool" ? "tool_use" : "end_turn", stop_sequence: null },
			usage: { output_tokens: 1 },
		},
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}

/** What a case changes about the session it runs on. */
interface SessionOptions {
	settings?: Parameters<typeof Settings.isolated>[0];
	extensionRunner?: ExtensionRunner;
	agentKind?: "main" | "sub";
	ttsrManager?: TtsrManager;
}

describe("AgentSession provider requests at disposal", () => {
	let server: Bun.Server<undefined>;
	let authStorage: AuthStorage;
	let model: Model<Api>;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	/** Every request the provider endpoint received: its last message, and whether the session was disposing. */
	let requests: Array<{ disposed: boolean; lastMessage: string }>;
	/** Whether the endpoint holds its first response until `releaseFirst`. */
	let holdFirst: boolean;
	/** Resolved when the first request arrives. */
	let firstRequest: PromiseWithResolvers<void>;
	let releaseFirst: PromiseWithResolvers<void>;
	let firstReply: "text" | "tool";
	let toolRuns: number;
	/** Requests to the provider endpoint through `globalThis.fetch`: the fallback branch, which production skips. */
	let globalFetchSends: number;

	trustLoopbackTls();

	/** A session on the local endpoint; replaces the current one, which is disposed first. */
	async function replaceSession(options: SessionOptions): Promise<void> {
		await session.dispose();
		session = createSession(options);
	}

	function createSession(options: SessionOptions = {}): AgentSession {
		const noop: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Does nothing",
			parameters: type({}),
			execute: async () => {
				toolRuns++;
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		};
		return new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [noop] },
			}),
			sessionManager: SessionManager.inMemory(),
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, ...options.settings }),
			extensionRunner: options.extensionRunner,
			agentKind: options.agentKind,
			ttsrManager: options.ttsrManager,
		});
	}

	beforeEach(() => {
		requests = [];
		holdFirst = true;
		firstRequest = Promise.withResolvers<void>();
		releaseFirst = Promise.withResolvers<void>();
		firstReply = "text";
		toolRuns = 0;
		globalFetchSends = 0;
		server = Bun.serve({
			...LOOPBACK_TLS,
			port: 0,
			fetch: async request => {
				const body = (await request.json()) as { messages: unknown[] };
				requests.push({
					disposed: session.isDisposed,
					lastMessage: JSON.stringify(body.messages.at(-1)),
				});
				if (requests.length > 1 || !holdFirst) return anthropicResponse("text");
				firstRequest.resolve();
				await releaseFirst.promise;
				return anthropicResponse(firstReply);
			},
		});
		const origin = loopbackOrigin(server);
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
			if (new URL(input instanceof Request ? input.url : String(input)).origin === origin) globalFetchSends++;
			return realFetch(input, init);
		}) as typeof fetch);
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		model = { ...getBundledModel("anthropic", "claude-sonnet-4-5")!, baseUrl: origin };
		modelRegistry = new ModelRegistry(authStorage);
		session = createSession();
	});

	afterEach(async () => {
		releaseFirst.resolve();
		await session.dispose();
		authStorage.close();
		server.stop(true);
		vi.restoreAllMocks();
		// Every request the provider endpoint received went through `node:https`: production's branch.
		expect(globalFetchSends).toBe(0);
	});

	/** Start a turn and hold its provider response, so messages can be queued behind it. */
	async function startHeldTurn(): Promise<{ run: Promise<boolean> }> {
		const run = session.prompt("first");
		await firstRequest.promise;
		return { run };
	}

	/** A native judge endpoint and the session's judge role routed to it. */
	interface JudgeEndpoint {
		/** For each request the endpoint received, whether the session was disposing. */
		requests: boolean[];
		/** Resolved when the judge's credential is first asked for, if `holdCredential`. */
		credentialReached: Promise<void>;
		releaseCredential: () => void;
		port: number;
		stop: () => void;
	}

	/**
	 * Route the judge role to a local native endpoint. It answers every question: a `noul`
	 * question with 0, a choice with `direct` when offered, else its first option. With
	 * `holdCredential`, the judge's credential lookup waits until `releaseCredential`.
	 * Call before the session the case uses is created, since that session reads the role.
	 */
	function routeJudge(options: { holdCredential?: boolean } = {}): JudgeEndpoint {
		const requests: boolean[] = [];
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const judgeServer = Bun.serve({
			...LOOPBACK_TLS,
			port: 0,
			fetch: async request => {
				const body = (await request.json()) as {
					questions: Record<string, { type: string; criteria?: Record<string, unknown> }>;
				};
				requests.push(session.isDisposed);
				const answers: Record<string, unknown> = {};
				for (const [id, question] of Object.entries(body.questions)) {
					if (question.type === "noul") {
						answers[id] = { type: "noul", noul: 0 };
						continue;
					}
					const labels = Object.keys(question.criteria ?? {});
					const choice = labels.includes("direct") ? "direct" : labels[0];
					answers[id] = { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 };
				}
				return Response.json({ model: "jev-preview", answers, usage: { input_tokens: 8, output_tokens: 2 } });
			},
		});
		const judge = {
			id: "jev-preview",
			name: "JEV Preview",
			api: "typesafe",
			provider: "typesafe",
			baseUrl: loopbackOrigin(judgeServer),
			kind: "judge",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		} as Model<Api>;
		authStorage.keys.setRuntime("typesafe", "ts-test-key");
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([judge, model]);
		if (options.holdCredential) {
			const resolve = modelRegistry.resolver.bind(modelRegistry) as (
				target: ApiKeyResolverModel,
				sessionId?: string,
			) => ApiKeyResolver;
			vi.spyOn(modelRegistry, "resolver").mockImplementation(((
				target: ApiKeyResolverModel,
				sessionId?: string,
			): ApiKeyResolver => {
				const real = resolve(target, sessionId);
				if (target.provider !== "typesafe") return real;
				return async (context: ApiKeyResolveContext) => {
					reached.resolve();
					await release.promise;
					return real(context);
				};
			}) as typeof modelRegistry.resolver);
		}
		return {
			requests,
			credentialReached: reached.promise,
			releaseCredential: () => release.resolve(),
			port: judgeServer.port ?? 0,
			stop: () => {
				release.resolve();
				judgeServer.stop(true);
			},
		};
	}

	describe("queued steering and follow-ups", () => {
		it.each(["followUp", "steer"] as const)("delivers a queued %s on a live session", async kind => {
			const { run } = await startHeldTurn();
			await session.prompt("queued message", { streamingBehavior: kind });

			releaseFirst.resolve();
			await run;
			await session.waitForIdle();

			expect(requests).toHaveLength(2);
			expect(requests[1].lastMessage).toContain("queued message");
		});

		it.each(["followUp", "steer"] as const)("sends no request for a %s queued before disposal began", async kind => {
			const { run } = await startHeldTurn();
			await session.prompt("queued message", { streamingBehavior: kind });

			session.beginDispose();
			releaseFirst.resolve();
			// The turn admitted before disposal still settles.
			await expect(run).resolves.toBe(true);
			await session.waitForIdle();

			expect(requests).toEqual([{ disposed: false, lastMessage: expect.stringContaining("first") }]);
		});

		it.each(["followUp", "steer"] as const)(
			"sends no request for an extension message queued as a %s while the session is disposing",
			async kind => {
				const { run } = await startHeldTurn();

				session.beginDispose();
				await session.sendCustomMessage(
					{ customType: "extension-note", content: "queued message", display: false },
					{ deliverAs: kind },
				);
				releaseFirst.resolve();
				await run;
				await session.waitForIdle();

				expect(requests).toEqual([{ disposed: false, lastMessage: expect.stringContaining("first") }]);
			},
		);

		it("takes a steer at the boundary after a tool call on a live session", async () => {
			firstReply = "tool";
			const { run } = await startHeldTurn();
			await session.prompt("queued message", { streamingBehavior: "steer" });

			releaseFirst.resolve();
			await run;
			await session.waitForIdle();

			expect(toolRuns).toBe(1);
			expect(requests).toHaveLength(2);
			expect(requests[1].lastMessage).toContain("queued message");
		});

		it("finishes the tool call it was making but does not take a steer at the next boundary", async () => {
			firstReply = "tool";
			const { run } = await startHeldTurn();
			await session.prompt("queued message", { streamingBehavior: "steer" });

			session.beginDispose();
			releaseFirst.resolve();
			await run;
			await session.waitForIdle();

			expect(toolRuns).toBe(1);
			expect(requests).toEqual([{ disposed: false, lastMessage: expect.stringContaining("first") }]);
		});
	});

	describe("extension asides", () => {
		it("starts a turn for an aside sent to a live idle session", async () => {
			holdFirst = false;
			await session.sendCustomMessage(
				{ customType: "extension-note", content: "late aside", display: true },
				{ deliverAs: "aside" },
			);
			await session.waitForIdle();

			expect(requests.map(request => request.disposed)).toEqual([false]);
		});

		it("refuses an aside sent after disposal began, and says why", async () => {
			holdFirst = false;
			session.beginDispose();

			await expect(
				session.sendCustomMessage(
					{ customType: "extension-note", content: "late aside", display: true },
					{ deliverAs: "aside" },
				),
			).rejects.toThrow("This session has begun disposing");
			await session.waitForIdle();

			expect(requests).toEqual([]);
		});
	});

	describe("side requests", () => {
		it("sends a side request for a live session", async () => {
			holdFirst = false;
			const { replyText } = await session.runEphemeralTurn({ promptText: "late side turn" });

			expect(replyText).toBe("done");
			expect(requests).toEqual([{ disposed: false, lastMessage: expect.stringContaining("late side turn") }]);
		});

		it("refuses a side request asked for after disposal began", async () => {
			holdFirst = false;
			session.beginDispose();

			await expect(session.runEphemeralTurn({ promptText: "late side turn" })).rejects.toThrow(
				"This session has begun disposing",
			);
			expect(requests).toEqual([]);
		});

		it("cancels a side request still streaming when disposal begins", async () => {
			const turn = session.runEphemeralTurn({ promptText: "side turn in flight" });
			await firstRequest.promise;

			session.beginDispose();

			// It settles without the provider ever answering.
			await expect(turn).rejects.toThrow();
			expect(requests).toEqual([{ disposed: false, lastMessage: expect.stringContaining("side turn in flight") }]);
		});
	});

	describe("manual compaction, handoff and branch summary", () => {
		const COMPACTION_SETTINGS: SessionOptions["settings"] = {
			"compaction.keepRecentTokens": 1,
			"compaction.reserveTokens": 1024,
			"compaction.methodOrder": ["soft"],
		};

		/** A conversation long enough for every maintenance operation to have something to summarize. */
		async function seedConversation(): Promise<void> {
			holdFirst = false;
			await replaceSession({ settings: COMPACTION_SETTINGS });
			const now = Date.now();
			for (let i = 0; i < 4; i++) {
				session.sessionManager.appendMessage({
					role: "user",
					content: `User seed ${i} ${"context ".repeat(200)}`,
					timestamp: now + i * 2,
				});
				session.sessionManager.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: `Answer ${i} ${"response ".repeat(200)}` }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "stop",
					usage: {
						input: 1000,
						output: 1000,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: now + i * 2 + 1,
				});
			}
			session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
		}

		function firstMessageId(): string {
			const entry = session.sessionManager.getEntries().find(candidate => candidate.type === "message");
			if (!entry) throw new Error("expected a seeded message");
			return entry.id;
		}

		it.each([
			["compaction", () => session.compact(undefined, { mode: "soft", suppressContinuation: true })],
			["handoff", () => session.handoff()],
			["branch summary", () => session.navigateTree(firstMessageId(), { summarize: true })],
		] as const)("runs a %s on a live session", async (_work, start) => {
			await seedConversation();
			const entriesBefore = session.sessionManager.getEntries().length;
			await start();

			expect(requests.length).toBeGreaterThan(0);
			expect(requests.every(request => !request.disposed)).toBe(true);
			expect(session.sessionManager.getEntries().length).toBeGreaterThan(entriesBefore);
		});

		it.each([
			["compaction", () => session.compact(undefined, { mode: "soft", suppressContinuation: true })],
			["handoff", () => session.handoff()],
			["branch summary", () => session.navigateTree(firstMessageId(), { summarize: true })],
		] as const)("refuses a %s asked for after disposal began, and says why", async (work, start) => {
			await seedConversation();
			const entriesBefore = session.sessionManager.getEntries().length;
			session.beginDispose();

			await expect(start()).rejects.toThrow(`This session has begun disposing, so this ${work} was refused.`);
			expect(requests).toEqual([]);
			expect(session.sessionManager.getEntries()).toHaveLength(entriesBefore);
		});

		it("leaves the tree as it was when disposal begins while session_before_tree is awaited", async () => {
			const hookEntered = Promise.withResolvers<void>();
			const releaseHook = Promise.withResolvers<void>();
			// The hand-rolled runner implements only what this path and disposal call.
			const extensionRunner = {
				hasHandlers: (event: string) => event === "session_before_tree",
				emit: async () => {
					hookEntered.resolve();
					await releaseHook.promise;
					return undefined;
				},
				clearManagedTimers: () => {},
				disposeFileFallbacks: () => {},
			} as unknown as ExtensionRunner;
			await seedConversation();
			await replaceSession({ settings: COMPACTION_SETTINGS, extensionRunner });
			const now = Date.now();
			session.sessionManager.appendMessage({ role: "user", content: "first", timestamp: now });
			session.sessionManager.appendMessage({ role: "user", content: "second", timestamp: now + 1 });
			const leafBefore = session.sessionManager.getLeafId();

			const navigation = session.navigateTree(firstMessageId(), { summarize: true });
			await hookEntered.promise;
			session.beginDispose();
			releaseHook.resolve();

			expect(await navigation).toEqual({ cancelled: true, aborted: true });
			expect(requests).toEqual([]);
			expect(session.sessionManager.getLeafId()).toBe(leafBefore);
		});

		/** Hold the first credential lookup a summary request makes until `release` settles. */
		function holdFirstCredential(): { reached: Promise<void>; release: () => void } {
			const reached = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const resolve = modelRegistry.resolver.bind(modelRegistry) as (
				target: ApiKeyResolverModel,
				sessionId?: string,
			) => ApiKeyResolver;
			let held = false;
			vi.spyOn(modelRegistry, "resolver").mockImplementation(((
				target: ApiKeyResolverModel,
				sessionId?: string,
			): ApiKeyResolver => {
				const real = resolve(target, sessionId);
				return async (context: ApiKeyResolveContext) => {
					if (!held) {
						held = true;
						reached.resolve();
						await release.promise;
					}
					return real(context);
				};
			}) as typeof modelRegistry.resolver);
			return { reached: reached.promise, release: () => release.resolve() };
		}

		// Navigations overlap: a later one used to replace, then clear, the only controller an
		// earlier summary had, so disposal could no longer cancel it.
		it.each([
			["a plain", false],
			["a summarized", true],
		] as const)(
			"cancels a summary waiting for its credential after %s navigation completes and disposal begins",
			async (_kind, secondSummarizes) => {
				await seedConversation();
				const credential = holdFirstCredential();
				const messages = session.sessionManager.getEntries().filter(entry => entry.type === "message");
				const first = session.navigateTree(messages[1]!.id, { summarize: true });
				await credential.reached;
				await session.navigateTree(messages[3]!.id, { summarize: secondSummarizes });
				const leafBefore = session.sessionManager.getLeafId();
				const entriesBefore = session.sessionManager.getEntries().length;

				session.beginDispose();
				credential.release();

				expect(await first).toEqual({ cancelled: true, aborted: true });
				expect(requests.filter(request => request.disposed)).toEqual([]);
				expect(session.sessionManager.getLeafId()).toBe(leafBefore);
				expect(session.sessionManager.getEntries()).toHaveLength(entriesBefore);
			},
		);

		it("cancels a summary still streaming after a plain navigation completes and disposal begins", async () => {
			await seedConversation();
			holdFirst = true;
			const messages = session.sessionManager.getEntries().filter(entry => entry.type === "message");
			const first = session.navigateTree(messages[1]!.id, { summarize: true });
			await firstRequest.promise;
			await session.navigateTree(messages[3]!.id);
			const leafBefore = session.sessionManager.getLeafId();
			const entriesBefore = session.sessionManager.getEntries().length;

			session.beginDispose();
			releaseFirst.resolve();

			expect(await first).toEqual({ cancelled: true, aborted: true });
			expect(requests.map(request => request.disposed)).toEqual([false]);
			expect(session.sessionManager.getLeafId()).toBe(leafBefore);
			expect(session.sessionManager.getEntries()).toHaveLength(entriesBefore);
		});

		// The navigation's own aborted signal decides, not what a hook or the summarizer says.
		describe("abortBranchSummary()", () => {
			it("commits none of three hook-supplied summaries whose hooks return after the abort", async () => {
				const entered = Promise.withResolvers<void>();
				const releaseHooks = Promise.withResolvers<void>();
				const hookSignals: AbortSignal[] = [];
				// The hand-rolled runner implements only what this path and disposal call.
				const extensionRunner = {
					hasHandlers: (event: string) => event === "session_before_tree",
					emit: async (event: { signal: AbortSignal }) => {
						hookSignals.push(event.signal);
						if (hookSignals.length === 3) entered.resolve();
						await releaseHooks.promise;
						return { summary: { summary: "hook summary" } };
					},
					clearManagedTimers: () => {},
					disposeFileFallbacks: () => {},
				} as unknown as ExtensionRunner;
				await seedConversation();
				await replaceSession({ settings: COMPACTION_SETTINGS, extensionRunner });
				const now = Date.now();
				session.sessionManager.appendMessage({ role: "user", content: "first", timestamp: now });
				session.sessionManager.appendMessage({ role: "user", content: "second", timestamp: now + 1 });
				const leafBefore = session.sessionManager.getLeafId();
				const entriesBefore = session.sessionManager.getEntries().length;

				const navigations = Array.from({ length: 3 }, () =>
					session.navigateTree(firstMessageId(), { summarize: true }),
				);
				await entered.promise;
				session.abortBranchSummary();
				releaseHooks.resolve();

				expect(await Promise.all(navigations)).toEqual(Array(3).fill({ cancelled: true, aborted: true }));
				expect(hookSignals.map(signal => signal.aborted)).toEqual([true, true, true]);
				expect(session.sessionManager.getLeafId()).toBe(leafBefore);
				expect(session.sessionManager.getEntries()).toHaveLength(entriesBefore);
			});

			it("commits no summary the summarizer finished just as the abort came", async () => {
				await seedConversation();
				const summarize = compaction.generateBranchSummary;
				let finished: Awaited<ReturnType<typeof summarize>> | undefined;
				vi.spyOn(compaction, "generateBranchSummary").mockImplementation(async (...args) => {
					finished = await summarize(...args);
					session.abortBranchSummary();
					return finished;
				});
				const leafBefore = session.sessionManager.getLeafId();
				const entriesBefore = session.sessionManager.getEntries().length;

				const result = await session.navigateTree(firstMessageId(), { summarize: true });

				expect(finished?.aborted).toBeFalsy();
				expect(finished?.summary).toBeTruthy();
				expect(result).toEqual({ cancelled: true, aborted: true });
				expect(requests.map(request => request.disposed)).toEqual([false]);
				expect(session.sessionManager.getLeafId()).toBe(leafBefore);
				expect(session.sessionManager.getEntries()).toHaveLength(entriesBefore);
			});
		});
	});

	describe("image descriptions for queued messages", () => {
		/** A text-only active model with a vision model configured, so an image gets described first. */
		async function describeImagesForTextModel(): Promise<void> {
			await replaceSession({
				settings: { "images.describeForTextModels": true, "modelRoles.vision": "anthropic/claude-sonnet-4-5" },
			});
			vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([model]);
			session.agent.setModel({ ...model, input: ["text"] });
		}

		it("describes the image of a follow-up queued on a live session", async () => {
			holdFirst = false;
			await describeImagesForTextModel();
			await session.followUp("queued with image", [IMAGE]);

			expect(requests.map(request => request.disposed)).toEqual([false]);
		});

		it.each([
			["steer", () => session.steer("queued with image", [IMAGE])],
			["follow-up", () => session.followUp("queued with image", [IMAGE])],
			["synthetic follow-up", () => session.followUp("queued with image", [IMAGE], { synthetic: true })],
		] as const)("sends no vision request for a %s queued after disposal began", async (_kind, queue) => {
			holdFirst = false;
			await describeImagesForTextModel();
			session.beginDispose();

			await queue();
			await session.waitForIdle();

			expect(requests).toEqual([]);
		});

		it("cancels a vision request in flight when disposal begins", async () => {
			await describeImagesForTextModel();
			const queued = session.followUp("queued with image", [IMAGE]);
			await firstRequest.promise;

			session.beginDispose();

			// It settles while the provider still holds its answer, and nothing follows it.
			await queued;
			expect(requests.map(request => request.disposed)).toEqual([false]);
		});
	});

	describe("auto-prewalk classification of a queued task", () => {
		it.each([
			["sends the judge request while the session is live", false],
			["sends no judge request once disposal begins during its credential wait", true],
		] as const)("%s", async (_name, dispose) => {
			const judge = routeJudge({ holdCredential: true });
			try {
				await replaceSession({
					settings: { "prewalk.auto": "on", "modelRoles.judge": "typesafe/jev-preview" },
					agentKind: "main",
				});

				// A synthetic seed turn is not classified; the user's follow-up queued behind it is.
				const run = session.prompt("first synthetic seed", { synthetic: true });
				await firstRequest.promise;
				// The judge caches by request, so each case asks about a task of its own.
				await session.followUp(`Trace the synchronization engine and fix the stale cursor ${judge.port}`);
				releaseFirst.resolve();
				await Promise.race([
					judge.credentialReached,
					run.then(() => {
						throw new Error("the classifier never reached its credential");
					}),
				]);
				if (dispose) session.beginDispose();
				judge.releaseCredential();
				await run;
				await session.waitForIdle();

				expect(judge.requests).toEqual(dispose ? [] : [false]);
			} finally {
				judge.stop();
			}
		});
	});

	// Every judge the session hands out carries its disposal signal from construction, so no
	// call site has to pass one for its judgment to stop at disposal.
	describe("judges the session hands out", () => {
		const JUDGE_SETTINGS: SessionOptions["settings"] = { "modelRoles.judge": "typesafe/jev-preview" };
		const REQUEST = { state: { text: "probe" }, questions: { q: { type: "noul", instructions: "Is it?" } } } as const;

		it("sends a judgment from a live session's judge, though the call passes no signal", async () => {
			const judge = routeJudge();
			try {
				await replaceSession({ settings: JUDGE_SETTINGS });
				await session.createJudge("probe").judge(REQUEST);

				expect(judge.requests).toEqual([false]);
			} finally {
				judge.stop();
			}
		});

		it.each([
			["judge()", (j: ReturnType<AgentSession["createJudge"]>) => j.judge(REQUEST)],
			[
				"a withCandidate candidate",
				(j: ReturnType<AgentSession["createJudge"]>) => j.withCandidate(c => c.judge(REQUEST)),
			],
		] as const)(
			"sends nothing through %s called with no signal once disposal begins during its credential wait",
			async (_route, call) => {
				const judge = routeJudge({ holdCredential: true });
				try {
					await replaceSession({ settings: JUDGE_SETTINGS });
					const judgment = call(session.createJudge("probe"));
					await judge.credentialReached;
					session.beginDispose();
					judge.releaseCredential();

					await expect(judgment).rejects.toThrow();
					expect(judge.requests).toEqual([]);
				} finally {
					judge.stop();
				}
			},
		);

		it("starts nothing from a judge obtained after disposal began", async () => {
			const judge = routeJudge();
			try {
				await replaceSession({ settings: JUDGE_SETTINGS });
				session.beginDispose();

				await expect(session.createJudge("probe").judge(REQUEST)).rejects.toThrow();
				expect(judge.requests).toEqual([]);
			} finally {
				judge.stop();
			}
		});

		describe("rule judge (TTSR questions on completed output)", () => {
			/** A session with one TTSR rule whose question the judge answers about each reply. */
			async function sessionWithJudgedRule(port: number): Promise<void> {
				const ttsrManager = new TtsrManager({
					enabled: true,
					contextMode: "discard",
					interruptMode: "always",
					repeatMode: "once",
					repeatGap: 0,
				});
				const added = ttsrManager.addRule({
					name: `claim-check-${port}`,
					path: "/rules/claim-check.md",
					content: "Rule guidance",
					// The judge caches by request, so each case asks a question of its own.
					question: `Does this reply make a claim? (${port})`,
					scope: ["text"],
					_source: { provider: "test", providerName: "test", path: "/rules/claim-check.md", level: "project" },
				});
				expect(added).toBe(true);
				await replaceSession({
					settings: { ...JUDGE_SETTINGS, "ttsr.judge": "on" },
					ttsrManager,
					agentKind: "main",
				});
			}

			it("judges the reply of a live session", async () => {
				const judge = routeJudge();
				try {
					await sessionWithJudgedRule(judge.port);
					holdFirst = false;
					await session.prompt("Say done.");
					await session.waitForIdle();

					expect(judge.requests).toEqual([false]);
				} finally {
					judge.stop();
				}
			});

			it("sends no judgment once disposal begins during the judge's credential wait", async () => {
				const judge = routeJudge({ holdCredential: true });
				try {
					await sessionWithJudgedRule(judge.port);
					holdFirst = false;
					const run = session.prompt("Say done.");
					await judge.credentialReached;
					session.beginDispose();
					judge.releaseCredential();
					await run;
					await session.waitForIdle();

					expect(judge.requests).toEqual([]);
				} finally {
					judge.stop();
				}
			});

			it("sends no judgment for a reply that completes after disposal began", async () => {
				const judge = routeJudge();
				try {
					await sessionWithJudgedRule(judge.port);
					const run = session.prompt("Say done.");
					await firstRequest.promise;
					session.beginDispose();
					releaseFirst.resolve();
					await run;
					await session.waitForIdle();

					expect(judge.requests).toEqual([]);
				} finally {
					judge.stop();
				}
			});
		});

		describe("table chart judge", () => {
			function chartRequest(port: number) {
				// The judge caches by request, so each case draws a table of its own.
				const table = analyzeTable(
					["name", "before", "after"],
					[
						[`a-${port}`, "12", "14"],
						["b", "13", "16"],
						["c", "16", "18"],
					],
				);
				const guess = planChart(table);
				if (!guess) throw new Error("expected a local chart guess");
				return { markdown: `chart-${port}`, table, guess };
			}

			it("picks a chart for a live session", async () => {
				const judge = routeJudge();
				try {
					await replaceSession({ settings: JUDGE_SETTINGS });
					await pickTableChart(chartRequest(judge.port), session.tableChartJudge());

					expect(judge.requests).toEqual([false]);
				} finally {
					judge.stop();
				}
			});

			// The planner throws on a judgment it could not get, and the renderer then draws the local guess.
			it.each([
				["sends nothing for a pick asked for after disposal began", false],
				["sends nothing once disposal begins during the pick's credential wait", true],
			] as const)(
				"%s, and the planner throws so the renderer draws the local guess",
				async (_name, duringCredentialWait) => {
					const judge = routeJudge({ holdCredential: duringCredentialWait });
					try {
						await replaceSession({ settings: JUDGE_SETTINGS });
						if (!duringCredentialWait) session.beginDispose();
						const pick = pickTableChart(chartRequest(judge.port), session.tableChartJudge());
						if (duringCredentialWait) {
							await judge.credentialReached;
							session.beginDispose();
							judge.releaseCredential();
						}

						await expect(pick).rejects.toThrow();
						expect(judge.requests).toEqual([]);
					} finally {
						judge.stop();
					}
				},
			);
		});
	});
});
