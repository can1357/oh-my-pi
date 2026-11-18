/**
 * The fallback walk after a failed request, with `retry.usageAwareFallback`
 * on: a fallback model whose usage is spent (every account held by an
 * exhausted quota window or a usage-limit block) is passed over, and every
 * other read (the reserve, unknown usage, a read that throws, a short
 * account-policy or 401 block, a depleted read that lists no account, a usage
 * limit on only some accounts) still switches to it, so the refusal steps keep
 * reaching the other accounts and models.
 *
 * The failing model P, the fallback X and the fallback after it Y are bundled
 * models of three providers. With the setting on, the check before every model
 * call also reads the current model's usage, so the usage stub answers P and Y
 * as well.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, Effort, type Model, type ModelUsageHealth } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { createMockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { formatModelString, resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const MOCK_API_SOURCE = "agent-session-retry-fallback-usage-walk-test";
const WAIT_MS = 4_000;

const ACCOUNT_POLICY_DENIAL: MockResponse = {
	stopReason: "error",
	errorMessage:
		"This content was flagged for possible cybersecurity risk. Join Trusted Access for Cyber. (code=cyber_policy)",
};
const CODEX_ACCOUNT_POLICY_DENIAL: MockResponse = {
	content: [{ type: "thinking", thinking: "Checking whether this security request is allowed." }],
	stopReason: "error",
	errorMessage:
		"Codex error event: This content was flagged for possible cybersecurity risk. Join Trusted Access for Cyber. (code=cyber_policy)",
};
const CLASSIFIER_REFUSAL: MockResponse = {
	content: [{ type: "thinking", thinking: "Classifier evaluation before refusal." }],
	stopReason: "error",
	stopDetails: { type: "refusal", category: "cyber", explanation: "Classifier declined this turn." },
	errorMessage: "Refusal (cyber): Classifier declined this turn.",
};
const SERVER_ERROR = "500 Internal Server Error";

function bundled(provider: string, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected the bundled model ${provider}/${id}`);
	return model;
}

const PRIMARY = bundled("anthropic", "claude-sonnet-4-5");
const FALLBACK = bundled("openai", "gpt-4o-mini");
const NEXT_FALLBACK = bundled("google", "gemini-2.5-flash");
const CODEX = bundled("openai-codex", "gpt-5.6-sol");
const CODEX_FALLBACK = bundled("openai", "gpt-5.5");
const VERTEX_PRIMARY = bundled("google-vertex", "claude-opus-4-8@default");

function chainOf(...models: Model[]): Record<string, string[]> {
	return { default: models.map(formatModelString) };
}

/**
 * A stream that ends with a provider error stamped with the requested model's
 * identity, so the retry classifier reads it as that model's failure, with its
 * HTTP status when one is given.
 */
function providerErrorStream(model: Model, errorMessage: string, errorStatus?: number): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const failure: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage,
			errorStatus,
			timestamp: Date.now(),
		};
		stream.push({ type: "error", reason: "error", error: failure });
	});
	return stream;
}

type DepletionCause = "usage" | "account-policy" | "auth";

/**
 * A depleted read with one account per cause, each held by a block of that
 * cause. The accounts are built apart from the read, so the read also
 * compiles against a usage type that names no cause.
 */
function depletedRead(...causes: DepletionCause[]): ModelUsageHealth {
	const accounts = causes.map((cause, index) => ({
		credentialId: index + 1,
		credentialType: "oauth" as const,
		state: "depleted" as const,
		depletedBy: cause,
	}));
	return { state: "depleted", accounts };
}

/** Rejects once `signal` aborts, and never before. */
function rejectWhenAborted(signal: AbortSignal | undefined): Promise<ModelUsageHealth> {
	if (!signal) return Promise.reject(new Error("The usage read got no abort signal"));
	const { promise, reject } = Promise.withResolvers<ModelUsageHealth>();
	if (signal.aborted) reject(signal.reason);
	else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	return promise;
}

type UsageAnswer = ModelUsageHealth | Error | ((signal: AbortSignal | undefined) => Promise<ModelUsageHealth>);

/**
 * An agent on `primary` that records each requested `provider/id`. Every
 * request to `primary` fails with `failure`; every other model answers.
 */
function createWalkAgent(
	primary: Model,
	requestedModels: string[],
	failure: MockResponse | ((model: Model) => AssistantMessageEventStream),
): Agent {
	const mock = createMockModel();
	return new Agent({
		getApiKey: model => `${model.provider}-test-key`,
		initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (model, context, options) => {
			requestedModels.push(formatModelString(model));
			if (model.provider === primary.provider && model.id === primary.id) {
				if (typeof failure === "function") return failure(model);
				mock.push(failure);
			} else {
				mock.push({ content: ["answered"] });
			}
			return mock.stream(model, context, options);
		},
	});
}

/**
 * An agent on `primary` that records each requested `provider/id`. Every
 * request to a model of `refusing` ends with a classifier refusal; every
 * other model answers.
 */
function createRefusalAgent(primary: Model, requestedModels: string[], refusing: readonly Model[]): Agent {
	const mock = createMockModel();
	const refusingModels = new Set(refusing.map(formatModelString));
	return new Agent({
		getApiKey: model => `${model.provider}-test-key`,
		initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (model, context, options) => {
			requestedModels.push(formatModelString(model));
			mock.push(refusingModels.has(formatModelString(model)) ? CLASSIFIER_REFUSAL : { content: ["answered"] });
			return mock.stream(model, context, options);
		},
	});
}

function walkSettings(primary: Model, values: Readonly<Record<string, unknown>>): Settings {
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.baseDelayMs": 1,
		"retry.usageAwareFallback": true,
		...values,
	});
	settings.setModelRole("default", formatModelString(primary));
	return settings;
}

function modelOf(session: AgentSession): string | undefined {
	return session.model ? formatModelString(session.model) : undefined;
}

function lastAssistant(session: AgentSession): AssistantMessage {
	const last = session.messages.at(-1);
	if (last?.role !== "assistant") throw new Error("Expected the turn to end on an assistant message");
	return last;
}

async function runTurn(session: AgentSession, text: string): Promise<void> {
	await withTimeout(session.prompt(text), WAIT_MS, "The prompt did not settle");
	await withTimeout(session.waitForIdle(), WAIT_MS, "The session did not settle");
}

interface WalkRun {
	session: AgentSession;
	sessionManager: SessionManager;
	/** The `to` of each `retry_fallback_applied` event, in order. */
	fallbacks: string[];
}

describe("AgentSession fallback walk with usage-aware fallback", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	// One registry for the file: building it indexes every bundled model. Each
	// test resets the fallback cooldowns the walk leaves on it.
	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-fallback-usage-walk-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		for (const provider of [PRIMARY.provider, FALLBACK.provider, NEXT_FALLBACK.provider]) {
			authStorage.keys.setRuntime(provider, `${provider}-test-key`);
		}
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		modelRegistry.clearSuppressedSelectors();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
		unregisterCustomApis(MOCK_API_SOURCE);
		authStorage.keys.removeRuntime(CODEX.provider);
		authStorage.keys.removeRuntime(VERTEX_PRIMARY.provider);
		await authStorage.credentials.remove(CODEX.provider);
	});

	/** Answers each usage read by the model's `provider/id`; a model `answers` does not name reads healthy. */
	function stubUsageReads(answers: Record<string, UsageAnswer>): void {
		vi.spyOn(modelRegistry.authStorage.health, "model").mockImplementation(async (provider, options) => {
			const answer = answers[`${provider}/${options.modelId}`];
			if (answer === undefined) return { state: "healthy", accounts: [] };
			if (answer instanceof Error) throw answer;
			return typeof answer === "function" ? answer(options.signal) : answer;
		});
	}

	function startSession(
		agent: Agent,
		settings: Settings,
		providerSessionId?: string,
		thinkingLevelCeiling?: Effort,
	): WalkRun {
		const sessionManager = SessionManager.inMemory();
		const started = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			providerSessionId,
			thinkingLevelCeiling,
		});
		session = started;
		const fallbacks: string[] = [];
		started.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbacks.push(event.to);
		});
		return { session: started, sessionManager, fallbacks };
	}

	/** The fallback X answered the turn: the walk switched onto it once and nothing else ran. */
	function expectAnsweredOnFallback(run: WalkRun, requestedModels: string[]): void {
		expect(requestedModels).toEqual([formatModelString(PRIMARY), formatModelString(FALLBACK)]);
		expect(run.fallbacks).toEqual([formatModelString(FALLBACK)]);
		expect(modelOf(run.session)).toBe(formatModelString(FALLBACK));
		expect(lastAssistant(run.session).stopReason).toBe("stop");
	}

	describe("passing over a spent fallback", () => {
		it("skips a fallback whose usage is spent and switches to the one after it", async () => {
			stubUsageReads({ [formatModelString(FALLBACK)]: depletedRead("usage") });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK, NEXT_FALLBACK) }),
			);

			await runTurn(run.session, "Fail on the primary");

			expect(requestedModels).toEqual([formatModelString(PRIMARY), formatModelString(NEXT_FALLBACK)]);
			expect(run.fallbacks).toEqual([formatModelString(NEXT_FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(NEXT_FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
			// The session history never records a switch onto the spent model.
			const entries = run.sessionManager.getEntries();
			const modelChanges = entries.flatMap(entry => (entry.type === "model_change" ? [entry.model] : []));
			expect(modelChanges).toContain(formatModelString(NEXT_FALLBACK));
			expect(modelChanges).not.toContain(formatModelString(FALLBACK));
		});

		it("pins the fallback after a spent one, so the primary is not restored when its cooldown ends", async () => {
			// The walk's switch from the spent model to the fallback after it is
			// pinned, like the switch the check before a model call makes from a
			// depleted model. `cooldown-expiry` restores only an unpinned fallback's
			// primary.
			stubUsageReads({ [formatModelString(FALLBACK)]: depletedRead("usage") });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, {
					"retry.fallbackChains": chainOf(FALLBACK, NEXT_FALLBACK),
					"retry.fallbackRevertPolicy": "cooldown-expiry",
				}),
			);
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);

			await runTurn(run.session, "Fail on the primary");
			// Past every fallback cooldown (30 minutes at most), so only the pin keeps
			// the session on the fallback.
			now += 60 * 60 * 1000;
			await runTurn(run.session, "Stay on the fallback after the cooldown");

			expect(requestedModels).toEqual([
				formatModelString(PRIMARY),
				formatModelString(NEXT_FALLBACK),
				formatModelString(NEXT_FALLBACK),
			]);
			expect(modelOf(run.session)).toBe(formatModelString(NEXT_FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("answers on the fallback after a spent one at the level the spent fallback's selector names", async () => {
			// The fallback after the spent one names no level, so it takes the level
			// the switch onto the spent fallback would set: low, which that
			// fallback's selector names.
			stubUsageReads({ [formatModelString(CODEX_FALLBACK)]: depletedRead("usage") });
			const requests: string[] = [];
			const mock = createMockModel();
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: { model: PRIMARY, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (model, context, options) => {
					requests.push(`${formatModelString(model)} at ${options?.reasoning}`);
					mock.push(
						model.provider === PRIMARY.provider && model.id === PRIMARY.id
							? ACCOUNT_POLICY_DENIAL
							: { content: ["answered"] },
					);
					return mock.stream(model, context, options);
				},
			});
			const run = startSession(
				agent,
				walkSettings(PRIMARY, {
					"retry.fallbackChains": {
						default: [`${formatModelString(CODEX_FALLBACK)}:low`, formatModelString(NEXT_FALLBACK)],
					},
				}),
				undefined,
				Effort.High,
			);
			run.session.setThinkingLevel(Effort.High);

			await runTurn(run.session, "Fail on the primary");

			expect(requests).toEqual([
				`${formatModelString(PRIMARY)} at high`,
				`${formatModelString(NEXT_FALLBACK)} at low`,
			]);
			expect(run.session.thinkingLevel).toBe(Effort.Low);
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("searches the chain the switch would pin before the spent fallback's own chain", async () => {
			// The search from the spent model reads the chain a switch onto it would
			// pin, then the model's own chain.
			stubUsageReads({ [formatModelString(FALLBACK)]: depletedRead("usage") });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, {
					"retry.fallbackChains": {
						default: [formatModelString(FALLBACK), formatModelString(NEXT_FALLBACK)],
						[formatModelString(FALLBACK)]: [formatModelString(CODEX_FALLBACK)],
					},
				}),
			);

			await runTurn(run.session, "Fail on the primary");

			expect(requestedModels).toEqual([formatModelString(PRIMARY), formatModelString(NEXT_FALLBACK)]);
			expect(run.fallbacks).toEqual([formatModelString(NEXT_FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(NEXT_FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("keeps the walk's chain after a switch that the spent fallback's own chain names, for a later failure", async () => {
			// A switch to a model that only the spent model's own chain names records
			// the walk's chain when no fallback is active yet, so a later failure
			// walks from that chain: back to the primary first, then on.
			stubUsageReads({ [formatModelString(FALLBACK)]: depletedRead("usage") });
			const requestedModels: string[] = [];
			let failNextFallback = false;
			const mock = createMockModel();
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: { model: PRIMARY, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (model, context, options) => {
					requestedModels.push(formatModelString(model));
					if (model.provider === PRIMARY.provider && model.id === PRIMARY.id) {
						mock.push(ACCOUNT_POLICY_DENIAL);
					} else if (failNextFallback) {
						failNextFallback = false;
						return providerErrorStream(model, SERVER_ERROR, 500);
					} else {
						mock.push({ content: ["answered"] });
					}
					return mock.stream(model, context, options);
				},
			});
			const run = startSession(
				agent,
				walkSettings(PRIMARY, {
					"retry.maxRetries": 1,
					"retry.fallbackRevertPolicy": "cooldown-expiry",
					"retry.fallbackChains": {
						default: [formatModelString(FALLBACK)],
						[formatModelString(FALLBACK)]: [formatModelString(NEXT_FALLBACK), formatModelString(CODEX_FALLBACK)],
					},
				}),
			);
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);

			await runTurn(run.session, "Fail on the primary");
			// Past every fallback cooldown, so the later walk may go back to the primary.
			now += 2 * 60 * 60 * 1000;
			failNextFallback = true;
			await runTurn(run.session, "Fail on the fallback");

			expect(requestedModels).toEqual([
				formatModelString(PRIMARY),
				formatModelString(NEXT_FALLBACK),
				formatModelString(NEXT_FALLBACK),
				formatModelString(PRIMARY),
				formatModelString(CODEX_FALLBACK),
			]);
			expect(modelOf(run.session)).toBe(formatModelString(CODEX_FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("answers on the fallback after a spent one under the fail-closed reserve policy", async () => {
			// Switching onto the spent model would let the check before its request
			// end the turn with a fail-closed refusal although a usable fallback follows.
			stubUsageReads({ [formatModelString(FALLBACK)]: depletedRead("usage") });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, {
					"retry.usageReservePolicy": "fail-closed",
					"retry.fallbackChains": chainOf(FALLBACK, NEXT_FALLBACK),
				}),
			);

			await runTurn(run.session, "Fail on the primary");

			expect(requestedModels).toEqual([formatModelString(PRIMARY), formatModelString(NEXT_FALLBACK)]);
			expect(run.fallbacks).toEqual([formatModelString(NEXT_FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(NEXT_FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("switches to a fallback at the reserve after a spent fallback, which answers under the confirm reserve policy", async () => {
			// The step past the spent fallback passes over only spent usage, so it
			// takes the fallback at the reserve after it. The check before that
			// model call then applies the default reserve policy, `confirm`: no
			// fallback follows the reserve model, so the request is sent.
			stubUsageReads({
				[formatModelString(FALLBACK)]: depletedRead("usage"),
				[formatModelString(NEXT_FALLBACK)]: {
					state: "reserve",
					accounts: [{ credentialId: 1, credentialType: "oauth", state: "reserve", remainingFraction: 0.05 }],
				},
			});
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK, NEXT_FALLBACK) }),
			);

			await runTurn(run.session, "Fail on the primary");

			expect(requestedModels).toEqual([formatModelString(PRIMARY), formatModelString(NEXT_FALLBACK)]);
			expect(run.fallbacks).toEqual([formatModelString(NEXT_FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(NEXT_FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("switches to a fallback at the reserve after a spent fallback under the fail-closed reserve policy, whose check then refuses it", async () => {
			// The step past the spent fallback takes the fallback at the reserve
			// under every reserve policy. Under `fail-closed` the check before that
			// model call refuses a reserve model, so no request reaches it: the
			// retry ends on the check's error, and no assistant reply is kept.
			stubUsageReads({
				[formatModelString(FALLBACK)]: depletedRead("usage"),
				[formatModelString(NEXT_FALLBACK)]: {
					state: "reserve",
					accounts: [{ credentialId: 1, credentialType: "oauth", state: "reserve", remainingFraction: 0.05 }],
				},
			});
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, {
					"retry.usageReservePolicy": "fail-closed",
					"retry.fallbackChains": chainOf(FALLBACK, NEXT_FALLBACK),
				}),
			);
			const retryEnds: { success: boolean; finalError?: string }[] = [];
			run.session.subscribe(event => {
				if (event.type === "auto_retry_end")
					retryEnds.push({ success: event.success, finalError: event.finalError });
			});

			await runTurn(run.session, "Fail on the primary");

			expect(requestedModels).toEqual([formatModelString(PRIMARY)]);
			expect(run.fallbacks).toEqual([formatModelString(NEXT_FALLBACK)]);
			expect(retryEnds).toHaveLength(1);
			expect(retryEnds[0]?.success).toBe(false);
			expect(retryEnds[0]?.finalError).toContain(
				`Usage preflight blocked: reserve reached for ${formatModelString(NEXT_FALLBACK)}`,
			);
			expect(run.session.messages.at(-1)?.role).toBe("user");
		});

		it("switches to a fallback whose usage is unknown after a spent fallback", async () => {
			stubUsageReads({
				[formatModelString(FALLBACK)]: depletedRead("usage"),
				[formatModelString(NEXT_FALLBACK)]: {
					state: "unknown",
					accounts: [{ credentialId: 1, credentialType: "oauth", state: "unknown" }],
				},
			});
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK, NEXT_FALLBACK) }),
			);

			await runTurn(run.session, "Fail on the primary");

			expect(requestedModels).toEqual([formatModelString(PRIMARY), formatModelString(NEXT_FALLBACK)]);
			expect(run.fallbacks).toEqual([formatModelString(NEXT_FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(NEXT_FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("passes over a fallback whose key read fails after a spent fallback", async () => {
			// The walk sends no request to the spent fallback and takes what the
			// check before a model call would pick from it. That check passes over
			// the next fallback, whose key read throws here, and raises nothing.
			const thirdFallback = bundled("anthropic", "claude-opus-4-8");
			stubUsageReads({ [formatModelString(FALLBACK)]: depletedRead("usage") });
			const getApiKey = modelRegistry.getApiKey.bind(modelRegistry);
			vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, sessionId, options) => {
				if (model.provider === NEXT_FALLBACK.provider && model.id === NEXT_FALLBACK.id) {
					throw new Error("credential command failed");
				}
				return getApiKey(model, sessionId, options);
			});
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK, NEXT_FALLBACK, thirdFallback) }),
			);

			await runTurn(run.session, "Fail on the primary");

			expect(requestedModels).toEqual([formatModelString(PRIMARY), formatModelString(thirdFallback)]);
			expect(run.fallbacks).toEqual([formatModelString(thirdFallback)]);
			expect(modelOf(run.session)).toBe(formatModelString(thirdFallback));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("switches to the model that only the spent fallback's own chain names", async () => {
			// The walk's chain ends at the spent Codex model. The check before a
			// model call would also read the Codex model's own chain, which names
			// the same model on another provider.
			authStorage.keys.setRuntime(CODEX.provider, `${CODEX.provider}-test-key`);
			stubUsageReads({ [formatModelString(CODEX)]: depletedRead("usage") });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, {
					"retry.fallbackChains": {
						default: [formatModelString(CODEX)],
						[`${CODEX.provider}/*`]: ["openai/*"],
					},
				}),
			);

			await runTurn(run.session, "Fail on the primary");

			const sameModelElsewhere = `openai/${CODEX.id}`;
			expect(requestedModels).toEqual([formatModelString(PRIMARY), sameModelElsewhere]);
			expect(run.fallbacks).toEqual([sameModelElsewhere]);
			expect(modelOf(run.session)).toBe(sameModelElsewhere);
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("ends the turn on the denial of the primary when its only fallback is spent", async () => {
			stubUsageReads({ [formatModelString(FALLBACK)]: depletedRead("usage") });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK) }),
			);

			await runTurn(run.session, "Fail on the primary");

			expect(requestedModels).toEqual([formatModelString(PRIMARY)]);
			expect(run.fallbacks).toEqual([]);
			expect(modelOf(run.session)).toBe(formatModelString(PRIMARY));
			const last = lastAssistant(run.session);
			expect(last.stopReason).toBe("error");
			expect(last.errorMessage).toBe(ACCOUNT_POLICY_DENIAL.errorMessage);
		});

		it("ends the turn on the spent retry budget when the only fallback is spent", async () => {
			stubUsageReads({ [formatModelString(FALLBACK)]: depletedRead("usage") });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, model => providerErrorStream(model, SERVER_ERROR, 500)),
				walkSettings(PRIMARY, { "retry.maxRetries": 0, "retry.fallbackChains": chainOf(FALLBACK) }),
			);

			await runTurn(run.session, "Fail on the primary");

			expect(requestedModels).toEqual([formatModelString(PRIMARY)]);
			expect(run.fallbacks).toEqual([]);
			expect(modelOf(run.session)).toBe(formatModelString(PRIMARY));
			const last = lastAssistant(run.session);
			expect(last.stopReason).toBe("error");
			expect(last.errorMessage).toBe(`Retry budget exhausted after 0 retries: ${SERVER_ERROR}`);
		});

		it("ends the turn on the spent retry budget when the spent fallback's own chain names an alias of the failing primary", async () => {
			// `pi/default` resolves to the primary, which each failure puts in
			// cooldown. The search from the spent fallback passes over the alias,
			// so the walk makes no switch and the budget ends the turn: the first
			// request, then the two retries it allows.
			stubUsageReads({ [formatModelString(FALLBACK)]: depletedRead("usage") });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, model => providerErrorStream(model, SERVER_ERROR, 500)),
				walkSettings(PRIMARY, {
					"retry.maxRetries": 2,
					"retry.fallbackChains": {
						default: [formatModelString(FALLBACK)],
						[formatModelString(FALLBACK)]: ["pi/default"],
					},
				}),
			);

			await runTurn(run.session, "Fail on the primary");

			expect(requestedModels).toEqual([
				formatModelString(PRIMARY),
				formatModelString(PRIMARY),
				formatModelString(PRIMARY),
			]);
			expect(run.fallbacks).toEqual([]);
			expect(modelOf(run.session)).toBe(formatModelString(PRIMARY));
			const last = lastAssistant(run.session);
			expect(last.stopReason).toBe("error");
			expect(last.errorMessage).toBe(`Retry budget exhausted after 2 retries: ${SERVER_ERROR}`);
		});

		it("retries the fallback in use with no switch, and pins it, when its cooldown ends while the walk reads the spent fallback's usage", async () => {
			// The primary's denial switches to the fallback, unpinned. The fallback
			// then fails, which puts it in cooldown, and the walk reaches the spent
			// fallback after it, whose own chain names the fallback in use. Its usage
			// read outlasts every cooldown the failures set, so the step past it
			// finds the fallback in use at the level it runs at: it makes no switch,
			// pins that fallback's record and retries it at once, past the spent
			// retry budget. `cooldown-expiry` restores only an unpinned fallback's
			// primary, and the primary fails each time.
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);
			let spentReads = 0;
			stubUsageReads({
				[formatModelString(NEXT_FALLBACK)]: async () => {
					// Past every fallback cooldown (30 minutes at most).
					if (spentReads++ === 0) now += 60 * 60 * 1000;
					return depletedRead("usage");
				},
			});
			const requestedModels: string[] = [];
			let failFallback = false;
			const mock = createMockModel();
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: { model: PRIMARY, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (model, context, options) => {
					requestedModels.push(formatModelString(model));
					if (model.provider === PRIMARY.provider && model.id === PRIMARY.id) {
						mock.push(ACCOUNT_POLICY_DENIAL);
					} else if (failFallback && model.provider === FALLBACK.provider && model.id === FALLBACK.id) {
						failFallback = false;
						return providerErrorStream(model, SERVER_ERROR, 500);
					} else {
						mock.push({ content: ["answered"] });
					}
					return mock.stream(model, context, options);
				},
			});
			const run = startSession(
				agent,
				walkSettings(PRIMARY, {
					"retry.maxRetries": 0,
					"retry.fallbackRevertPolicy": "cooldown-expiry",
					"retry.fallbackChains": {
						default: [formatModelString(FALLBACK), formatModelString(NEXT_FALLBACK)],
						[formatModelString(NEXT_FALLBACK)]: [formatModelString(FALLBACK)],
					},
				}),
			);

			await runTurn(run.session, "Fail on the primary");
			failFallback = true;
			await runTurn(run.session, "Fail on the fallback");
			await runTurn(run.session, "Stay on the fallback after the cooldowns");

			expect(requestedModels).toEqual([
				formatModelString(PRIMARY),
				formatModelString(FALLBACK),
				formatModelString(FALLBACK),
				formatModelString(FALLBACK),
				formatModelString(FALLBACK),
			]);
			expect(run.fallbacks).toEqual([formatModelString(FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("passes over an alias of the failed primary in cooldown when a fallback fails, to the model after it", async () => {
			// The primary fails and goes into cooldown, and the walk moves to the
			// fallback. The fallback fails too. Its own chain names `pi/default`,
			// which resolves to the primary, and then the next fallback. The walk
			// must not go back to the primary while it is in cooldown: it passes over
			// the alias and answers from the next fallback.
			const requestedModels: string[] = [];
			const mock = createMockModel();
			const failing = new Set([formatModelString(PRIMARY), formatModelString(FALLBACK)]);
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: { model: PRIMARY, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (model, context, options) => {
					requestedModels.push(formatModelString(model));
					if (failing.has(formatModelString(model))) return providerErrorStream(model, SERVER_ERROR, 500);
					mock.push({ content: ["answered"] });
					return mock.stream(model, context, options);
				},
			});
			const run = startSession(
				agent,
				walkSettings(PRIMARY, {
					"retry.maxRetries": 2,
					"retry.fallbackChains": {
						default: [formatModelString(FALLBACK)],
						[formatModelString(FALLBACK)]: ["pi/default", formatModelString(NEXT_FALLBACK)],
					},
				}),
			);

			await runTurn(run.session, "Fail on the primary and on the fallback");

			expect(requestedModels).toEqual([
				formatModelString(PRIMARY),
				formatModelString(FALLBACK),
				formatModelString(NEXT_FALLBACK),
			]);
			expect(run.fallbacks).toEqual([formatModelString(FALLBACK), formatModelString(NEXT_FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(NEXT_FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("passes over the failed primary in cooldown under a spelling without its revision suffix, to the model after it", async () => {
			// The primary is Vertex's `claude-opus-4-8@default`, which the catalog's
			// revision suffix lets `google-vertex/claude-opus-4-8` name too. The
			// primary fails and goes into cooldown, and the walk moves to the
			// fallback. The fallback fails too. Its own chain names the primary
			// without the suffix, and then the next fallback. The walk must not go
			// back to the primary while it is in cooldown: it passes over that entry
			// and answers from the next fallback.
			authStorage.keys.setRuntime(VERTEX_PRIMARY.provider, `${VERTEX_PRIMARY.provider}-test-key`);
			const unsuffixed = "google-vertex/claude-opus-4-8";
			const settings = walkSettings(VERTEX_PRIMARY, {
				"retry.maxRetries": 2,
				"retry.fallbackChains": {
					default: [formatModelString(FALLBACK)],
					[formatModelString(FALLBACK)]: [unsuffixed, formatModelString(NEXT_FALLBACK)],
				},
			});
			// The entry names the primary, so only the primary's cooldown can pass it over.
			const named = resolveModelOverride([unsuffixed], modelRegistry, settings).model;
			expect(named && formatModelString(named)).toBe(formatModelString(VERTEX_PRIMARY));
			const requestedModels: string[] = [];
			const mock = createMockModel();
			const failing = new Set([formatModelString(VERTEX_PRIMARY), formatModelString(FALLBACK)]);
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: { model: VERTEX_PRIMARY, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (model, context, options) => {
					requestedModels.push(formatModelString(model));
					if (failing.has(formatModelString(model))) return providerErrorStream(model, SERVER_ERROR, 500);
					mock.push({ content: ["answered"] });
					return mock.stream(model, context, options);
				},
			});
			const run = startSession(agent, settings);

			await runTurn(run.session, "Fail on the primary and on the fallback");

			expect(requestedModels).toEqual([
				formatModelString(VERTEX_PRIMARY),
				formatModelString(FALLBACK),
				formatModelString(NEXT_FALLBACK),
			]);
			expect(run.fallbacks).toEqual([formatModelString(FALLBACK), formatModelString(NEXT_FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(NEXT_FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("passes over an alias of a model that refused in the turn when the fallback refuses too, to the model after it", async () => {
			// The primary refuses, and the refusal walk moves to the fallback, which
			// refuses too. The fallback's own chain names `pi/default`, which
			// resolves to the primary, and then the next fallback. A refusal walk
			// sends no request to a model that refused in the turn, under any name:
			// it passes over the alias and answers from the next fallback. The
			// catalog gives this primary no revision, so only its `provider/id`
			// matches the alias. No refusal here carries a fallback credit, so no
			// credit holds a model back.
			stubUsageReads({});
			const requestedModels: string[] = [];
			const run = startSession(
				createRefusalAgent(FALLBACK, requestedModels, [FALLBACK, PRIMARY]),
				walkSettings(FALLBACK, {
					"retry.maxRetries": 1,
					"retry.fallbackChains": {
						default: [formatModelString(PRIMARY)],
						[formatModelString(PRIMARY)]: ["pi/default", formatModelString(NEXT_FALLBACK)],
					},
				}),
			);

			await runTurn(run.session, "Recover from two refusals");

			expect(requestedModels).toEqual([
				formatModelString(FALLBACK),
				formatModelString(PRIMARY),
				formatModelString(NEXT_FALLBACK),
			]);
			expect(run.fallbacks).toEqual([formatModelString(PRIMARY), formatModelString(NEXT_FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(NEXT_FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("passes over a model that refused in the turn under a spelling without its revision suffix, to the model after it", async () => {
			// The primary is Vertex's `claude-opus-4-8@default`, which the catalog's
			// revision suffix lets `google-vertex/claude-opus-4-8` name too. The
			// primary refuses, and the refusal walk moves to the fallback, which
			// refuses too. The fallback's own chain names the primary without the
			// suffix, and then the next fallback: the walk passes over that entry and
			// answers from the next fallback.
			authStorage.keys.setRuntime(VERTEX_PRIMARY.provider, `${VERTEX_PRIMARY.provider}-test-key`);
			stubUsageReads({});
			const unsuffixed = "google-vertex/claude-opus-4-8";
			const settings = walkSettings(VERTEX_PRIMARY, {
				"retry.maxRetries": 1,
				"retry.fallbackChains": {
					default: [formatModelString(FALLBACK)],
					[formatModelString(FALLBACK)]: [unsuffixed, formatModelString(NEXT_FALLBACK)],
				},
			});
			// The entry names the primary.
			const named = resolveModelOverride([unsuffixed], modelRegistry, settings).model;
			expect(named && formatModelString(named)).toBe(formatModelString(VERTEX_PRIMARY));
			const requestedModels: string[] = [];
			const run = startSession(
				createRefusalAgent(VERTEX_PRIMARY, requestedModels, [VERTEX_PRIMARY, FALLBACK]),
				settings,
			);

			await runTurn(run.session, "Recover from two refusals");

			expect(requestedModels).toEqual([
				formatModelString(VERTEX_PRIMARY),
				formatModelString(FALLBACK),
				formatModelString(NEXT_FALLBACK),
			]);
			expect(run.fallbacks).toEqual([formatModelString(FALLBACK), formatModelString(NEXT_FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(NEXT_FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("passes over the same model on another provider as a model that refused in the turn, to the model after it", async () => {
			// The primary is Anthropic's Claude Opus 4.8, and Vertex's
			// `claude-opus-4-8@default` is that model on another provider: the
			// catalog gives both one vendor class, family and revision. The primary
			// refuses, and the refusal walk moves to the fallback, which refuses too.
			// The fallback's own chain names the Vertex model, and then the next
			// fallback: the walk passes over the Vertex model and answers from the
			// next fallback.
			const opus = bundled("anthropic", "claude-opus-4-8");
			expect(VERTEX_PRIMARY.identity).toEqual(opus.identity);
			authStorage.keys.setRuntime(VERTEX_PRIMARY.provider, `${VERTEX_PRIMARY.provider}-test-key`);
			stubUsageReads({});
			const requestedModels: string[] = [];
			const run = startSession(
				createRefusalAgent(opus, requestedModels, [opus, FALLBACK]),
				walkSettings(opus, {
					"retry.maxRetries": 1,
					"retry.fallbackChains": {
						default: [formatModelString(FALLBACK)],
						[formatModelString(FALLBACK)]: [formatModelString(VERTEX_PRIMARY), formatModelString(NEXT_FALLBACK)],
					},
				}),
			);

			await runTurn(run.session, "Recover from two refusals");

			expect(requestedModels).toEqual([
				formatModelString(opus),
				formatModelString(FALLBACK),
				formatModelString(NEXT_FALLBACK),
			]);
			expect(run.fallbacks).toEqual([formatModelString(FALLBACK), formatModelString(NEXT_FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(NEXT_FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("passes over a model that refused in the turn in the step past a spent fallback, to the model after it", async () => {
			// The primary refuses, and the refusal walk moves to the fallback, which
			// refuses too. The fallback's own chain names a spent fallback, whose own
			// chain names the primary and then another model. The walk sends no
			// request to the spent fallback, and the step past it passes over the
			// primary, which refused in the turn, and answers from the other model.
			stubUsageReads({ [formatModelString(CODEX_FALLBACK)]: depletedRead("usage") });
			const requestedModels: string[] = [];
			const run = startSession(
				createRefusalAgent(PRIMARY, requestedModels, [PRIMARY, NEXT_FALLBACK]),
				walkSettings(PRIMARY, {
					"retry.maxRetries": 1,
					"retry.fallbackChains": {
						default: [formatModelString(NEXT_FALLBACK)],
						[formatModelString(NEXT_FALLBACK)]: [formatModelString(CODEX_FALLBACK)],
						[formatModelString(CODEX_FALLBACK)]: [formatModelString(PRIMARY), formatModelString(FALLBACK)],
					},
				}),
			);

			await runTurn(run.session, "Recover from two refusals");

			expect(requestedModels).toEqual([
				formatModelString(PRIMARY),
				formatModelString(NEXT_FALLBACK),
				formatModelString(FALLBACK),
			]);
			expect(run.fallbacks).toEqual([formatModelString(NEXT_FALLBACK), formatModelString(FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		for (const [condition, read, policy] of [
			[
				"at the reserve under the auto reserve policy",
				{
					state: "reserve",
					accounts: [{ credentialId: 1, credentialType: "oauth", state: "reserve", remainingFraction: 0.05 }],
				},
				"auto",
			],
			[
				"at the reserve with no confirmer",
				{
					state: "reserve",
					accounts: [{ credentialId: 1, credentialType: "oauth", state: "reserve", remainingFraction: 0.05 }],
				},
				"confirm",
			],
			["depleted by a short account-policy block", depletedRead("account-policy"), "confirm"],
		] satisfies [string, ModelUsageHealth, "auto" | "confirm"][]) {
			it(`passes over a model that refused in the turn in the check before a model call, to the model after it (${condition})`, async () => {
				// The primary refuses, and the refusal walk moves to the fallback. The
				// fallback is not spent, so the walk switches to it, and the check
				// before its model call switches away from it. The fallback's own
				// chain names `pi/default`, which resolves to the primary, and then
				// the next fallback: the check passes over the primary, which refused
				// in the turn, and the next fallback answers. No request reaches the
				// fallback. The session has no confirmer, so `confirm` applies the
				// fallback as `auto` does.
				stubUsageReads({ [formatModelString(FALLBACK)]: read });
				const requestedModels: string[] = [];
				const run = startSession(
					createRefusalAgent(PRIMARY, requestedModels, [PRIMARY]),
					walkSettings(PRIMARY, {
						"retry.maxRetries": 1,
						"retry.usageReservePolicy": policy,
						"retry.fallbackChains": {
							default: [formatModelString(FALLBACK)],
							[formatModelString(FALLBACK)]: ["pi/default", formatModelString(NEXT_FALLBACK)],
						},
					}),
				);

				await runTurn(run.session, "Recover from the refusal");

				expect(requestedModels).toEqual([formatModelString(PRIMARY), formatModelString(NEXT_FALLBACK)]);
				expect(run.fallbacks).toEqual([formatModelString(FALLBACK), formatModelString(NEXT_FALLBACK)]);
				expect(modelOf(run.session)).toBe(formatModelString(NEXT_FALLBACK));
				expect(lastAssistant(run.session).stopReason).toBe("stop");
			});
		}

		it("passes over a model that refused in the turn when a later fallback fails with another error, to the model after it", async () => {
			// The primary refuses, and the refusal walk moves to the fallback, which
			// fails with a server error. The walk after that failure is no refusal
			// walk, and it still sends no request to a model that refused in the
			// turn: it passes over `pi/default`, which resolves to the primary, and
			// answers from the next fallback.
			stubUsageReads({});
			const requestedModels: string[] = [];
			const mock = createMockModel();
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: { model: PRIMARY, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (model, context, options) => {
					requestedModels.push(formatModelString(model));
					if (model.provider === FALLBACK.provider && model.id === FALLBACK.id) {
						return providerErrorStream(model, SERVER_ERROR, 500);
					}
					mock.push(
						model.provider === PRIMARY.provider && model.id === PRIMARY.id
							? CLASSIFIER_REFUSAL
							: { content: ["answered"] },
					);
					return mock.stream(model, context, options);
				},
			});
			const run = startSession(
				agent,
				walkSettings(PRIMARY, {
					"retry.maxRetries": 2,
					"retry.fallbackChains": {
						default: [formatModelString(FALLBACK)],
						[formatModelString(FALLBACK)]: ["pi/default", formatModelString(NEXT_FALLBACK)],
					},
				}),
			);

			await runTurn(run.session, "Recover from the refusal and the server error");

			expect(requestedModels).toEqual([
				formatModelString(PRIMARY),
				formatModelString(FALLBACK),
				formatModelString(NEXT_FALLBACK),
			]);
			expect(run.fallbacks).toEqual([formatModelString(FALLBACK), formatModelString(NEXT_FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(NEXT_FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("switches to no fallback when the session is aborted during the usage read of a fallback", async () => {
			const readStarted = Promise.withResolvers<void>();
			stubUsageReads({
				[formatModelString(FALLBACK)]: signal => {
					readStarted.resolve();
					return rejectWhenAborted(signal);
				},
			});
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, model => providerErrorStream(model, SERVER_ERROR, 500)),
				walkSettings(PRIMARY, {
					"retry.maxRetries": 3,
					"retry.fallbackChains": chainOf(FALLBACK, NEXT_FALLBACK),
				}),
			);

			const turn = run.session.prompt("Fail on the primary, then abort");
			try {
				await withTimeout(readStarted.promise, WAIT_MS, "The fallback's usage read did not start");
			} finally {
				await withTimeout(run.session.abort(), WAIT_MS, "The abort did not finish");
			}
			await withTimeout(turn, WAIT_MS, "The prompt did not settle");
			await withTimeout(run.session.waitForIdle(), WAIT_MS, "The session did not settle");

			expect(requestedModels).toEqual([formatModelString(PRIMARY)]);
			expect(run.fallbacks).toEqual([]);
			expect(modelOf(run.session)).toBe(formatModelString(PRIMARY));
			expect(run.session.isRetrying).toBe(false);
		});

		it("asks again about the primary's reserve after a walk passed over a spent fallback", async () => {
			// The user keeps the primary at the reserve once. A walk that passes over
			// a spent fallback ends that approval, as the check before a model call
			// does when it reads a depleted model, so the reserve is asked about
			// again once the session is back on the primary.
			stubUsageReads({
				[formatModelString(PRIMARY)]: {
					state: "reserve",
					accounts: [{ credentialId: 1, credentialType: "oauth", state: "reserve", remainingFraction: 0.05 }],
				},
				[formatModelString(FALLBACK)]: depletedRead("usage"),
			});
			const requestedModels: string[] = [];
			let denyPrimary = false;
			const mock = createMockModel();
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: { model: PRIMARY, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (model, context, options) => {
					requestedModels.push(formatModelString(model));
					mock.push(
						denyPrimary && model.provider === PRIMARY.provider && model.id === PRIMARY.id
							? ACCOUNT_POLICY_DENIAL
							: { content: ["answered"] },
					);
					return mock.stream(model, context, options);
				},
			});
			const run = startSession(
				agent,
				walkSettings(PRIMARY, {
					"retry.usageReservePolicy": "confirm",
					"retry.fallbackChains": chainOf(FALLBACK, NEXT_FALLBACK),
				}),
			);
			const offered: string[] = [];
			run.session.setUsageFallbackConfirmer(async confirmation => {
				offered.push(confirmation.to);
				return false;
			});

			await runTurn(run.session, "Keep the primary at the reserve");
			denyPrimary = true;
			await runTurn(run.session, "Fail on the primary");
			denyPrimary = false;
			await run.session.setModel(PRIMARY);
			await runTurn(run.session, "Spend the primary's reserve again");

			expect(offered).toEqual([formatModelString(NEXT_FALLBACK), formatModelString(NEXT_FALLBACK)]);
			expect(requestedModels).toEqual([
				formatModelString(PRIMARY),
				formatModelString(PRIMARY),
				formatModelString(NEXT_FALLBACK),
				formatModelString(PRIMARY),
			]);
			expect(modelOf(run.session)).toBe(formatModelString(PRIMARY));
		});

		it("switches to the fallback after a spent one whose window holds the retry only without the failed turn", async () => {
			// The search from the spent fallback fits the fallback after it to the
			// retry's context, which drops the failed turn. Here the failed turn's
			// thinking alone overflows that fallback's window, and the rest of the
			// request fits it.
			const sharedRegistry = modelRegistry;
			const modelsConfigPath = path.join(tempDir.path(), "models-small-gpt-4o-mini.yml");
			await Bun.write(
				modelsConfigPath,
				JSON.stringify({ providers: { openai: { modelOverrides: { [FALLBACK.id]: { contextWindow: 8000 } } } } }),
			);
			modelRegistry = new ModelRegistry(authStorage, modelsConfigPath);
			try {
				stubUsageReads({ [formatModelString(NEXT_FALLBACK)]: depletedRead("usage") });
				const requestedModels: string[] = [];
				const run = startSession(
					createWalkAgent(PRIMARY, requestedModels, {
						content: [{ type: "thinking", thinking: "lorem ipsum ".repeat(5000) }],
						stopReason: "error",
						errorMessage: ACCOUNT_POLICY_DENIAL.errorMessage,
					}),
					walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(NEXT_FALLBACK, FALLBACK) }),
				);

				await runTurn(run.session, "Fail on the primary after a long thought");

				expect(requestedModels).toEqual([formatModelString(PRIMARY), formatModelString(FALLBACK)]);
				expect(modelOf(run.session)).toBe(formatModelString(FALLBACK));
				expect(lastAssistant(run.session).stopReason).toBe("stop");
			} finally {
				modelRegistry = sharedRegistry;
			}
		});
	});

	describe("switching to a fallback whose usage is not spent", () => {
		it("switches to a fallback at the reserve", async () => {
			stubUsageReads({
				[formatModelString(FALLBACK)]: {
					state: "reserve",
					accounts: [{ credentialId: 1, credentialType: "oauth", state: "reserve", remainingFraction: 0.05 }],
				},
			});
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK) }),
			);

			await runTurn(run.session, "Fail on the primary");

			expectAnsweredOnFallback(run, requestedModels);
		});

		it("switches to a fallback whose usage is unknown", async () => {
			stubUsageReads({
				[formatModelString(FALLBACK)]: {
					state: "unknown",
					accounts: [{ credentialId: 1, credentialType: "oauth", state: "unknown" }],
				},
			});
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK) }),
			);

			await runTurn(run.session, "Fail on the primary");

			expectAnsweredOnFallback(run, requestedModels);
		});

		it("switches to a fallback whose usage read throws", async () => {
			stubUsageReads({ [formatModelString(FALLBACK)]: new Error("usage endpoint unreachable") });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK) }),
			);

			await runTurn(run.session, "Fail on the primary");

			expectAnsweredOnFallback(run, requestedModels);
		});

		for (const cause of ["account-policy", "auth"] as const) {
			it(`switches to a depleted fallback that only a short ${cause} block holds`, async () => {
				stubUsageReads({ [formatModelString(FALLBACK)]: depletedRead(cause) });
				const requestedModels: string[] = [];
				const run = startSession(
					createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
					walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK) }),
				);

				await runTurn(run.session, "Fail on the primary");

				expectAnsweredOnFallback(run, requestedModels);
			});
		}

		it("switches to a fallback whose depleted read lists no account", async () => {
			// The plan gate leaves this read when it filters every account out.
			stubUsageReads({ [formatModelString(FALLBACK)]: { state: "depleted", accounts: [] } });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK) }),
			);

			await runTurn(run.session, "Fail on the primary");

			expectAnsweredOnFallback(run, requestedModels);
		});

		it("switches to a fallback that a usage limit holds on one account only", async () => {
			stubUsageReads({ [formatModelString(FALLBACK)]: depletedRead("usage", "account-policy") });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK) }),
			);

			await runTurn(run.session, "Fail on the primary");

			expectAnsweredOnFallback(run, requestedModels);
		});

		it("switches to a spent fallback when usage-aware fallback is off", async () => {
			stubUsageReads({ [formatModelString(FALLBACK)]: depletedRead("usage") });
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, {
					"retry.usageAwareFallback": false,
					"retry.fallbackChains": chainOf(FALLBACK),
				}),
			);

			await runTurn(run.session, "Fail on the primary");

			expectAnsweredOnFallback(run, requestedModels);
		});
	});

	describe("refusal steps with every usage read healthy", () => {
		it("steps a classifier refusal down to the next model", async () => {
			stubUsageReads({});
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, CLASSIFIER_REFUSAL),
				walkSettings(PRIMARY, { "retry.maxRetries": 1, "retry.fallbackChains": chainOf(FALLBACK) }),
			);

			await runTurn(run.session, "Recover from a classifier refusal");

			expectAnsweredOnFallback(run, requestedModels);
		});

		it("tries every Codex account on an account-policy denial and then the configured fallback", async () => {
			const providerSessionId = "usage-walk-codex-account-policy";
			vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
			registerMockApi(MOCK_API_SOURCE);
			const accountKeys = ["codex-key-A", "codex-key-B", "codex-key-C", "codex-key-D"];
			await authStorage.credentials.set(
				CODEX.provider,
				accountKeys.map(key => ({ type: "api_key" as const, key })),
			);
			stubUsageReads({});
			const requestedKeys: string[] = [];
			const codexMock = createMockModel({
				id: CODEX.id,
				provider: CODEX.provider,
				handler: (_context, options) => {
					if (typeof options?.apiKey !== "string") {
						throw new Error("Expected streamSimple to pass a resolved string API key");
					}
					requestedKeys.push(options.apiKey);
					return CODEX_ACCOUNT_POLICY_DENIAL;
				},
			});
			const answerMock = createMockModel({ handler: { content: ["answered"] } });
			const requestedModels: string[] = [];
			const agent = new Agent({
				getApiKey: model => modelRegistry.resolver(model, providerSessionId),
				sessionId: providerSessionId,
				initialState: { model: CODEX, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (model, context, options) => {
					requestedModels.push(formatModelString(model));
					return model.provider === CODEX.provider
						? aiStream.streamSimple(codexMock.model, context, options)
						: answerMock.stream(model, context, options);
				},
			});
			const run = startSession(
				agent,
				walkSettings(CODEX, { "retry.maxRetries": 0, "retry.fallbackChains": chainOf(CODEX_FALLBACK) }),
				providerSessionId,
			);

			await runTurn(run.session, "Continue authorized security work");

			expect(requestedModels).toEqual([
				...accountKeys.map(() => formatModelString(CODEX)),
				formatModelString(CODEX_FALLBACK),
			]);
			expect([...requestedKeys].sort()).toEqual(accountKeys);
			expect(run.fallbacks).toEqual([formatModelString(CODEX_FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(CODEX_FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("walks a Codex plan denial to the same model on another provider", async () => {
			authStorage.keys.setRuntime(CODEX.provider, `${CODEX.provider}-test-key`);
			stubUsageReads({});
			const requestedModels: string[] = [];
			const planDenial = `Codex error event: The '${CODEX.id}' model is not supported when using Codex with a ChatGPT account. (code=model_not_found)`;
			const run = startSession(
				createWalkAgent(CODEX, requestedModels, model => providerErrorStream(model, planDenial)),
				walkSettings(CODEX, { "retry.fallbackChains": { [`${CODEX.provider}/*`]: ["openai/*"] } }),
			);

			await runTurn(run.session, "Use a model the plan does not include");

			const sameModelElsewhere = `openai/${CODEX.id}`;
			expect(requestedModels).toEqual([formatModelString(CODEX), sameModelElsewhere]);
			expect(run.fallbacks).toEqual([sameModelElsewhere]);
			expect(modelOf(run.session)).toBe(sameModelElsewhere);
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});
	});

	describe("a classifier refusal whose fallback-credit target is spent", () => {
		// The catalog lets Fable's refusal credit be redeemed on Opus 4.8 and not on Sonnet 4.5.
		const FABLE = bundled("anthropic", "claude-fable-5");
		const CREDIT_TARGET = bundled("anthropic", "claude-opus-4-8");
		const OTHER_CLAUDE = bundled("anthropic", "claude-sonnet-4-5");

		/** A Fable refusal that carries a live fallback credit. */
		function refusalWithCredit(): MockResponse {
			return {
				content: [{ type: "thinking", thinking: "Before the refusal.", thinkingSignature: "sig_fable_refusal" }],
				stopReason: "error",
				stopDetails: {
					type: "refusal",
					category: "cyber",
					explanation: "Classifier declined this turn.",
					fallback_credit_token: "fct_signed_test",
					fallback_has_prefill_claim: true,
				},
				errorMessage: "Refusal (cyber): Classifier declined this turn.",
				fallbackCreditHandle: {
					token: "fct_signed_test",
					prefillClaim: true,
					params: {
						model: FABLE.id,
						messages: [{ role: "user", content: "Test prompt" }],
						max_tokens: 1024,
						stream: true,
					},
					betas: ["fallback-credit-2026-06-01"],
					expiresAt: Date.now() + 60_000,
				},
			};
		}

		// The walk sends no request to the spent target. It takes what the check
		// before a model call would pick from the target: the model after it in
		// the chain, which no credit holds back. With no model after the target,
		// the credit counts as absent and the other Claude model, which the credit
		// held back, answers.
		for (const [order, chain, answer] of [
			["the target first", chainOf(CREDIT_TARGET, OTHER_CLAUDE), OTHER_CLAUDE],
			["the other model first", chainOf(OTHER_CLAUDE, CREDIT_TARGET), OTHER_CLAUDE],
			["the target first, another provider last", chainOf(CREDIT_TARGET, OTHER_CLAUDE, FALLBACK), OTHER_CLAUDE],
			["the other model first, another provider last", chainOf(OTHER_CLAUDE, CREDIT_TARGET, FALLBACK), FALLBACK],
		] as const) {
			it(`steps a refusal past its spent fallback-credit target to the next model (${order})`, async () => {
				stubUsageReads({ [formatModelString(CREDIT_TARGET)]: depletedRead("usage") });
				const requestedModels: string[] = [];
				// Stamped with Fable's identity, so the retry policy reads the refusal as Fable's.
				const mock = createMockModel({
					provider: FABLE.provider,
					id: FABLE.id,
					responses: [
						{
							content: [
								{ type: "thinking", thinking: "Signed reasoning.", thinkingSignature: "seed-signature" },
								"Seeded turn",
							],
						},
						refusalWithCredit(),
					],
					handler: { content: ["answered"] },
				});
				const agent = new Agent({
					getApiKey: model => `${model.provider}-test-key`,
					initialState: { model: FABLE, systemPrompt: ["Test"], tools: [], messages: [] },
					streamFn: (model, context, options) => {
						requestedModels.push(formatModelString(model));
						return mock.stream(model, context, options);
					},
				});
				const run = startSession(
					agent,
					walkSettings(FABLE, {
						"retry.maxRetries": 1,
						"retry.fallbackChains": chain,
						"retry.fallbackRevertPolicy": "cooldown-expiry",
					}),
				);
				await runTurn(run.session, "Seed signed thinking");
				// While a Fable turn with signed thinking leads the history and the
				// credit is live, the refusal walk passes over the Claude models that
				// cannot redeem it.
				const seeded = agent.state.messages.findLast(
					(message): message is AssistantMessage => message.role === "assistant",
				);
				if (!seeded) throw new Error("Expected the seeded assistant message");
				seeded.api = FABLE.api;

				await runTurn(run.session, "Recover from the refusal");

				expect(requestedModels).toEqual([
					formatModelString(FABLE),
					formatModelString(FABLE),
					formatModelString(answer),
				]);
				expect(run.fallbacks).toEqual([formatModelString(answer)]);
				expect(modelOf(run.session)).toBe(formatModelString(answer));
				expect(lastAssistant(run.session).stopReason).toBe("stop");
			});
		}

		// The catalog also lets Fable's refusal credit be redeemed on Opus 5.
		const NEXT_CREDIT_TARGET = bundled("anthropic", "claude-opus-5");

		/**
		 * Seeds a Fable turn with signed thinking, then sends a turn that Fable
		 * refuses with a live fallback credit, with the setup of each order above:
		 * the walk runs on `chain`, `usage` answers the usage reads, and
		 * `thinkingLevelCeiling`, when given, is the session's effort ceiling.
		 */
		async function runCreditRefusal(
			chain: Record<string, string[]>,
			usage: Record<string, UsageAnswer>,
			thinkingLevelCeiling?: Effort,
		): Promise<{ run: WalkRun; requestedModels: string[] }> {
			stubUsageReads(usage);
			const requestedModels: string[] = [];
			// Stamped with Fable's identity, so the retry policy reads the refusal as Fable's.
			const mock = createMockModel({
				provider: FABLE.provider,
				id: FABLE.id,
				responses: [
					{
						content: [
							{ type: "thinking", thinking: "Signed reasoning.", thinkingSignature: "seed-signature" },
							"Seeded turn",
						],
					},
					refusalWithCredit(),
				],
				handler: { content: ["answered"] },
			});
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: { model: FABLE, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (model, context, options) => {
					requestedModels.push(formatModelString(model));
					return mock.stream(model, context, options);
				},
			});
			const run = startSession(
				agent,
				walkSettings(FABLE, {
					"retry.maxRetries": 1,
					"retry.fallbackChains": chain,
					"retry.fallbackRevertPolicy": "cooldown-expiry",
				}),
				undefined,
				thinkingLevelCeiling,
			);
			await runTurn(run.session, "Seed signed thinking");
			const seeded = agent.state.messages.findLast(
				(message): message is AssistantMessage => message.role === "assistant",
			);
			if (!seeded) throw new Error("Expected the seeded assistant message");
			seeded.api = FABLE.api;

			await runTurn(run.session, "Recover from the refusal");
			return { run, requestedModels };
		}

		it("keeps holding the same-provider Claude models for a live credit whose targets are not in the chain", async () => {
			// No fallback the walk reaches is spent, so the credit stays live and the
			// walk passes over the Claude model that cannot redeem it.
			const { run, requestedModels } = await runCreditRefusal(chainOf(OTHER_CLAUDE), {});

			expect(requestedModels).toEqual([formatModelString(FABLE), formatModelString(FABLE)]);
			expect(run.fallbacks).toEqual([]);
			expect(modelOf(run.session)).toBe(formatModelString(FABLE));
			// The refusal ends the turn. The session drops it from the active
			// context and keeps it as the last assistant message.
			const refusal = run.session.getLastAssistantMessage();
			expect(refusal?.stopReason).toBe("error");
			expect(refusal?.stopDetails?.type).toBe("refusal");
		});

		it("answers on the model after a spent first target, ahead of the next target", async () => {
			// The walk sends no request to the spent target. The check before a model
			// call would pick the model after it in the chain, which no credit holds
			// back, so the other Claude model answers before Opus 5 is reached.
			const { run, requestedModels } = await runCreditRefusal(
				chainOf(CREDIT_TARGET, OTHER_CLAUDE, NEXT_CREDIT_TARGET),
				{ [formatModelString(CREDIT_TARGET)]: depletedRead("usage") },
			);

			expect(requestedModels).toEqual([
				formatModelString(FABLE),
				formatModelString(FABLE),
				formatModelString(OTHER_CLAUDE),
			]);
			expect(run.fallbacks).toEqual([formatModelString(OTHER_CLAUDE)]);
			expect(modelOf(run.session)).toBe(formatModelString(OTHER_CLAUDE));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("holds the same-provider Claude model back for a live credit whose target is usable", async () => {
			const { run, requestedModels } = await runCreditRefusal(chainOf(OTHER_CLAUDE, CREDIT_TARGET), {});

			expect(requestedModels).toEqual([
				formatModelString(FABLE),
				formatModelString(FABLE),
				formatModelString(CREDIT_TARGET),
			]);
			expect(run.fallbacks).toEqual([formatModelString(CREDIT_TARGET)]);
			expect(modelOf(run.session)).toBe(formatModelString(CREDIT_TARGET));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("steps a refusal to the next model when the spent target's sibling target cannot hold the context", async () => {
			// Opus 5's window here cannot hold the conversation. The walk sends no
			// request to the spent Opus 4.8 and takes what the check before a model
			// call would pick from it: Sonnet 4.5, next in the chain, so Opus 5 is not
			// reached and changes nothing.
			const sharedRegistry = modelRegistry;
			const modelsConfigPath = path.join(tempDir.path(), "models-small-opus-5.yml");
			await Bun.write(
				modelsConfigPath,
				JSON.stringify({
					providers: { anthropic: { modelOverrides: { [NEXT_CREDIT_TARGET.id]: { contextWindow: 1 } } } },
				}),
			);
			modelRegistry = new ModelRegistry(authStorage, modelsConfigPath);
			try {
				const { run, requestedModels } = await runCreditRefusal(
					chainOf(CREDIT_TARGET, OTHER_CLAUDE, NEXT_CREDIT_TARGET),
					{ [formatModelString(CREDIT_TARGET)]: depletedRead("usage") },
				);

				expect(requestedModels).toEqual([
					formatModelString(FABLE),
					formatModelString(FABLE),
					formatModelString(OTHER_CLAUDE),
				]);
				expect(run.fallbacks).toEqual([formatModelString(OTHER_CLAUDE)]);
				expect(modelOf(run.session)).toBe(formatModelString(OTHER_CLAUDE));
				expect(lastAssistant(run.session).stopReason).toBe("stop");
			} finally {
				modelRegistry = sharedRegistry;
			}
		});

		it("steps a refusal to the next model when the spent target's sibling target is over the effort ceiling", async () => {
			// Opus 5 here supports no effort at or below the session's ceiling. The
			// walk sends no request to the spent Opus 4.8 and takes what the check
			// before a model call would pick from it: Sonnet 4.5, next in the
			// chain, so Opus 5 is not reached and changes nothing. The catalog
			// gives both Opus models the same efforts, so this registry gives Opus
			// 5 none below xhigh; Opus 4.8 and Sonnet 4.5 each support an effort at
			// or below the high ceiling.
			const sharedRegistry = modelRegistry;
			const modelsConfigPath = path.join(tempDir.path(), "models-xhigh-floor-opus-5.yml");
			await Bun.write(
				modelsConfigPath,
				JSON.stringify({
					providers: {
						anthropic: {
							modelOverrides: {
								[NEXT_CREDIT_TARGET.id]: {
									thinking: { mode: "anthropic-adaptive", efforts: [Effort.XHigh, Effort.Max] },
								},
							},
						},
					},
				}),
			);
			modelRegistry = new ModelRegistry(authStorage, modelsConfigPath);
			try {
				const { run, requestedModels } = await runCreditRefusal(
					chainOf(CREDIT_TARGET, OTHER_CLAUDE, NEXT_CREDIT_TARGET),
					{ [formatModelString(CREDIT_TARGET)]: depletedRead("usage") },
					Effort.High,
				);

				expect(requestedModels).toEqual([
					formatModelString(FABLE),
					formatModelString(FABLE),
					formatModelString(OTHER_CLAUDE),
				]);
				expect(run.fallbacks).toEqual([formatModelString(OTHER_CLAUDE)]);
				expect(modelOf(run.session)).toBe(formatModelString(OTHER_CLAUDE));
				expect(lastAssistant(run.session).stopReason).toBe("stop");
			} finally {
				modelRegistry = sharedRegistry;
			}
		});

		it("steps a refusal to the next model when the spent target's sibling target has no key", async () => {
			// Opus 5 has no key here. The walk sends no request to the spent Opus
			// 4.8 and takes what the check before a model call would pick from it:
			// Sonnet 4.5, next in the chain, so Opus 5 is not reached and changes
			// nothing. Every other model keeps its key.
			const getApiKey = modelRegistry.getApiKey.bind(modelRegistry);
			vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, sessionId, options) =>
				model.provider === NEXT_CREDIT_TARGET.provider && model.id === NEXT_CREDIT_TARGET.id
					? undefined
					: getApiKey(model, sessionId, options),
			);
			const { run, requestedModels } = await runCreditRefusal(
				chainOf(CREDIT_TARGET, OTHER_CLAUDE, NEXT_CREDIT_TARGET),
				{ [formatModelString(CREDIT_TARGET)]: depletedRead("usage") },
			);

			expect(requestedModels).toEqual([
				formatModelString(FABLE),
				formatModelString(FABLE),
				formatModelString(OTHER_CLAUDE),
			]);
			expect(run.fallbacks).toEqual([formatModelString(OTHER_CLAUDE)]);
			expect(modelOf(run.session)).toBe(formatModelString(OTHER_CLAUDE));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("switches to another provider's model first in the chain when a credit target's key read fails", async () => {
			// The walk switches to the model first in the chain and never reaches the
			// credit target, so the target's failing key read must not end the turn.
			const getApiKey = modelRegistry.getApiKey.bind(modelRegistry);
			vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, sessionId, options) => {
				if (model.provider === CREDIT_TARGET.provider && model.id === CREDIT_TARGET.id) {
					throw new Error("credential command failed");
				}
				return getApiKey(model, sessionId, options);
			});
			const { run, requestedModels } = await runCreditRefusal(chainOf(FALLBACK, CREDIT_TARGET), {});

			expect(requestedModels).toEqual([
				formatModelString(FABLE),
				formatModelString(FABLE),
				formatModelString(FALLBACK),
			]);
			expect(run.fallbacks).toEqual([formatModelString(FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("reads no key of a credit target the walk does not reach", async () => {
			// The walk switches to Opus 4.8, the first credit target, whose usage is
			// not spent, so it never reaches Opus 5 and reads no key of it. The key
			// reads of Opus 4.8 show that the spy records.
			const creditTargetKeyReads: string[] = [];
			const getApiKey = modelRegistry.getApiKey.bind(modelRegistry);
			vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, sessionId, options) => {
				const read = formatModelString(model);
				if (read === formatModelString(CREDIT_TARGET) || read === formatModelString(NEXT_CREDIT_TARGET)) {
					creditTargetKeyReads.push(read);
				}
				return getApiKey(model, sessionId, options);
			});
			const { run, requestedModels } = await runCreditRefusal(chainOf(CREDIT_TARGET, NEXT_CREDIT_TARGET), {});

			expect(creditTargetKeyReads).toContain(formatModelString(CREDIT_TARGET));
			expect(creditTargetKeyReads).not.toContain(formatModelString(NEXT_CREDIT_TARGET));
			expect(requestedModels).toEqual([
				formatModelString(FABLE),
				formatModelString(FABLE),
				formatModelString(CREDIT_TARGET),
			]);
			expect(run.fallbacks).toEqual([formatModelString(CREDIT_TARGET)]);
		});

		it("steps a refusal to the next model when the spent target's sibling target fails its key read", async () => {
			// Opus 5's key read throws here. The walk sends no request to the spent
			// Opus 4.8 and takes what the check before a model call would pick from
			// it: Sonnet 4.5, next in the chain, so Opus 5's key is never read and
			// nothing is raised.
			const getApiKey = modelRegistry.getApiKey.bind(modelRegistry);
			vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, sessionId, options) => {
				if (model.provider === NEXT_CREDIT_TARGET.provider && model.id === NEXT_CREDIT_TARGET.id) {
					throw new Error("credential command failed");
				}
				return getApiKey(model, sessionId, options);
			});
			const { run, requestedModels } = await runCreditRefusal(
				chainOf(CREDIT_TARGET, OTHER_CLAUDE, NEXT_CREDIT_TARGET),
				{ [formatModelString(CREDIT_TARGET)]: depletedRead("usage") },
			);

			expect(requestedModels).toEqual([
				formatModelString(FABLE),
				formatModelString(FABLE),
				formatModelString(OTHER_CLAUDE),
			]);
			expect(run.fallbacks).toEqual([formatModelString(OTHER_CLAUDE)]);
			expect(modelOf(run.session)).toBe(formatModelString(OTHER_CLAUDE));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("passes over the target after the spent target when its key read fails, to the model after it", async () => {
			// Opus 5's key read throws here, and Opus 5 follows the spent target in
			// the chain. The walk sends no request to the spent target and takes what
			// the check before a model call would pick from it. That check passes over
			// Opus 5 and raises nothing, so the other Claude model answers.
			const getApiKey = modelRegistry.getApiKey.bind(modelRegistry);
			vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, sessionId, options) => {
				if (model.provider === NEXT_CREDIT_TARGET.provider && model.id === NEXT_CREDIT_TARGET.id) {
					throw new Error("credential command failed");
				}
				return getApiKey(model, sessionId, options);
			});
			const { run, requestedModels } = await runCreditRefusal(
				chainOf(CREDIT_TARGET, NEXT_CREDIT_TARGET, OTHER_CLAUDE),
				{ [formatModelString(CREDIT_TARGET)]: depletedRead("usage") },
			);

			expect(requestedModels).toEqual([
				formatModelString(FABLE),
				formatModelString(FABLE),
				formatModelString(OTHER_CLAUDE),
			]);
			expect(run.fallbacks).toEqual([formatModelString(OTHER_CLAUDE)]);
			expect(modelOf(run.session)).toBe(formatModelString(OTHER_CLAUDE));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("answers on the Claude model the credit held back when nothing follows a spent fallback", async () => {
			// The live credit holds the other Claude model back, and the fallback
			// after it is spent. The check before a model call would pick nothing
			// from that fallback, so the credit counts as absent and the model it
			// held back answers.
			const { run, requestedModels } = await runCreditRefusal(chainOf(OTHER_CLAUDE, FALLBACK), {
				[formatModelString(FALLBACK)]: depletedRead("usage"),
			});

			expect(requestedModels).toEqual([
				formatModelString(FABLE),
				formatModelString(FABLE),
				formatModelString(OTHER_CLAUDE),
			]);
			expect(run.fallbacks).toEqual([formatModelString(OTHER_CLAUDE)]);
			expect(modelOf(run.session)).toBe(formatModelString(OTHER_CLAUDE));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("answers on the Claude model the credit held back at the session's level when the spent fallback names a level", async () => {
			// The spent target's selector names low. The held model was passed over
			// before the target, so it keeps the session's level, high.
			stubUsageReads({ [formatModelString(CREDIT_TARGET)]: depletedRead("usage") });
			const requests: string[] = [];
			const mock = createMockModel({
				provider: FABLE.provider,
				id: FABLE.id,
				responses: [
					{
						content: [
							{ type: "thinking", thinking: "Signed reasoning.", thinkingSignature: "seed-signature" },
							"Seeded turn",
						],
					},
					refusalWithCredit(),
				],
				handler: { content: ["answered"] },
			});
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: { model: FABLE, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (model, context, options) => {
					requests.push(`${formatModelString(model)} at ${options?.reasoning}`);
					return mock.stream(model, context, options);
				},
			});
			const run = startSession(
				agent,
				walkSettings(FABLE, {
					"retry.maxRetries": 1,
					"retry.fallbackChains": {
						default: [formatModelString(OTHER_CLAUDE), `${formatModelString(CREDIT_TARGET)}:low`],
					},
					"retry.fallbackRevertPolicy": "cooldown-expiry",
				}),
				undefined,
				Effort.High,
			);
			run.session.setThinkingLevel(Effort.High);
			await runTurn(run.session, "Seed signed thinking");
			const seeded = agent.state.messages.findLast(
				(message): message is AssistantMessage => message.role === "assistant",
			);
			if (!seeded) throw new Error("Expected the seeded assistant message");
			seeded.api = FABLE.api;

			await runTurn(run.session, "Recover from the refusal");

			expect(requests).toEqual([
				`${formatModelString(FABLE)} at high`,
				`${formatModelString(FABLE)} at high`,
				`${formatModelString(OTHER_CLAUDE)} at high`,
			]);
			expect(modelOf(run.session)).toBe(formatModelString(OTHER_CLAUDE));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});

		it("ends the turn on Fable's refusal when the spent target's own chain names only Fable", async () => {
			// The search from the spent target finds only Fable, which the target's
			// own chain names. Fable refused in the turn, so the step past the target
			// passes over it, as the refusal walk does: the walk sends no request to
			// the target or to Fable, and the turn ends on the refusal.
			const { run, requestedModels } = await runCreditRefusal(
				{
					default: [formatModelString(CREDIT_TARGET)],
					[formatModelString(CREDIT_TARGET)]: [formatModelString(FABLE)],
				},
				{ [formatModelString(CREDIT_TARGET)]: depletedRead("usage") },
			);

			expect(requestedModels).toEqual([formatModelString(FABLE), formatModelString(FABLE)]);
			expect(run.fallbacks).toEqual([]);
			expect(modelOf(run.session)).toBe(formatModelString(FABLE));
			// The session drops the refusal from the active context and keeps it as
			// the last assistant message.
			const refusal = run.session.getLastAssistantMessage();
			expect(refusal?.stopReason).toBe("error");
			expect(refusal?.stopDetails?.type).toBe("refusal");
		});

		it("leaves the fallback in use unpinned when the step past a spent target finds only Fable, which refused, so the primary is restored when its cooldown ends", async () => {
			// An account-policy denial on the primary switches to Fable, unpinned.
			// Fable then refuses with a live credit, and the walk reaches the spent
			// target, whose own chain names only Fable. Fable refused in the turn, so
			// the step past the target passes over it: the turn ends on the refusal
			// with no switch and no pin. `cooldown-expiry` restores an unpinned
			// fallback's primary once its cooldown ends; the primary fails again, and
			// the walk goes back to Fable.
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);
			stubUsageReads({ [formatModelString(CREDIT_TARGET)]: depletedRead("usage") });
			const requestedModels: string[] = [];
			const primaryMock = createMockModel();
			// Stamped with Fable's identity, so the retry policy reads the refusal as Fable's.
			const fableMock = createMockModel({
				provider: FABLE.provider,
				id: FABLE.id,
				responses: [{ content: ["answered"] }, refusalWithCredit()],
				handler: { content: ["answered"] },
			});
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: { model: PRIMARY, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (model, context, options) => {
					requestedModels.push(formatModelString(model));
					if (model.provider === PRIMARY.provider && model.id === PRIMARY.id) {
						primaryMock.push(ACCOUNT_POLICY_DENIAL);
						return primaryMock.stream(model, context, options);
					}
					return fableMock.stream(model, context, options);
				},
			});
			const run = startSession(
				agent,
				walkSettings(PRIMARY, {
					"retry.fallbackChains": {
						default: [formatModelString(FABLE), formatModelString(CREDIT_TARGET)],
						[formatModelString(CREDIT_TARGET)]: [formatModelString(FABLE)],
					},
					"retry.fallbackRevertPolicy": "cooldown-expiry",
				}),
			);

			await runTurn(run.session, "Fail on the primary");
			await runTurn(run.session, "Recover from the refusal");
			// Past every fallback cooldown (30 minutes at most), so nothing keeps the
			// session on Fable.
			now += 60 * 60 * 1000;
			await runTurn(run.session, "Go back to the primary after the cooldown");

			expect(requestedModels).toEqual([
				formatModelString(PRIMARY),
				formatModelString(FABLE),
				formatModelString(FABLE),
				formatModelString(PRIMARY),
				formatModelString(FABLE),
			]);
			expect(run.fallbacks).toEqual([formatModelString(FABLE), formatModelString(FABLE)]);
			expect(modelOf(run.session)).toBe(formatModelString(FABLE));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});
	});

	describe("the fallback before a turn keeps its rule", () => {
		it("passes over a fallback at the reserve when the primary is spent before its first request", async () => {
			// The walk after a failed request switches to a fallback at the reserve.
			// The check before the model call does not: on a spent primary it moves
			// to the first fallback that is neither depleted nor at the reserve.
			stubUsageReads({
				[formatModelString(PRIMARY)]: depletedRead("usage"),
				[formatModelString(FALLBACK)]: {
					state: "reserve",
					accounts: [{ credentialId: 1, credentialType: "oauth", state: "reserve", remainingFraction: 0.05 }],
				},
			});
			const requestedModels: string[] = [];
			const run = startSession(
				createWalkAgent(PRIMARY, requestedModels, ACCOUNT_POLICY_DENIAL),
				walkSettings(PRIMARY, { "retry.fallbackChains": chainOf(FALLBACK, NEXT_FALLBACK) }),
			);

			await runTurn(run.session, "Start on a spent primary");

			expect(requestedModels).toEqual([formatModelString(NEXT_FALLBACK)]);
			expect(run.fallbacks).toEqual([formatModelString(NEXT_FALLBACK)]);
			expect(modelOf(run.session)).toBe(formatModelString(NEXT_FALLBACK));
			expect(lastAssistant(run.session).stopReason).toBe("stop");
		});
	});
});
