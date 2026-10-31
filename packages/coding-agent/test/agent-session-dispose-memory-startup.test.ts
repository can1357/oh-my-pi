/**
 * Local-memory startup is automatic work a session starts on its own: phase one extracts a
 * memory from each earlier transcript, phase two consolidates them. Neither belongs to a turn,
 * so once the session begins disposing neither may reach the provider, not even a request
 * already waiting for its credential. Both requests used to go out with no cancellation.
 *
 * The cases count requests at a local endpoint that speaks HTTPS on `localhost`. The fixture takes
 * the branch production's Anthropic traffic takes: provider `anthropic` over `anthropic-messages`
 * on an `https` URL, no `fetch` of the caller's own, no proxy, so the request leaves `fetch` for
 * `node:https` (`coworkFetch`). Each live control checks that its requests reached the endpoint
 * without passing `globalThis.fetch`, which only the fallback branch calls. One property differs
 * from production and cannot match it: the base URL is the local endpoint, not
 * `https://api.anthropic.com`. The transport is chosen by provider, API and scheme, not by host;
 * the host only drops what the catalog scopes to the official API (request-body compression, the
 * official endpoint's headers and its warm-up).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ApiKeyResolveContext, ApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ApiKeyResolverModel } from "@oh-my-pi/pi-coding-agent/config/api-key-resolver";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { startMemoryStartupTask } from "@oh-my-pi/pi-coding-agent/memories";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { LOOPBACK_TLS, loopbackOrigin, trustLoopbackTls } from "./helpers/loopback-tls";

/** One Anthropic streaming response whose text is `text`. */
function anthropicText(text: string): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_memory",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}

/** Phase one's answer for the earlier transcript, then phase two's consolidation. */
const PHASE_REPLIES = [
	{
		rollout_summary: "The project API design",
		rollout_slug: "api-design",
		raw_memory: "The project API design uses explicit ownership.",
	},
	{ memory_md: "# Memory\n\nExplicit ownership.", memory_summary: "Explicit ownership.", skills: [] },
];

describe("local memory startup at disposal", () => {
	let tempDir: TempDir;
	let server: Bun.Server<undefined>;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	/** For each request the endpoint received, whether the session was disposing. */
	let requests: boolean[];
	/** Requests to the endpoint that passed `globalThis.fetch`: the fallback branch, which production does not take. */
	let globalFetchSends: number;

	trustLoopbackTls();

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-dispose-memory-startup-");
		requests = [];
		globalFetchSends = 0;
		server = Bun.serve({
			...LOOPBACK_TLS,
			port: 0,
			fetch: async request => {
				await request.json();
				const reply = PHASE_REPLIES[requests.length] ?? PHASE_REPLIES[1];
				requests.push(session.isDisposed);
				return anthropicText(JSON.stringify(reply));
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
		const model: Model<Api> = { ...getBundledModel("anthropic", "claude-sonnet-4-5")!, baseUrl: origin };
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		// The current transcript is excluded from extraction; it only has to exist on disk.
		sessionManager.appendMessage({ role: "user", content: "Current conversation.", timestamp: Date.now() });
		await sessionManager.flush();
		// An earlier transcript in the same directory is what phase one extracts from.
		await Bun.write(
			path.join(tempDir.path(), "earlier-thread.jsonl"),
			`${[
				{ type: "session", id: "earlier-thread", cwd: tempDir.path() },
				{ type: "message", message: { role: "user", content: "Remember the project API design." } },
			]
				.map(row => JSON.stringify(row))
				.join("\n")}\n`,
		);
		session = new AgentSession({
			agent: new Agent({ getApiKey: () => "test-key", initialState: { model, systemPrompt: ["Test"], tools: [] } }),
			sessionManager,
			modelRegistry,
			settings: Settings.isolated({
				"memory.backend": "local",
				"memories.minRolloutIdleHours": 0,
				"compaction.enabled": false,
				"retry.enabled": false,
			}),
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		server.stop(true);
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	/**
	 * Start the session's memory startup with the credential of its `phase`th request held until
	 * `release`. `finished` settles once the startup task has ended.
	 */
	function startWithHeldCredential(phase: 1 | 2): {
		credentialReached: Promise<void>;
		release: () => void;
		finished: Promise<void>;
	} {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<void>();
		let resolutions = 0;
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
				if (++resolutions === phase) {
					reached.resolve();
					await release.promise;
				}
				return real(context);
			};
		}) as typeof modelRegistry.resolver);
		const end = session.endLocalMemoryStartup.bind(session);
		vi.spyOn(session, "endLocalMemoryStartup").mockImplementation(signal => {
			end(signal);
			finished.resolve();
		});
		startMemoryStartupTask({
			session,
			settings: session.settings,
			modelRegistry,
			agentDir: tempDir.path(),
			taskDepth: 0,
		});
		return { credentialReached: reached.promise, release: () => release.resolve(), finished: finished.promise };
	}

	it.each([1, 2] as const)("sends both phases on a live session (phase %i credential held)", async phase => {
		const startup = startWithHeldCredential(phase);
		await startup.credentialReached;
		startup.release();
		await startup.finished;

		expect(requests).toEqual([false, false]);
		// Both went out over `node:https`, as production's do; the fallback would have called the global fetch.
		expect(globalFetchSends).toBe(0);
	});

	it("sends no phase-one extraction once disposal begins while its credential resolves", async () => {
		const startup = startWithHeldCredential(1);
		await startup.credentialReached;
		session.beginDispose();
		startup.release();
		await startup.finished;

		expect(requests).toEqual([]);
	});

	it("sends no phase-two consolidation once disposal begins while its credential resolves", async () => {
		const startup = startWithHeldCredential(2);
		await startup.credentialReached;
		session.beginDispose();
		startup.release();
		await startup.finished;

		// Phase one ran while the session was live, over `node:https`; phase two never left.
		expect(requests).toEqual([false]);
		expect(globalFetchSends).toBe(0);
	});
});
