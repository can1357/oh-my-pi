/**
 * A background job that survives its owner's `beginDispose()` is held from that moment: nothing it
 * does reaches the network until the owner's teardown cancels it. The hold is enforced where each
 * request is sent, so it also stops:
 *
 * - a request started in the very continuation that begins the owner's disposal, through each of
 *   pi-ai's five request APIs;
 * - a request whose model headers were still resolving when the hold began;
 * - the requests of a job body that begins its owner's disposal before its first await;
 * - requests that never pass through pi-ai's request APIs, made by a held subagent's tool: a
 *   Hindsight read, a Perplexity search, an OAuth attempt, an MCP call and the tool's own fetch.
 *
 * And a survivor registered after its owner's disposal fired, which nothing else would end, is
 * cancelled when the owner lets go of its jobs.
 *
 * Each case counts what a local endpoint receives, beside a live control that sends. The cases wait
 * real time where they assert that nothing arrives: a request is a loopback HTTPS exchange, which fake
 * time can neither deliver nor rule out.
 *
 * Every endpoint speaks HTTPS on `localhost`, because the scheme picks the transport. The branch each
 * request takes here, and production's:
 *
 * - pi-ai's model APIs (`complete`, `completeSimple`, `stream`, `streamSimple`), the job bodies' model
 *   requests and the held subagent's turns: provider `anthropic` over `anthropic-messages` on an
 *   `https` URL, no `fetch` of the caller's own, no proxy, so the request leaves `fetch` for
 *   `node:https` (`coworkFetch`), as production's Anthropic traffic does. Each live control checks
 *   that such a request reached the endpoint without passing `globalThis.fetch`, which only the
 *   fallback branch calls. One property differs from production and cannot match it: the base URL is
 *   the local endpoint, not `https://api.anthropic.com`. The transport is chosen by provider, API and
 *   scheme, not by host; the host only drops what the catalog scopes to the official API
 *   (request-body compression, the official endpoint's headers and its warm-up).
 * - `withAuth`'s and `withOAuthAccess`'s attempts, the Hindsight read, the MCP call and the tool's own
 *   fetch: the global fetch, which production's credentialed tool requests (web search), Hindsight
 *   client and MCP calls use too.
 * - The Perplexity search: production sends it through pi-ai's OpenAI chat-completions provider to
 *   `api.perplexity.ai`, on that provider's transport, the global fetch. Its URL is fixed, so the
 *   fixture passes a `fetch` of its own that rewrites the URL to the endpoint and calls the global
 *   fetch: the same transport, one wrapper deeper.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Type } from "@oh-my-pi/omptype/typebox";
import { Agent } from "@oh-my-pi/pi-agent-core";
import {
	type Api,
	complete,
	completeSimple,
	type FetchImpl,
	type Model,
	type OAuthAccessSource,
	stream,
	streamSimple,
	withAuth,
	withOAuthAccess,
} from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager, SUBAGENT_TEARDOWN_DECIDES } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { callMCP } from "@oh-my-pi/pi-coding-agent/mcp/json-rpc";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { searchPerplexity } from "@oh-my-pi/pi-coding-agent/web/search/providers/perplexity";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { LOOPBACK_TLS, loopbackOrigin, trustLoopbackTls } from "./helpers/loopback-tls";

/** One Anthropic streaming response: the `raw` tool call when `tool` is set, else the text `done`. */
function anthropicTurn(tool: boolean): Response {
	const block = tool
		? [
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "toolu_raw", name: "raw", input: {} },
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
				id: "msg_hold",
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
			delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
			usage: { output_tokens: 1 },
		},
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}

/** One OpenAI chat-completions stream whose text is `answer`, as Perplexity's API sends it. */
function chatCompletion(): Response {
	const chunk = (delta: object, finish: string | null) =>
		`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "sonar-pro", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	return new Response(`${chunk({ role: "assistant", content: "answer" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`, {
		headers: { "Content-Type": "text/event-stream" },
	});
}

/** The endpoint every counted request goes to. */
interface Site {
	readonly url: string;
	/** Each request that arrived: whether the owner had begun disposing when it did. */
	readonly arrivals: boolean[];
	/**
	 * Each call to the site that reached the global fetch the hold wraps, which sends it: whether the
	 * owner had begun disposing when it was made. A model request never makes one: over HTTPS it is
	 * sent through `node:https`, so only the endpoint sees it.
	 */
	readonly fetches: boolean[];
	/** Resolves when the first request arrives. */
	readonly first: Promise<void>;
}

const APIS = ["withAuth", "complete", "completeSimple", "stream", "streamSimple"] as const;
const RAW_REQUESTS = [
	"Hindsight recall",
	"Perplexity search",
	"withOAuthAccess",
	"MCP over HTTP",
	"the tool's own fetch",
] as const;

describe("a held job sends nothing from its owner's beginDispose() on", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let manager: AsyncJobManager;
	let owner: AgentSession;
	let site: Site;
	let server: Bun.Server<undefined>;
	let previousFetch: typeof globalThis.fetch;
	const cleanups: Array<() => Promise<void> | void> = [];

	trustLoopbackTls();

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-hold-at-send-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("perplexity", "pplx-key");
		manager = new AsyncJobManager({ onJobComplete: () => {}, maxRunningJobs: 8 });
		owner = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
					systemPrompt: ["Test"],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "owner.yml")),
			settings: Settings.isolated({ "compaction.enabled": false }),
			agentId: "Main",
			ownedAsyncJobManager: manager,
		});
		const first = Promise.withResolvers<void>();
		const arrivals: boolean[] = [];
		const fetches: boolean[] = [];
		server = Bun.serve({
			...LOOPBACK_TLS,
			port: 0,
			fetch: async request => {
				const body = await request.text();
				arrivals.push(owner.isDisposed);
				first.resolve();
				const { pathname } = new URL(request.url);
				if (pathname.endsWith("/messages")) return anthropicTurn(false);
				if (pathname.endsWith("/chat/completions")) return chatCompletion();
				if (pathname === "/mcp") return Response.json({ jsonrpc: "2.0", id: JSON.parse(body).id, result: {} });
				return Response.json({ results: [] });
			},
		});
		site = { url: loopbackOrigin(server), arrivals, fetches, first: first.promise };
		// Recorded beneath the hold: the next hold scope wraps whatever the global fetch is then.
		previousFetch = globalThis.fetch;
		const sendingFetch = previousFetch;
		globalThis.fetch = Object.assign(
			(input: string | URL | Request, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url.startsWith(site.url)) fetches.push(owner.isDisposed);
				return sendingFetch(input, init);
			},
			{ preconnect: sendingFetch.preconnect },
		) as typeof fetch;
	});

	afterEach(async () => {
		await owner.dispose();
		await manager.dispose({ timeoutMs: 3_000 });
		for (const cleanup of cleanups.splice(0)) await cleanup();
		globalThis.fetch = previousFetch;
		server.stop(true);
		authStorage.close();
		tempDir.removeSync();
	});

	const siteModel = (): Model<Api> => ({ ...getBundledModel("anthropic", "claude-sonnet-4-5")!, baseUrl: site.url });
	const context = () => ({ messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] });

	/** Start one request through `api` to the site. */
	function startRequest(api: (typeof APIS)[number], model: Model<Api>, signal: AbortSignal): Promise<unknown> {
		const options = { apiKey: "test-key", signal };
		switch (api) {
			case "withAuth":
				return withAuth(
					"test-key",
					key =>
						fetch(site.url, {
							method: "POST",
							body: "{}",
							headers: { authorization: `Bearer ${key}` },
							signal,
						}),
					{ signal },
				);
			case "complete":
				return complete(model, context(), options);
			case "completeSimple":
				return completeSimple(model, context(), options);
			case "stream":
				return stream(model, context(), options).result();
			case "streamSimple":
				return streamSimple(model, context(), options).result();
		}
	}

	/** Requests and real fetch calls made after the owner began disposing, and the job's state. */
	function afterDisposal(jobId: string) {
		const job = manager.getJob(jobId)!;
		return {
			held: job.requestHold?.aborted,
			status: job.status,
			fetches: site.fetches.filter(Boolean).length,
			arrivals: site.arrivals.filter(Boolean).length,
		};
	}

	/** The job's state and every request that reached the site, whenever it was sent. */
	function sent(jobId: string) {
		const job = manager.getJob(jobId)!;
		return { held: job.requestHold?.aborted, status: job.status, arrivals: site.arrivals.length };
	}

	/** Wait for the first request, or long enough that one would have arrived. */
	const firstRequestOrQuiet = (quietMs = 500) => Promise.race([site.first, Bun.sleep(quietMs)]);

	describe("a request started in the continuation that begins disposal", () => {
		it.each([...APIS])("%s sends nothing once disposal began", async api => {
			const go = Promise.withResolvers<void>();
			const jobId = manager.register(
				"task",
				api,
				async ({ signal }) => {
					await go.promise;
					const pending = startRequest(api, siteModel(), signal).catch(() => undefined);
					owner.beginDispose();
					await pending;
					return "settled";
				},
				{ ownerId: "Main", survivesBeginDispose: SUBAGENT_TEARDOWN_DECIDES },
			);
			go.resolve();
			await firstRequestOrQuiet();

			if (api === "withAuth") {
				// `withAuth` makes its one attempt, through the global fetch, in the call itself, before
				// `beginDispose()`: that request was sent before the hold, so it may land after; every request
				// that lands was that fetch. The hold then aborts it, since its response had not begun, so that
				// job ends instead of waiting held. Over HTTPS the abort can come during the TLS handshake,
				// before the request is written, so whether it lands is not fixed.
				expect(afterDisposal(jobId)).toMatchObject({ held: true, status: "completed" });
				expect(site.fetches).toEqual([false]);
				expect(site.arrivals.length).toBeLessThanOrEqual(site.fetches.length);
				return;
			}
			// A model API awaits its credential and headers before it reaches the transport, so it sends, if
			// at all, after the `beginDispose()` of this continuation: every request that lands came from the
			// held scope. It goes through `node:https`, past the global fetch, so it is counted where it lands.
			expect(sent(jobId)).toEqual({ held: true, status: "running", arrivals: 0 });
		});

		it.each([...APIS])("%s is sent when the owner is not disposing (control)", async api => {
			const jobId = manager.register(
				"task",
				api,
				async ({ signal }) => {
					await startRequest(api, siteModel(), signal);
					return "sent";
				},
				{ ownerId: "Main", survivesBeginDispose: SUBAGENT_TEARDOWN_DECIDES },
			);
			await manager.getJob(jobId)!.promise;

			// A model API's request reaches the endpoint without passing the global fetch: production's branch.
			expect({ status: manager.getJob(jobId)!.status, fetches: site.fetches, arrivals: site.arrivals }).toEqual({
				status: "completed",
				fetches: api === "withAuth" ? [false] : [],
				arrivals: [false],
			});
		});
	});

	describe("a request whose model headers resolve after the hold began", () => {
		it.each(["complete", "stream"] as const)("%s is not sent", async api => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			cleanups.push(() => release.resolve());
			const model: Model<Api> = {
				...siteModel(),
				resolveHeaders: async () => {
					entered.resolve();
					await release.promise;
					return {};
				},
			};
			const jobId = manager.register(
				"task",
				api,
				async ({ signal }) => {
					await startRequest(api, model, signal).catch(() => undefined);
					return "settled";
				},
				{ ownerId: "Main", survivesBeginDispose: SUBAGENT_TEARDOWN_DECIDES },
			);
			await entered.promise;
			owner.beginDispose();
			release.resolve();
			await firstRequestOrQuiet();

			// The headers resolve only after `beginDispose()`, so the request is sent, if at all, from the held
			// scope, through `node:https`: it is counted where it lands.
			expect(sent(jobId)).toEqual({ held: true, status: "running", arrivals: 0 });
		});

		it.each(["complete", "stream"] as const)("%s is sent when the owner is not disposing (control)", async api => {
			const model: Model<Api> = { ...siteModel(), resolveHeaders: async () => ({}) };
			const jobId = manager.register(
				"task",
				api,
				async ({ signal }) => {
					await startRequest(api, model, signal);
					return "sent";
				},
				{ ownerId: "Main", survivesBeginDispose: SUBAGENT_TEARDOWN_DECIDES },
			);
			await manager.getJob(jobId)!.promise;

			// It reaches the endpoint without passing the global fetch: production's branch.
			expect({ fetches: site.fetches, arrivals: site.arrivals }).toEqual({ fetches: [], arrivals: [false] });
		});
	});

	describe("a job body that begins its owner's disposal before its first await", () => {
		/** Eight credentialed model requests, one after another, as a subagent's turns make them. */
		async function sendEight(signal: AbortSignal): Promise<string> {
			for (let index = 0; index < 8; index++) {
				await complete(siteModel(), context(), { apiKey: "test-key", signal });
			}
			return "sent";
		}

		it.each([
			["held", true],
			["cancelled", false],
		] as const)("is %s, and sends nothing", async (_outcome, survives) => {
			const jobId = manager.register(
				"task",
				"reentrant",
				async ({ signal }) => {
					owner.beginDispose();
					return sendEight(signal);
				},
				{ ownerId: "Main", ...(survives ? { survivesBeginDispose: SUBAGENT_TEARDOWN_DECIDES } : {}) },
			);
			await firstRequestOrQuiet();

			// The body begins its owner's disposal before it makes any request: every request that lands came
			// from the held scope, through `node:https`.
			expect(sent(jobId)).toEqual({ held: true, status: survives ? "running" : "cancelled", arrivals: 0 });
		});

		it("sends all eight when it does not begin its owner's disposal (control)", async () => {
			const jobId = manager.register("task", "plain", async ({ signal }) => sendEight(signal), {
				ownerId: "Main",
				survivesBeginDispose: SUBAGENT_TEARDOWN_DECIDES,
			});
			const job = manager.getJob(jobId)!;
			await job.promise;

			// Each request reached the endpoint without passing the global fetch: production's branch.
			expect({ status: job.status, arrivals: site.arrivals.length, fetches: site.fetches.length }).toEqual({
				status: "completed",
				arrivals: 8,
				fetches: 0,
			});
		});
	});

	describe("a held subagent's tool, past pi-ai's request APIs", () => {
		/** Sends every request to the site, keeping its path and headers. */
		const toSite: FetchImpl = (input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			return fetch(`${site.url}${url.pathname}${url.search}`, init);
		};
		const oauthStorage = {
			oauth: { access: async () => ({ accessToken: "oauth-token", credentialId: 1 }) },
			limits: { rotate: async () => ({ switched: false }) },
		} as unknown as OAuthAccessSource;

		/** One request of `kind`, with the session-style credential each carries. */
		function rawRequest(kind: (typeof RAW_REQUESTS)[number], signal: AbortSignal): Promise<unknown> {
			switch (kind) {
				case "Hindsight recall":
					return new HindsightApi({ baseUrl: site.url, apiKey: "hindsight-token" }).recall("bank", "query", {
						signal,
					});
				case "Perplexity search":
					return searchPerplexity({ query: "test", system_prompt: "search", authStorage, signal, fetch: toSite });
				case "withOAuthAccess":
					return withOAuthAccess(
						oauthStorage,
						"openai-codex",
						access =>
							fetch(site.url, {
								method: "POST",
								body: "{}",
								headers: { authorization: `Bearer ${access.accessToken}` },
								signal,
							}),
						{ signal },
					);
				case "MCP over HTTP":
					return callMCP(
						`${site.url}/mcp`,
						"tools/call",
						{ name: "query" },
						{ signal, headers: { authorization: "Bearer mcp-token" } },
					);
				case "the tool's own fetch":
					return fetch(`${site.url}/tool`, {
						method: "POST",
						body: "{}",
						headers: { authorization: "Bearer tool-token" },
						signal,
					});
			}
		}

		/**
		 * A real child session in a surviving job whose model calls the `raw` tool once; the tool waits
		 * for `release`, then makes three requests of `kind`.
		 */
		async function startHeldTool(kind: (typeof RAW_REQUESTS)[number]) {
			const toolStarted = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const toolDone = Promise.withResolvers<void>();
			cleanups.push(() => release.resolve());
			let turns = 0;
			const modelServer = Bun.serve({
				...LOOPBACK_TLS,
				port: 0,
				fetch: async request => {
					await request.arrayBuffer();
					return anthropicTurn(++turns === 1);
				},
			});
			const child = new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: {
						model: {
							...getBundledModel("anthropic", "claude-sonnet-4-5")!,
							baseUrl: loopbackOrigin(modelServer),
						},
						systemPrompt: ["Test"],
						tools: [],
					},
				}),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "child.yml")),
				settings: Settings.isolated({ "compaction.enabled": false }),
			});
			cleanups.push(async () => {
				await child.dispose();
				modelServer.stop(true);
			});
			child.agent.setTools([
				{
					name: "raw",
					label: "raw",
					description: "Make a request",
					parameters: Type.Object({}),
					execute: async (_id, _args, signal) => {
						toolStarted.resolve();
						await release.promise;
						try {
							for (let index = 0; index < 3; index++)
								await rawRequest(kind, signal ?? new AbortController().signal);
						} catch {
							// A refused or failed request ends the tool; the endpoint has counted what was sent.
						} finally {
							toolDone.resolve();
						}
						return { content: [{ type: "text", text: "done" }], details: {} };
					},
				},
			]);
			const jobId = manager.register(
				"task",
				"held subagent",
				async ({ signal }) => {
					signal.addEventListener("abort", () => void child.abort(), { once: true });
					await child.prompt("Use raw.").catch(() => undefined);
					return "stopped";
				},
				{ ownerId: "Main", agentId: "child", survivesBeginDispose: SUBAGENT_TEARDOWN_DECIDES },
			);
			await toolStarted.promise;
			return { jobId, release: () => release.resolve(), toolDone: toolDone.promise };
		}

		it.each([...RAW_REQUESTS])("%s is not sent", async kind => {
			const tool = await startHeldTool(kind);
			owner.beginDispose();
			tool.release();
			await Promise.race([tool.toolDone, Bun.sleep(1_000)]);

			expect(afterDisposal(tool.jobId)).toEqual({ held: true, status: "running", fetches: 0, arrivals: 0 });
		});

		it.each([...RAW_REQUESTS])("%s is sent when the owner is not disposing (control)", async kind => {
			const tool = await startHeldTool(kind);
			tool.release();
			await tool.toolDone;

			expect(site.arrivals.length).toBeGreaterThanOrEqual(1);
			expect(site.fetches.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("a survivor registered after its owner's disposal fired", () => {
		let late: AsyncJobManager;

		beforeEach(() => {
			late = new AsyncJobManager({ onJobComplete: () => {}, maxRunningJobs: 8 });
			cleanups.push(() => late.dispose({ timeoutMs: 3_000 }).then(() => undefined));
		});

		/** A surviving job for `Late` that sends one credentialed model request once `go` resolves. */
		function registerLate(go: Promise<void> = Promise.resolve()): string {
			return late.register(
				"task",
				"late survivor",
				async ({ signal }) => {
					await go;
					await complete(siteModel(), context(), { apiKey: "test-key", signal });
					return "sent";
				},
				{ ownerId: "Late", survivesBeginDispose: SUBAGENT_TEARDOWN_DECIDES },
			);
		}

		/** The job's state once it settles, or as it stands a second later. */
		async function settledState(jobId: string) {
			const job = late.getJob(jobId)!;
			await Promise.race([job.promise, Bun.sleep(1_000)]);
			return {
				status: job.status,
				cancelled: job.abortController.signal.aborted,
				arrivals: site.arrivals.length,
				fetches: site.fetches.length,
			};
		}

		it.each(["removed", "replaced by a new one"] as const)(
			"is cancelled, having sent nothing, when its owner's binding is %s",
			async change => {
				const disposal = new AbortController();
				const unbind = late.bindOwnerDisposal("Late", disposal.signal);
				disposal.abort();
				const jobId = registerLate();
				await firstRequestOrQuiet(100);
				const job = late.getJob(jobId)!;
				expect({ status: job.status, held: job.requestHold?.aborted, arrivals: site.arrivals.length }).toEqual({
					status: "running",
					held: true,
					arrivals: 0,
				});

				if (change === "removed") unbind();
				else late.bindOwnerDisposal("Late", new AbortController().signal);

				expect(await settledState(jobId)).toEqual({
					status: "cancelled",
					cancelled: true,
					arrivals: 0,
					fetches: 0,
				});
			},
		);

		it("runs to completion, and sends, when its owner is not disposing (control)", async () => {
			const go = Promise.withResolvers<void>();
			const unbind = late.bindOwnerDisposal("Late", new AbortController().signal);
			const jobId = registerLate(go.promise);
			unbind();
			go.resolve();

			// It reaches the endpoint without passing the global fetch: production's branch.
			expect(await settledState(jobId)).toEqual({ status: "completed", cancelled: false, arrivals: 1, fetches: 0 });
		});
	});
});
