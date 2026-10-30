/**
 * Once a session has begun disposing, nothing reaches the provider that was not already on its
 * way there: a steer or follow-up queued on the session is not delivered and its images are not
 * described, an extension's aside is refused, a side request (`runEphemeralTurn`) is refused or
 * cancelled, a manual compaction, handoff or branch summary is refused or stopped, and the
 * auto-prewalk classifier of a queued task stops. Each of these used to send a request from the
 * closing session.
 *
 * The cases count requests at local endpoints, because what must not happen is a request
 * reaching the provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Api, ImageContent, Model } from "@oh-my-pi/pi-ai";
import type { ApiKeyResolveContext, ApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ApiKeyResolverModel } from "@oh-my-pi/pi-coding-agent/config/api-key-resolver";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

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
		});
	}

	beforeEach(() => {
		requests = [];
		holdFirst = true;
		firstRequest = Promise.withResolvers<void>();
		releaseFirst = Promise.withResolvers<void>();
		firstReply = "text";
		toolRuns = 0;
		server = Bun.serve({
			hostname: "127.0.0.1",
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
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		model = { ...getBundledModel("anthropic", "claude-sonnet-4-5")!, baseUrl: server.url.origin };
		modelRegistry = new ModelRegistry(authStorage);
		session = createSession();
	});

	afterEach(async () => {
		releaseFirst.resolve();
		await session.dispose();
		authStorage.close();
		server.stop(true);
		vi.restoreAllMocks();
	});

	/** Start a turn and hold its provider response, so messages can be queued behind it. */
	async function startHeldTurn(): Promise<{ run: Promise<boolean> }> {
		const run = session.prompt("first");
		await firstRequest.promise;
		return { run };
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
			const judgeRequests: boolean[] = [];
			const judgeServer = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: async request => {
					await request.json();
					judgeRequests.push(session.isDisposed);
					return Response.json({
						model: "jev-preview",
						answers: {
							route: {
								type: "choice",
								choice: "direct",
								probabilities: { prewalk: 0.05, primary: 0.05, direct: 0.9 },
								confidence: 0.9,
							},
						},
						usage: { input_tokens: 8, output_tokens: 2 },
					});
				},
			});
			const keyReached = Promise.withResolvers<void>();
			const releaseKey = Promise.withResolvers<void>();
			try {
				const judge = {
					id: "jev-preview",
					name: "JEV Preview",
					api: "typesafe",
					provider: "typesafe",
					baseUrl: judgeServer.url.origin,
					kind: "judge",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 4096,
				} as Model<Api>;
				authStorage.keys.setRuntime("typesafe", "ts-test-key");
				vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([judge, model]);
				// Hold the judge's credential, the wait the classifier sits in before its request.
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
						keyReached.resolve();
						await releaseKey.promise;
						return real(context);
					};
				}) as typeof modelRegistry.resolver);
				await replaceSession({
					settings: { "prewalk.auto": "on", "modelRoles.judge": "typesafe/jev-preview" },
					agentKind: "main",
				});

				// A synthetic seed turn is not classified; the user's follow-up queued behind it is.
				const run = session.prompt("first synthetic seed", { synthetic: true });
				await firstRequest.promise;
				// The judge caches by request, so each case asks about a task of its own.
				await session.followUp(`Trace the synchronization engine and fix the stale cursor ${judgeServer.port}`);
				releaseFirst.resolve();
				await Promise.race([
					keyReached.promise,
					run.then(() => {
						throw new Error("the classifier never reached its credential");
					}),
				]);
				if (dispose) session.beginDispose();
				releaseKey.resolve();
				await run;
				await session.waitForIdle();

				expect(judgeRequests).toEqual(dispose ? [] : [false]);
			} finally {
				releaseKey.resolve();
				judgeServer.stop(true);
			}
		});
	});
});
