/**
 * Model work an eval cell detaches from the turn that started it stops when the session begins
 * disposing: a cell that went to the background (and the `judge()` and `tool.find()` calls it
 * makes), a `judgeBatch()` run and a `completion()` handle, which the host owns past the cell.
 * Each used to send its request after the turn had finished and the session had begun closing.
 * Work the admitted turn still awaits (a foreground cell's `judge()` or `find`) may finish.
 *
 * Every case runs a real primary turn through the eval tool and its JavaScript worker, lets that
 * turn finish, then holds the detached request at its credential while the session is live, has
 * begun disposing, or waits in `dispose()` for its shutdown hooks. The cases count requests at
 * local endpoints that speak HTTPS on `localhost`.
 *
 * The branch each request takes, and production's:
 *
 * - The primary turn and a `completion()`: provider `anthropic` over `anthropic-messages` on an
 *   `https` URL, no `fetch` of the caller's own, no proxy, so the request leaves `fetch` for
 *   `node:https` (`coworkFetch`), as production's Anthropic traffic does. Each finished primary turn,
 *   and each `completion()` sent on a live session, is checked to have reached the endpoint without
 *   passing `globalThis.fetch`, which only the fallback branch calls.
 * - `judge()`, `find`'s judgments, `judgeBatch()` and a `judge_batch` run: the native judge
 *   (`typesafe`), whose transport is the global fetch, there and in production.
 *
 * One property differs from production and cannot match it: each base URL is a local endpoint, not
 * the provider's own host. The transport is chosen by provider, API and scheme, not by host; the
 * host only drops what the catalog scopes to the official API (request-body compression, the
 * official endpoint's headers and its warm-up).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ApiKeyResolveContext, ApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { ApiKeyResolverModel } from "@oh-my-pi/pi-coding-agent/config/api-key-resolver";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { evalRequestSlots } from "@oh-my-pi/pi-coding-agent/eval/completion-bridge";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import {
	getJudgmentBatch,
	releaseJudgmentBatches,
	runEvalJudgmentBatch,
} from "@oh-my-pi/pi-coding-agent/eval/judgment-batch-bridge";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { FindTool } from "@oh-my-pi/pi-coding-agent/tools/jfind";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { LOOPBACK_TLS, loopbackOrigin, trustLoopbackTls } from "./helpers/loopback-tls";

/** One Anthropic streaming response: a text reply, or a call to `eval` running `code`. */
function anthropicResponse(reply: { text: string } | { evalCode: string }): Response {
	const block =
		"evalCode" in reply
			? [
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "toolu_eval", name: "eval", input: {} },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: {
							type: "input_json_delta",
							partial_json: JSON.stringify({ language: "js", code: reply.evalCode, timeout: 15 }),
						},
					},
				]
			: [
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.text } },
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
			delta: { stop_reason: "evalCode" in reply ? "tool_use" : "end_turn", stop_sequence: null },
			usage: { output_tokens: 1 },
		},
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}

/** Where the case stops the session while the detached request waits for its credential. */
type Stop = "live" | "beginDispose" | "dispose";

describe("model work detached from a finished turn at disposal", () => {
	let tempDir: TempDir;
	let primaryServer: Bun.Server<undefined>;
	let judgeServer: Bun.Server<undefined>;
	let authStorage: AuthStorage;
	let model: Model<Api>;
	let modelRegistry: ModelRegistry;
	let manager: AsyncJobManager;
	let session: AgentSession;
	/** The eval code the primary model's first reply runs. */
	let evalCode: string;
	/** For each primary-endpoint request, whether the session was disposing. */
	let primaryRequests: boolean[];
	/** Requests to the primary endpoint through `globalThis.fetch`: the fallback branch, which production skips. */
	let primaryGlobalFetchSends: number;
	/** For each judge-endpoint request, whether the session was disposing. */
	let judgeRequests: boolean[];
	/** Which provider's credential the case holds, from when `holding` is set. */
	let heldProvider: string;
	let holding: boolean;
	let credentialReached: PromiseWithResolvers<void>;
	let releaseCredential: PromiseWithResolvers<void>;
	/** Held open by the `session_shutdown` hook until the case releases it. */
	let shutdownEntered: PromiseWithResolvers<void>;
	let releaseShutdown: PromiseWithResolvers<void>;
	let disposal: Promise<void> | undefined;

	trustLoopbackTls();

	function createSession(settings: Record<string, unknown>): AgentSession {
		const extensionRunner = {
			hasHandlers: (event: string) => event === "session_shutdown",
			emitBeforeAgentStart: async () => undefined,
			emit: async (event: { type: string }) => {
				if (event.type !== "session_shutdown") return;
				shutdownEntered.resolve();
				await releaseShutdown.promise;
			},
			clearManagedTimers() {},
			disposeFileFallbacks() {},
		} as unknown as ExtensionRunner;
		return new AgentSession({
			agent: new Agent({ getApiKey: () => "test-key", initialState: { model, systemPrompt: ["Test"], tools: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			modelRegistry,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				"modelRoles.judge": "typesafe/jev-preview",
				...settings,
			}),
			agentId: `detached-${Bun.randomUUIDv7()}`,
			ownedAsyncJobManager: manager,
			extensionRunner,
		});
	}

	/** The tool-facing view of `session` that the eval tool and `find` run against. */
	function toolSession(): ToolSession {
		const base: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			settings: session.settings,
			modelRegistry,
			sessionManager: session.sessionManager,
			asyncJobManager: session.asyncJobManager,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getAgentId: () => session.getAgentId() ?? null,
			getSessionId: () => session.sessionId,
			getActiveModelString: () => `${model.provider}/${model.id}`,
			getEvalSessionId: () => session.getEvalSessionId(),
			getEvalKernelOwnerId: () => session.getEvalKernelOwnerId(),
			assertEvalExecutionAllowed: () => session.assertEvalExecutionAllowed(),
			trackEvalExecution: (execution, controller) => session.trackEvalExecution(execution, controller),
			isDisposed: () => session.isDisposed,
		};
		// `FindTool` narrows `execute`'s parameters, which the bridge's generic tool type does not.
		const find = new FindTool(base) as unknown as AgentTool;
		return { ...base, getToolByName: name => (name === "find" ? find : undefined) };
	}

	/** Run one primary turn whose model calls `eval` with `code`, then answers. */
	async function runTurn(code: string): Promise<void> {
		evalCode = code;
		session.agent.setTools([new EvalTool(toolSession())]);
		holding = true;
		await session.prompt("Run the eval, then answer.");
		expect(primaryRequests).toEqual([false, false]);
		expect(primaryGlobalFetchSends).toBe(0);
		expect(session.isStreaming).toBe(false);
	}

	/** Stop the session as `stop` says, while the detached request is held at its credential. */
	async function stopAt(stop: Stop): Promise<void> {
		await credentialReached.promise;
		if (stop === "beginDispose") session.beginDispose();
		if (stop === "dispose") {
			disposal = session.dispose();
			await shutdownEntered.promise;
		}
		releaseCredential.resolve();
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-dispose-detached-work-");
		await Bun.write(
			path.join(tempDir.path(), "needle.ts"),
			'export function needle() {\n\treturn "lifetime disposal";\n}\n',
		);
		evalCode = "";
		primaryRequests = [];
		primaryGlobalFetchSends = 0;
		judgeRequests = [];
		heldProvider = "typesafe";
		holding = false;
		credentialReached = Promise.withResolvers<void>();
		releaseCredential = Promise.withResolvers<void>();
		shutdownEntered = Promise.withResolvers<void>();
		releaseShutdown = Promise.withResolvers<void>();
		disposal = undefined;
		primaryServer = Bun.serve({
			...LOOPBACK_TLS,
			port: 0,
			fetch: async request => {
				await request.json();
				primaryRequests.push(session.isDisposed);
				return anthropicResponse(primaryRequests.length === 1 ? { evalCode } : { text: "done" });
			},
		});
		judgeServer = Bun.serve({
			...LOOPBACK_TLS,
			port: 0,
			fetch: async request => {
				const body = (await request.json()) as { questions: Record<string, { type: string }> };
				judgeRequests.push(session.isDisposed);
				const answers: Record<string, unknown> = {};
				for (const [id, question] of Object.entries(body.questions)) {
					answers[id] =
						question.type === "noul"
							? { type: "noul", noul: 0 }
							: { type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 1 };
				}
				return Response.json({ model: "jev-preview", answers, usage: { input_tokens: 8, output_tokens: 2 } });
			},
		});
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("typesafe", "ts-test-key");
		const primaryOrigin = loopbackOrigin(primaryServer);
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
			if (new URL(input instanceof Request ? input.url : String(input)).origin === primaryOrigin) {
				primaryGlobalFetchSends++;
			}
			return realFetch(input, init);
		}) as typeof fetch);
		model = { ...getBundledModel("anthropic", "claude-sonnet-4-5")!, baseUrl: primaryOrigin };
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
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([judge, model]);
		const resolve = modelRegistry.resolver.bind(modelRegistry) as (
			target: ApiKeyResolverModel,
			sessionId?: string,
		) => ApiKeyResolver;
		vi.spyOn(modelRegistry, "resolver").mockImplementation(((
			target: ApiKeyResolverModel,
			sessionId?: string,
		): ApiKeyResolver => {
			const real = resolve(target, sessionId);
			return async (context: ApiKeyResolveContext) => {
				if (holding && target.provider === heldProvider) {
					credentialReached.resolve();
					await releaseCredential.promise;
				}
				return real(context);
			};
		}) as typeof modelRegistry.resolver);
		manager = new AsyncJobManager({ onJobComplete: () => {} });
	});

	afterEach(async () => {
		releaseCredential.resolve();
		releaseShutdown.resolve();
		await disposal;
		await session.dispose();
		authStorage.close();
		primaryServer.stop(true);
		judgeServer.stop(true);
		vi.restoreAllMocks();
		await disposeAllVmContexts();
		tempDir.removeSync();
	});

	const unique = () => JSON.stringify(`state ${Bun.randomUUIDv7()}`);
	const findCall = () =>
		`print(await tool.find({ query: "needle lifetime disposal", grep_keywords: ["needle"], path: ${JSON.stringify(path.join(tempDir.path(), "needle.ts"))} }));`;

	describe.each(["live", "beginDispose", "dispose"] as const)("stopped at %s", stop => {
		const expected = (live: boolean[]) => (stop === "live" ? live : []);

		it("a backgrounded cell's judge()", async () => {
			session = createSession({ "eval.autoBackground.enabled": true, "eval.autoBackground.thresholdMs": 0 });
			await runTurn(`print(await judge(${unique()}, { q: { type: "bool", instructions: "Is this text?" } }));`);
			expect(manager.getRunningJobs()).toHaveLength(1);

			await stopAt(stop);
			await manager.waitForAll();

			expect(judgeRequests).toEqual(expected([false]));
		});

		it("a backgrounded cell's tool.find()", async () => {
			session = createSession({ "eval.autoBackground.enabled": true, "eval.autoBackground.thresholdMs": 0 });
			await runTurn(findCall());
			expect(manager.getRunningJobs()).toHaveLength(1);

			await stopAt(stop);
			await manager.waitForAll();

			expect(judgeRequests).toEqual(expected([false, false]));
		});

		it("a judgeBatch() run the cell returned", async () => {
			session = createSession({ "eval.autoBackground.enabled": false });
			await runTurn(
				`print(await judgeBatch([${unique()}], { q: { type: "bool", instructions: "Is this text?" } }, { retries: 0 }));`,
			);
			expect(manager.getRunningJobs()).toHaveLength(1);

			await stopAt(stop);
			await manager.waitForAll();

			expect(judgeRequests).toEqual(expected([false]));
		});

		it("a completion() handle the cell left running", async () => {
			session = createSession({ "eval.autoBackground.enabled": false });
			heldProvider = "anthropic";
			const handleSettled = Promise.withResolvers<void>();
			const releaseSlot = evalRequestSlots.release.bind(evalRequestSlots);
			vi.spyOn(evalRequestSlots, "release").mockImplementation(() => {
				releaseSlot();
				handleSettled.resolve();
			});
			await runTurn(`completion(${unique()}); print("started");`);

			await stopAt(stop);
			await handleSettled.promise;

			// The turn's two requests, then the completion's while the session was live, each through
			// `node:https`, past the global fetch.
			expect(primaryRequests).toEqual([false, false, ...expected([false])]);
			expect(primaryGlobalFetchSends).toBe(0);
		});
	});

	describe.each([
		["with an async job manager", true],
		["without an async job manager", false],
	] as const)("a judge_batch run %s", (_label, withManager) => {
		it.each([
			["sends its request on a live session", false],
			["sends no request once disposal begins during its credential wait", true],
		] as const)("%s", async (_name, dispose) => {
			session = createSession({});
			const tools = toolSession();
			const batchSession = withManager ? tools : { ...tools, asyncJobManager: undefined };
			holding = true;
			const created = await runEvalJudgmentBatch(
				{
					op: "create",
					items: [{ key: "one", state: `state ${Bun.randomUUIDv7()}` }],
					questions: { q: { type: "bool", instructions: "Is this text?" } },
					retries: 0,
				},
				{ session: batchSession },
			);
			if (!("id" in created)) throw new Error("expected the batch status");
			const batch = getJudgmentBatch(created.id, batchSession);
			if (!batch) throw new Error("expected the batch");

			await stopAt(dispose ? "beginDispose" : "live");
			await batch.drain(5_000, undefined);

			expect(judgeRequests).toEqual(dispose ? [] : [false]);
			releaseJudgmentBatches(session.getAgentId() ?? "");
		});
	});

	describe("work the admitted turn still awaits", () => {
		it.each([
			[
				"a floated judge()",
				() => `judge(${unique()}, { q: { type: "bool", instructions: "Is this text?" } }); print("floated");`,
				1,
			],
			["a foreground find", findCall, 2],
		] as const)("%s still reaches the provider after disposal begins", async (_name, code, count) => {
			session = createSession({ "eval.autoBackground.enabled": false });
			evalCode = code();
			session.agent.setTools([new EvalTool(toolSession())]);
			holding = true;
			let settled = false;
			const turn = session.prompt("Run the eval.").finally(() => {
				settled = true;
			});
			await credentialReached.promise;
			expect(settled).toBe(false);

			session.beginDispose();
			releaseCredential.resolve();
			await turn;

			expect(judgeRequests).toEqual(Array(count).fill(true));
		});
	});
});
