/**
 * Mnemopi recall derives an embedding for its query, a request to the configured embedding
 * endpoint with its credential. It is a read: nothing is lost when it is cancelled, so it stops
 * with whoever asked for it. The `recall` and `reflect` tools' requests stop with their tool call,
 * and auto-recall for compaction stops with the signal it is given (the session's disposal).
 * Each used to send its embedding request after its owner was gone.
 *
 * Counted at a local embedding endpoint, with the embedding credential held while the owner stops.
 * The endpoint speaks HTTPS on `localhost`, as production's embedding endpoint (OpenRouter by
 * default) does. The fixture takes production's branch: the embedding request goes through
 * `fetchWithRetry` with no `fetch` of its own, so it is sent by `globalThis.fetch` over HTTPS, with
 * record headers and no proxy. One property differs from production and cannot match it: the
 * endpoint is not OpenRouter, so `embedApi` skips its "is a key configured" check; the fixture's key
 * is a configured resolver, so production passes that check too and the send path is the same.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import { MemoryReflectTool } from "@oh-my-pi/pi-coding-agent/tools/memory-reflect";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { LOOPBACK_TLS, loopbackOrigin, trustLoopbackTls } from "./helpers/loopback-tls";

await Promise.all([loadMnemopi(), loadMnemopiCore()]);

describe("Mnemopi recall embeddings at cancellation", () => {
	let tempDir: TempDir;
	let server: Bun.Server<undefined>;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let state: MnemopiSessionState;
	/** For each embedding request the endpoint received, whether its owner had stopped. */
	let requests: boolean[];
	let ownerStopped: boolean;
	let credentialReached: PromiseWithResolvers<void>;
	let releaseCredential: PromiseWithResolvers<void>;
	/** Every scoped recall started, so a case can wait for the read underneath a returned tool call. */
	let reads: Promise<unknown>[];

	trustLoopbackTls();

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-mnemopi-recall-cancel-");
		requests = [];
		reads = [];
		ownerStopped = false;
		credentialReached = Promise.withResolvers<void>();
		releaseCredential = Promise.withResolvers<void>();
		server = Bun.serve({
			...LOOPBACK_TLS,
			port: 0,
			fetch: async request => {
				await request.json();
				requests.push(ownerStopped);
				return Response.json({ data: [{ embedding: [1, 0, 0] }] });
			},
		});
		authStorage = createInMemoryAuthStorage();
		const model: Model<Api> = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"memory.backend": "mnemopi",
			"mnemopi.scoping": "global",
			"mnemopi.noEmbeddings": false,
			"mnemopi.llmMode": "none",
			"mnemopi.autoRetain": false,
			"mnemopi.embeddingModel": "openai/text-embedding-3-small",
		});
		session = new AgentSession({
			agent: new Agent({ getApiKey: () => "test-key", initialState: { model, systemPrompt: ["Test"], tools: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			settings,
		});
		const config = loadMnemopiConfig(settings, tempDir.path());
		config.providerOptions = {
			...config.providerOptions,
			embeddingApiUrl: loopbackOrigin(server),
			embeddingApiKey: async () => {
				credentialReached.resolve();
				await releaseCredential.promise;
				return "embed-test-key";
			},
		};
		state = new MnemopiSessionState({ sessionId: session.sessionId, config, session });
		setMnemopiSessionState(session, state);
		const collect = state.collectScopedRecallResults.bind(state);
		state.collectScopedRecallResults = (...args: Parameters<typeof collect>) => {
			const read = collect(...args);
			reads.push(read.catch(() => undefined));
			return read;
		};
	});

	afterEach(async () => {
		releaseCredential.resolve();
		await Promise.all(reads);
		await session.dispose();
		authStorage.close();
		server.stop(true);
		tempDir.removeSync();
	});

	const tools = (): ToolSession =>
		({ settings: session.settings, getMnemopiSessionState: () => state }) as unknown as ToolSession;
	const query = () => `ownership ${Bun.randomUUIDv7()}`;

	/** Start `read`, stop its owner (or not) while the credential is held, and wait for the read. */
	async function run(read: () => Promise<unknown>, stop: (() => void) | undefined): Promise<void> {
		const settled = read().catch(() => undefined);
		await credentialReached.promise;
		if (stop) {
			ownerStopped = true;
			stop();
		}
		releaseCredential.resolve();
		await settled;
		await Promise.all(reads);
	}

	describe.each([
		["recall", (signal: AbortSignal) => new MemoryRecallTool(tools()).execute("call", { query: query() }, signal)],
		["reflect", (signal: AbortSignal) => new MemoryReflectTool(tools()).execute("call", { query: query() }, signal)],
	] as const)("the %s tool", (_name, execute) => {
		it("sends the embedding request for a live tool call", async () => {
			const call = new AbortController();
			await run(() => execute(call.signal), undefined);

			expect(requests).toEqual([false]);
		});

		it("sends no embedding request once its tool call is cancelled", async () => {
			const call = new AbortController();
			await run(
				() => execute(call.signal),
				() => call.abort(),
			);

			expect(requests).toEqual([]);
		});
	});

	describe("auto-recall for context", () => {
		it("sends the embedding request on a live session", async () => {
			await run(() => state.recallForContext(query(), session.disposeSignal), undefined);

			expect(requests).toEqual([false]);
		});

		it("sends no embedding request once the session begins disposing", async () => {
			await run(
				() => state.recallForContext(query(), session.disposeSignal),
				() => session.beginDispose(),
			);

			expect(requests).toEqual([]);
		});
	});
});
