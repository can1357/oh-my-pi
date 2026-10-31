/**
 * A custom command the session runs (`/annotate` among them) lives no longer than the session: its
 * context carries the session's disposal signal, so a model request it passes that signal to stops
 * when the session begins disposing. `/annotate`'s summary request used to run on with only its
 * 60-second deadline.
 *
 * Counted at a local endpoint that speaks HTTPS on `localhost`, with the summary's credential held
 * while the session stops. The fixture takes the branch production's Anthropic traffic takes:
 * provider `anthropic` over `anthropic-messages` on an `https` URL, no `fetch` of the caller's own,
 * no proxy, so the request leaves `fetch` for `node:https` (`coworkFetch`). The live control checks
 * that its request reached the endpoint without passing `globalThis.fetch`, which only the fallback
 * branch calls. One property differs from production and cannot match it: the base URL is the local
 * endpoint, not `https://api.anthropic.com`. The transport is chosen by provider, API and scheme,
 * not by host; the host only drops what the catalog scopes to the official API (request-body
 * compression, the official endpoint's headers and its warm-up).
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
import { generateTextReviewContextSummary } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/text-summary";
import type { LoadedCustomCommand } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
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
				id: "msg_summary",
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

describe("a custom command's model request at disposal", () => {
	let tempDir: TempDir;
	let server: Bun.Server<undefined>;
	let authStorage: AuthStorage;
	let session: AgentSession;
	/** For each request the endpoint received, whether the session was disposing. */
	let requests: boolean[];
	let credentialReached: PromiseWithResolvers<void>;
	let releaseCredential: PromiseWithResolvers<void>;
	let commandSettled: PromiseWithResolvers<void>;
	/** Requests to the endpoint that passed `globalThis.fetch`: the fallback branch, which production does not take. */
	let globalFetchSends: number;

	trustLoopbackTls();

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-dispose-command-request-");
		requests = [];
		credentialReached = Promise.withResolvers<void>();
		releaseCredential = Promise.withResolvers<void>();
		commandSettled = Promise.withResolvers<void>();
		globalFetchSends = 0;
		server = Bun.serve({
			...LOOPBACK_TLS,
			port: 0,
			fetch: async request => {
				await request.json();
				requests.push(session.isDisposed);
				return anthropicText("A summary.");
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
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
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
		// The summary `/annotate` requests, run by a command the way `/annotate` runs it.
		const summarize: LoadedCustomCommand = {
			path: "summarize",
			resolvedPath: "summarize",
			source: "bundled",
			command: {
				name: "summarize",
				description: "Summarize a source the way /annotate does",
				async execute(_args, ctx) {
					try {
						await generateTextReviewContextSummary(ctx, "Source text for annotation.", ctx.signal);
					} finally {
						commandSettled.resolve();
					}
					return undefined;
				},
			},
		};
		session = new AgentSession({
			agent: new Agent({ getApiKey: () => "test-key", initialState: { model, systemPrompt: ["Test"], tools: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			customCommands: [summarize],
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

	it("sends the command's request on a live session", async () => {
		const running = session.prompt("/summarize");
		await credentialReached.promise;
		releaseCredential.resolve();
		await commandSettled.promise;
		await running;

		expect({ requests, globalFetchSends }).toEqual({ requests: [false], globalFetchSends: 0 });
	});

	it("sends no request once the session running the command begins disposing", async () => {
		const running = session.prompt("/summarize").catch(() => undefined);
		await credentialReached.promise;
		session.beginDispose();
		releaseCredential.resolve();
		await commandSettled.promise;
		await running;

		expect(requests).toEqual([]);
	});
});
