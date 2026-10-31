/**
 * Sharpshooter extracts project-decision deltas from each prompt in a request of its own. One
 * started before the session began disposing is a bounded flush: `dispose()` waits for it up to its
 * flush timeout and a reply that lands in time is kept, so a print-mode exit does not lose the
 * prompt's deltas. Past that bound it is cancelled, so no request is paid for whose reply nobody
 * keeps; and none starts once disposal has begun. It used to send its request after the bound and
 * then throw the reply away because the session was disposed.
 *
 * Counted at a local endpoint, with the extraction's credential held while the session stops. The
 * endpoint speaks HTTPS on `localhost`. The fixture takes the branch production's Anthropic traffic
 * takes: provider `anthropic` over `anthropic-messages` on an `https` URL, no `fetch` of the caller's
 * own, no proxy, so the request leaves `fetch` for `node:https` (`coworkFetch`). Each case whose
 * request arrives checks that it reached the endpoint without passing `globalThis.fetch`, which only
 * the fallback branch calls. One property differs from production and cannot match it: the base URL
 * is the local endpoint, not `https://api.anthropic.com`. The transport is chosen by provider, API
 * and scheme, not by host; the host only drops what the catalog scopes to the official API
 * (request-body compression, the official endpoint's headers and its warm-up).
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
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	flushSharpshooterExtraction,
	maybeStartSharpshooterExtraction,
} from "@oh-my-pi/pi-coding-agent/sharpshooter/extract";
import { listSharpshooterDeltas } from "@oh-my-pi/pi-coding-agent/sharpshooter/queue";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { LOOPBACK_TLS, loopbackOrigin, trustLoopbackTls } from "./helpers/loopback-tls";

const PROMPT = "Keep boundaries explicit. This durable architecture decision governs the whole project.";

/** An Anthropic streaming reply that records one delta whose evidence is in {@link PROMPT}. */
function deltaReply(): Response {
	const delta = {
		kind: "architecture_decision",
		statement: "Keep boundaries explicit.",
		source: "explicit_user",
		evidence: "Keep boundaries explicit.",
		friction: { corrective: false, regression: false, subtle: true },
	};
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_extract",
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
			content_block: { type: "tool_use", id: "toolu_delta", name: "record_deltas", input: {} },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: JSON.stringify({ deltas: [delta] }) },
		},
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}

describe("Sharpshooter extraction at disposal", () => {
	let tempDir: TempDir;
	let server: Bun.Server<undefined>;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	/** For each request the endpoint received, whether the session was disposing. */
	let requests: boolean[];
	/** Requests to the endpoint that passed `globalThis.fetch`: the fallback branch, which production does not take. */
	let globalFetchSends: number;
	let credentialReached: PromiseWithResolvers<void>;
	let releaseCredential: PromiseWithResolvers<void>;

	trustLoopbackTls();

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-sharpshooter-dispose-");
		requests = [];
		globalFetchSends = 0;
		credentialReached = Promise.withResolvers<void>();
		releaseCredential = Promise.withResolvers<void>();
		server = Bun.serve({
			...LOOPBACK_TLS,
			port: 0,
			fetch: async request => {
				await request.json();
				requests.push(session.isDisposed);
				return deltaReply();
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
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([model]);
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
				credentialReached.resolve();
				await releaseCredential.promise;
				return real(context);
			};
		}) as typeof modelRegistry.resolver);
		session = new AgentSession({
			agent: new Agent({ getApiKey: () => "test-key", initialState: { model, systemPrompt: ["Test"], tools: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			modelRegistry,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"sharpshooter.model": "anthropic/claude-sonnet-4-5",
				"sharpshooter.minPromptLength": 2,
			}),
		});
	});

	afterEach(async () => {
		releaseCredential.resolve();
		await session.dispose();
		authStorage.close();
		server.stop(true);
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	function start(): void {
		maybeStartSharpshooterExtraction({
			session,
			settings: session.settings,
			modelRegistry,
			agentDir: tempDir.path(),
			message: { role: "user", content: PROMPT, timestamp: Date.now() },
		});
	}

	async function deltas(): Promise<number> {
		const groups = await listSharpshooterDeltas(tempDir.path(), tempDir.path());
		return groups.flatMap(group => group.deltas).length;
	}

	it("keeps the deltas of a live session", async () => {
		start();
		await credentialReached.promise;
		releaseCredential.resolve();
		await flushSharpshooterExtraction(session);

		expect(requests).toEqual([false]);
		// It went out over `node:https`, as production's does; the fallback would have called the global fetch.
		expect(globalFetchSends).toBe(0);
		expect(await deltas()).toBe(1);
	});

	it("keeps the deltas of an extraction whose reply lands after disposal began, within the flush bound", async () => {
		start();
		await credentialReached.promise;
		session.beginDispose();
		releaseCredential.resolve();
		await flushSharpshooterExtraction(session);

		expect(requests).toEqual([true]);
		expect(globalFetchSends).toBe(0);
		expect(await deltas()).toBe(1);
	});

	it("cancels an extraction still waiting when dispose()'s flush bound expires", async () => {
		start();
		await credentialReached.promise;
		await session.dispose({ mnemopiConsolidateTimeoutMs: 10 });
		releaseCredential.resolve();
		await flushSharpshooterExtraction(session);

		expect(requests).toEqual([]);
		expect(await deltas()).toBe(0);
	});

	it("starts no extraction once disposal has begun", async () => {
		session.beginDispose();
		start();
		await flushSharpshooterExtraction(session);

		expect(requests).toEqual([]);
		expect(await deltas()).toBe(0);
	});
});
