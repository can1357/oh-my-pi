import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { resetConnectionPrewarmForTesting } from "@oh-my-pi/pi-ai/providers/connection-prewarm";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { resetDispatchOriginsForTesting } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";

// What providers surface when the request never connected: `networkFailureMessage`'s
// rewrite of a `getaddrinfo ENOTFOUND` and of an `ECONNREFUSED` rejection.
const CONNECT_FAILURE =
	"Couldn't reach api.anthropic.com (getaddrinfo ENOTFOUND). Check the URL, your network, or proxy.";
const CONNECTION_REFUSED =
	"Couldn't connect to api.anthropic.com (connection refused). Check that the server is running and reachable.";
const LOCAL_ORIGIN = "http://127.0.0.1:11434";

type RetryStart = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type RetryEnd = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;
type FallbackApplied = Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>;

const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!primaryModel || !getBundledModel("openai", "gpt-4o-mini"))
	throw new Error("Expected bundled test models to exist");

describe("AgentSession fallback chain when the request never connected", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-offline-fallback-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		const modelsPath = path.join(tempDir.path(), "models.yml");
		await Bun.write(
			modelsPath,
			[
				"providers:",
				"  local-llm:",
				`    baseUrl: ${LOCAL_ORIGIN}/v1`,
				"    api: openai-completions",
				"    auth: none",
				"    models:",
				"      - id: local-model",
				"",
			].join("\n"),
		);
		modelRegistry = new ModelRegistry(authStorage, modelsPath);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		modelRegistry.clearSuppressedSelectors();
		resetConnectionPrewarmForTesting();
		resetDispatchOriginsForTesting();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	/** Answers the probe for hosts in `reachable`; every other host rejects the way an offline machine does. */
	function stubNetwork(reachable: readonly string[]): string[] {
		const probed: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async input => {
				const url = input instanceof Request ? input.url : String(input);
				probed.push(url);
				if (reachable.includes(new URL(url).origin)) return new Response(null, { status: 404 });
				throw Object.assign(new TypeError("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
			}),
		);
		return probed;
	}

	interface Turn {
		requested: string[];
		retryStarts: RetryStart[];
		retryEnds: RetryEnd[];
		applied: FallbackApplied[];
		done: Promise<void>;
	}

	/** Starts one prompt whose first request on `active` fails with `firstError`; every later request answers. */
	function startTurn(firstError: string, chain: string[], active: Model = primaryModel): Turn {
		const requested: string[] = [];
		const mock = createMockModel();
		let failed = false;
		const agent = new Agent({
			getApiKey: (model: Model) => `${model.provider}-test-key`,
			initialState: { model: active, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				const response: MockResponse = failed ? { content: ["ok"] } : { throw: firstError };
				failed = true;
				mock.push(response);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.fallbackChains": { default: chain },
		});
		settings.setModelRole("default", `${active.provider}/${active.id}`);
		const current = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session = current;
		const turn: Turn = { requested, retryStarts: [], retryEnds: [], applied: [], done: Promise.resolve() };
		current.subscribe(event => {
			if (event.type === "auto_retry_start") turn.retryStarts.push(event);
			if (event.type === "auto_retry_end") turn.retryEnds.push(event);
			if (event.type === "retry_fallback_applied") turn.applied.push(event);
		});
		turn.done = current.prompt("say ok").then(() => current.waitForIdle());
		return turn;
	}

	async function runTurn(firstError: string, chain: string[], active?: Model): Promise<Turn> {
		const turn = startTurn(firstError, chain, active);
		await turn.done;
		return turn;
	}

	it.each([
		["a DNS failure", CONNECT_FAILURE],
		["a refused connection", CONNECTION_REFUSED],
	])("stays on the primary after %s when the fallback's host does not answer either", async (_label, error) => {
		// Regression: offline, the chain switched to a fallback that failed the same way.
		const probed = stubNetwork([]);

		const { requested, retryStarts, applied } = await runTurn(error, ["openai/gpt-4o-mini"]);

		expect(probed).toEqual(["https://api.openai.com"]);
		expect(applied).toEqual([]);
		expect(requested).toEqual(["anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5"]);
		expect(retryStarts.map(event => event.unreachable)).toEqual([true]);
	});

	it("stays on the primary when the fallback shares its unreachable host", async () => {
		const sameHostPrimary = getBundledModel("openai", "gpt-4o");
		if (!sameHostPrimary) throw new Error("Expected bundled openai/gpt-4o");
		const probed = stubNetwork([]);

		const { requested, retryStarts, applied } = await runTurn(
			"Couldn't reach api.openai.com (getaddrinfo ENOTFOUND). Check the URL, your network, or proxy.",
			["openai/gpt-4o-mini"],
			sameHostPrimary,
		);

		expect(probed).toEqual(["https://api.openai.com"]);
		expect(applied).toEqual([]);
		expect(requested).toEqual(["openai/gpt-4o", "openai/gpt-4o"]);
		expect(retryStarts.map(event => event.unreachable)).toEqual([true]);
	});

	it("switches to the fallback when its host answers: only the primary's provider is down", async () => {
		const probed = stubNetwork(["https://api.openai.com"]);

		const { requested, retryStarts, applied } = await runTurn(CONNECT_FAILURE, ["openai/gpt-4o-mini"]);

		expect(probed).toEqual(["https://api.openai.com"]);
		expect(applied.map(event => event.to)).toEqual(["openai/gpt-4o-mini"]);
		expect(requested).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-4o-mini"]);
		expect(retryStarts.map(event => event.unreachable)).toEqual([undefined]);
	});

	it("switches to a local fallback offline, skipping the cloud entry whose host does not answer", async () => {
		const probed = stubNetwork([LOCAL_ORIGIN]);

		const { requested, retryStarts, applied } = await runTurn(CONNECT_FAILURE, [
			"openai/gpt-4o-mini",
			"local-llm/local-model",
		]);

		expect(probed).toEqual(["https://api.openai.com", LOCAL_ORIGIN]);
		expect(applied.map(event => event.to)).toEqual(["local-llm/local-model"]);
		expect(requested).toEqual(["anthropic/claude-sonnet-4-5", "local-llm/local-model"]);
		expect(retryStarts.map(event => event.unreachable)).toEqual([undefined]);
	});

	it("ends the retry at once when it is cancelled during a probe that gets no answer", async () => {
		// A route that drops packets: the probe never answers, and the stub ignores
		// the probe's own timeout, so the turn only settles if the cancel reaches it.
		const probeStarted = Promise.withResolvers<string>();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(input => {
				probeStarted.resolve(String(input));
				return Promise.withResolvers<Response>().promise;
			}),
		);

		const turn = startTurn(CONNECT_FAILURE, ["openai/gpt-4o-mini"]);
		expect(await probeStarted.promise).toBe("https://api.openai.com");
		session?.abortRetry();
		await turn.done;

		expect(turn.applied).toEqual([]);
		expect(turn.retryStarts).toEqual([]);
		expect(turn.requested).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(turn.retryEnds.map(event => event.finalError)).toEqual(["Retry cancelled"]);
	});

	it.each([
		["a rate limit", "429 rate limit exceeded"],
		["a server error", "overloaded_error: provider returned error 503"],
		// A gateway answered with an HTTP status, so the request did connect.
		["a 503 naming a refused upstream", "503 Service Unavailable: upstream connection refused"],
		// An error frame inside an HTTP 200 stream: no status, but a server answered.
		["an in-band error frame naming a refused upstream", "upstream connection refused"],
		["an in-band error frame relaying the upstream's errno", "upstream error: connect ECONNREFUSED 10.0.0.1:443"],
		// The host answered the TLS handshake, so the network is up.
		[
			"a TLS failure",
			"TLS certificate verification failed for api.anthropic.com (UNABLE_TO_VERIFY_LEAF_SIGNATURE). If you're behind a TLS-inspecting proxy, its CA may need to be trusted.",
		],
	])("walks the chain for %s without probing, as before", async (_label, error) => {
		// Every host rejects: a probe here would skip the fallback.
		const probed = stubNetwork([]);

		const { requested, retryStarts, applied } = await runTurn(error, ["openai/gpt-4o-mini"]);

		expect(probed).toEqual([]);
		expect(applied.map(event => event.to)).toEqual(["openai/gpt-4o-mini"]);
		expect(requested).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-4o-mini"]);
		expect(retryStarts.map(event => event.unreachable)).toEqual([undefined]);
	});
});
