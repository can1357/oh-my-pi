/**
 * A background job that runs a lifecycle-tracked subagent survives its owner's `beginDispose()`, so
 * the owner's teardown can still choose to park, detach or end it. It must not keep reaching the
 * provider while it waits for that choice: from `beginDispose()` on, every provider request it makes
 * is held, and the job stays alive, idle, until `dispose()` cancels it with the reason it chose.
 * These jobs used to keep running their subagents' turns through the shutdown hooks and any wait a
 * wrapper made before `dispose()`: hundreds of credentialed requests in two seconds.
 *
 * Seven surviving jobs (one per kind that registers that way) and an ordinary control each run a
 * real session whose model calls a tool over and over against a local endpoint answering in 5 ms.
 * The cases count what each endpoint receives once the owner has begun disposing. Retries are on, as
 * in a real session: in one case every endpoint answers with a rate limit, so the owner begins
 * disposing while each provider client waits out its `retry-after` before sending again.
 *
 * Every endpoint speaks HTTPS on `localhost`. The fixture takes the branch production's Anthropic
 * traffic takes: provider `anthropic` over `anthropic-messages` on an `https` URL, no `fetch` of the
 * caller's own, no proxy, so each request, its retries included, leaves `fetch` for `node:https`
 * (`coworkFetch`). Each case checks that no request reached an endpoint through `globalThis.fetch`,
 * which only the fallback branch calls. One property differs from production and cannot match it:
 * the base URL is the local endpoint, not `https://api.anthropic.com`. The transport is chosen by
 * provider, API and scheme, not by host; the host only drops what the catalog scopes to the official
 * API (request-body compression, the official endpoint's headers and its warm-up).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Type } from "@oh-my-pi/omptype/typebox";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	ASYNC_JOB_MANAGER_SHUTDOWN_REASON,
	AsyncJobManager,
	SUBAGENT_TEARDOWN_DECIDES,
} from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { LOOPBACK_TLS, loopbackOrigin, trustLoopbackTls } from "./helpers/loopback-tls";

/** One Anthropic streaming response that calls the `again` tool. */
function callAgain(id: number): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: `msg_${id}`,
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: `toolu_${id}`, name: "again", input: {} },
		},
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}

/** An Anthropic rate limit that asks the client to retry in one second. */
function rateLimited(): Response {
	return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Slow down" } }), {
		status: 429,
		headers: { "content-type": "application/json", "retry-after": "1" },
	});
}

/** The seven registrations that survive `beginDispose()`, and an ordinary job as control. */
const SURVIVORS = ["eval agent()", "task", "task executor", "restore", "workpool", "workpool worker", "vibe"];

interface Child {
	name: string;
	survives: boolean;
	session: AgentSession;
	server: Bun.Server<undefined>;
	/** Requests the child's endpoint received. */
	requests: number;
	/** Requests the child's endpoint received once the owner had begun disposing. */
	afterDisposal: number;
	jobId: string;
}

describe("subagent jobs that survive their owner's beginDispose()", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let manager: AsyncJobManager;
	let owner: AgentSession;
	let children: Child[];
	/** The children's endpoints, and requests to them that passed `globalThis.fetch`: the fallback branch. */
	let origins: Set<string>;
	let globalFetchSends: number;

	trustLoopbackTls();

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-dispose-held-subagents-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		manager = new AsyncJobManager({ onJobComplete: () => {}, maxRunningJobs: 16 });
		children = [];
		origins = new Set();
		globalFetchSends = 0;
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
			if (origins.has(new URL(input instanceof Request ? input.url : String(input)).origin)) globalFetchSends++;
			return realFetch(input, init);
		}) as typeof fetch);
	});

	afterEach(async () => {
		await owner?.dispose();
		await manager.dispose({ timeoutMs: 3_000 });
		for (const child of children) {
			await child.session.dispose();
			child.server.stop(true);
		}
		authStorage.close();
		tempDir.removeSync();
	});

	/** The owner, with `stuckShutdownHandlers` `session_shutdown` handlers that never return. */
	async function createOwner(stuckShutdownHandlers: number): Promise<AgentSession> {
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				for (let index = 0; index < stuckShutdownHandlers; index++) {
					pi.on("session_shutdown", () => new Promise<void>(() => {}));
				}
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"stuck-shutdown",
		);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		owner = new AgentSession({
			agent: new Agent({ getApiKey: () => "test-key", initialState: { model, systemPrompt: ["Test"], tools: [] } }),
			sessionManager,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			agentId: "Main",
			ownedAsyncJobManager: manager,
			extensionRunner: new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry),
		});
		return owner;
	}

	/**
	 * Start a job for the owner whose child session loops on a tool until the job is cancelled. With
	 * `rateLimit`, the child's endpoint answers every request with a one-second rate limit instead.
	 */
	async function startChild(name: string, survives: boolean, rateLimit = false): Promise<void> {
		const firstRequest = Promise.withResolvers<void>();
		const child = { name, survives, requests: 0, afterDisposal: 0 } as Child;
		child.server = Bun.serve({
			...LOOPBACK_TLS,
			port: 0,
			fetch: async request => {
				await request.json();
				child.requests++;
				if (owner.isDisposed) child.afterDisposal++;
				firstRequest.resolve();
				if (rateLimit) return rateLimited();
				// A real 5 ms provider latency: the loops make real HTTPS turns, which fake time cannot count.
				await Bun.sleep(5);
				return callAgain(child.requests);
			},
		});
		origins.add(loopbackOrigin(child.server));
		const model: Model<Api> = {
			...getBundledModel("anthropic", "claude-sonnet-4-5")!,
			baseUrl: loopbackOrigin(child.server),
		};
		child.session = new AgentSession({
			agent: new Agent({ getApiKey: () => "test-key", initialState: { model, systemPrompt: ["Test"], tools: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), `${name}.yml`)),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": true }),
		});
		child.session.agent.setTools([
			{
				name: "again",
				label: "again",
				description: "Continue",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "next" }], details: {} }),
			},
		]);
		child.jobId = manager.register(
			"task",
			name,
			async ({ signal }) => {
				signal.addEventListener("abort", () => void child.session.abort(), { once: true });
				await child.session.prompt("Use again repeatedly.").catch(() => undefined);
				return "stopped";
			},
			{
				ownerId: "Main",
				agentId: `child-${children.length}`,
				...(survives ? { survivesBeginDispose: SUBAGENT_TEARDOWN_DECIDES } : {}),
			},
		);
		children.push(child);
		await firstRequest.promise;
	}

	async function startAll(): Promise<void> {
		for (const name of SURVIVORS) await startChild(name, true);
		await startChild("ordinary job", false);
	}

	/**
	 * Requests after disposal began: a surviving job's request already sent then may land; nothing else
	 * reaches an endpoint. The control job is cancelled at once. Every request, before disposal or
	 * after, went through `node:https`, past the global fetch: production's branch.
	 */
	function expectHeld(): void {
		const counts = children.map(child => ({ child: child.name, requests: child.afterDisposal }));
		const allowed = children.map(child => ({
			child: child.name,
			requests: Math.min(child.afterDisposal, child.survives ? 1 : 0),
		}));
		expect(counts).toEqual(allowed);
		expect(globalFetchSends).toBe(0);
	}

	it("holds them, alive, through a wrapper's wait before dispose()", async () => {
		await createOwner(0);
		await startAll();

		owner.beginDispose();
		// A wrapper's wait between beginDispose() and dispose(), in real time so real turns could run in it.
		await Bun.sleep(750);
		const survivors = children.filter(child => child.survives).map(child => manager.getJob(child.jobId)!);
		const statuses = survivors.map(job => job.status);
		await owner.dispose();
		await manager.waitForAll();

		// Alive and undecided until dispose() chose: the owning session's shutdown parks them.
		expect(statuses).toEqual(survivors.map(() => "running"));
		expect(survivors.map(job => job.abortController.signal.reason)).toEqual(
			survivors.map(() => ASYNC_JOB_MANAGER_SHUTDOWN_REASON),
		);
		expectHeld();
	}, 20_000);

	it.each([1, 3])(
		"holds them through %i stuck shutdown handler(s)",
		async handlers => {
			await createOwner(handlers);
			await startAll();

			await owner.dispose();
			await manager.waitForAll();

			expectHeld();
		},
		20_000,
	);

	it("holds them while their provider clients wait out a rate limit", async () => {
		await createOwner(0);
		for (const name of SURVIVORS) await startChild(name, true, true);
		await startChild("ordinary job", false, true);

		// Every child's first request was answered with a one-second `retry-after`; its client is waiting
		// to send it again when the owner begins disposing. The wait outlasts the retry, in real time:
		// the client's backoff runs on the real clock.
		owner.beginDispose();
		await Bun.sleep(1_500);
		const counts = children.map(child => ({ child: child.name, requests: child.afterDisposal }));
		await owner.dispose();
		await manager.waitForAll();

		expect(counts).toEqual(children.map(child => ({ child: child.name, requests: 0 })));
		expect(globalFetchSends).toBe(0);
	}, 20_000);

	it("lets a child whose owner is not disposing send its retry once the rate limit passes (control)", async () => {
		await createOwner(0);
		await startChild("task", true, true);

		await Bun.sleep(1_500);

		expect(children[0].requests).toBeGreaterThanOrEqual(2);
		// Its first request and its retry went through `node:https`, past the global fetch: production's branch.
		expect(globalFetchSends).toBe(0);
	}, 20_000);
});
