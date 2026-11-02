import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

const MOCK_API_SOURCE = "agent-session-key-resolution-retry-test";
const PROVIDER_SESSION_ID = "key-resolution-retry-session";
const BASE_DELAY_MS = 40;
const FINAL_ANSWER = "finished after the key came back";
const ANTHROPIC_MODEL = { provider: "anthropic", id: "claude-sonnet-4-5" };
const COPILOT_MODEL = { provider: "github-copilot", id: "gpt-4o" };

const probeSchema = type({ value: "string" });

function oauthLogin(account: string, expires = Date.now() + 3_600_000) {
	return {
		type: "oauth" as const,
		access: `access-${account}`,
		refresh: `refresh-${account}`,
		expires,
		accountId: account,
		email: `${account}@example.com`,
	};
}

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant") throw new Error("Expected a trailing assistant message");
	return message;
}

/** Makes the anthropic key unreadable (`start`) and readable again (`end`). */
interface KeyOutage {
	start(): Promise<void>;
	end(): Promise<void>;
}

/**
 * Each way a stored anthropic credential can exist yet serve no request for a
 * while, driven through the real credential store:
 * - `credential-disabled`: a failed refresh disabled the only OAuth login; a new
 *   login (here or in another session sharing the store) brings one back.
 * - `pool-unavailable`: the session is restricted to an OAuth account pool none
 *   of whose accounts can serve; the restriction lifts.
 * - `refresh-unavailable`: the login expired and its refresh fails with a
 *   network error the error text does not name as transient; a refresh succeeds.
 */
const OUTAGE_MODES = ["credential-disabled", "pool-unavailable", "refresh-unavailable"] as const;
type OutageMode = (typeof OUTAGE_MODES)[number];

describe("AgentSession: a provider key that cannot be resolved for a moment", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];
	const outages: KeyOutage[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-key-resolution-retry-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		await authStorage.credentials.set("anthropic", [oauthLogin("acc-live")]);
		registerMockApi(MOCK_API_SOURCE);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const outage of outages.splice(0)) await outage.end();
		unregisterCustomApis(MOCK_API_SOURCE);
		vi.restoreAllMocks();
		authStorage.close();
		tempDir.removeSync();
	});

	function keyOutage(mode: OutageMode): KeyOutage {
		let outage: KeyOutage;
		switch (mode) {
			case "credential-disabled":
				outage = {
					start: async () => {
						for (const account of authStorage.oauth.accounts("anthropic")) {
							await authStorage.credentials.disable(
								account.credentialId,
								'oauth refresh failed: HTTP 400 {"error":"invalid_grant"}',
							);
						}
					},
					end: async () => {
						if (!authStorage.credentials.has("anthropic")) {
							await authStorage.credentials.set("anthropic", [oauthLogin("acc-relogin")]);
						}
					},
				};
				break;
			case "pool-unavailable": {
				let lift: (() => void) | undefined;
				outage = {
					start: async () => {
						const lease = authStorage.sessions.restrict("anthropic", PROVIDER_SESSION_ID, ["account:acc-gone"]);
						lift = () => authStorage.sessions.unrestrict("anthropic", PROVIDER_SESSION_ID, lease);
					},
					end: async () => {
						lift?.();
						lift = undefined;
					},
				};
				break;
			}
			case "refresh-unavailable": {
				let refreshing = false;
				vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
					if (!refreshing) throw new Error("ECONNRESET");
					return { access: "access-refreshed", refresh: "refresh-refreshed", expires: Date.now() + 3_600_000 };
				});
				outage = {
					start: async () => {
						refreshing = false;
						await authStorage.credentials.set("anthropic", [oauthLogin("acc-live", Date.now() - 60_000)]);
					},
					end: async () => {
						refreshing = true;
					},
				};
				break;
			}
		}
		outages.push(outage);
		return outage;
	}

	/**
	 * A session on the production key path (`ModelRegistry.turnResolver`, as
	 * sdk.ts wires it) whose model calls `probe` once and then answers. With
	 * `outage`, the key goes away while `probe` runs (`startOn: "probe"`) or
	 * before the prompt (`startOn: "prompt"`, the caller starts it), and comes
	 * back after `resolvesWhileDown` of the turn's key resolutions have failed.
	 */
	function openSession(options: {
		maxRetries: number;
		sessionManager: SessionManager;
		model?: { provider: string; id: string };
		outage?: { keys: KeyOutage; startOn: "probe" | "prompt"; resolvesWhileDown: number };
	}) {
		const modelRef = options.model ?? ANTHROPIC_MODEL;
		const model = getBundledModel(modelRef.provider, modelRef.id);
		if (!model) throw new Error(`Expected bundled test model ${modelRef.provider}/${modelRef.id} to exist`);
		const outage = options.outage;
		let down = outage?.startOn === "prompt";
		let failedResolves = 0;
		const probeRuns: string[] = [];
		const probe: AgentTool<typeof probeSchema, { value: string }> = {
			name: "probe",
			label: "Probe",
			description: "Probe tool",
			parameters: probeSchema,
			async execute(_toolCallId, params) {
				probeRuns.push(params.value);
				if (outage?.startOn === "probe" && probeRuns.length === 1) {
					await outage.keys.start();
					down = true;
				}
				return { content: [{ type: "text", text: `ok:${params.value}` }], details: params };
			},
		};
		const mock = createMockModel({
			id: model.id,
			provider: model.provider,
			handler: context =>
				context.messages.some(message => message.role === "toolResult")
					? { content: [FINAL_ANSWER], stopReason: "stop" }
					: {
							content: [{ type: "toolCall", id: "call_probe", name: "probe", arguments: { value: "x" } }],
							stopReason: "toolUse",
						},
		});
		const agent = new Agent({
			getApiKey: async requestModel => {
				if (outage && down) {
					if (failedResolves === outage.resolvesWhileDown) {
						await outage.keys.end();
						down = false;
					} else {
						failedResolves++;
					}
				}
				return modelRegistry.turnResolver(requestModel, PROVIDER_SESSION_ID);
			},
			sessionId: PROVIDER_SESSION_ID,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [probe as AgentTool],
				messages: options.sessionManager.buildSessionContext().messages,
			},
			streamFn: (_requestModel, context, streamOptions) => aiStream.streamSimple(mock.model, context, streamOptions),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": BASE_DELAY_MS,
			"retry.maxRetries": options.maxRetries,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: options.sessionManager,
			settings,
			modelRegistry,
			providerSessionId: PROVIDER_SESSION_ID,
		});
		sessions.push(session);

		const retryStarts: AutoRetryStartEvent[] = [];
		const retryEnds: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
			if (event.type === "auto_retry_end") retryEnds.push(event);
		});
		return { session, mock, probeRuns, retryStarts, retryEnds };
	}

	for (const mode of OUTAGE_MODES) {
		it(`retries a turn whose key went away mid-turn and finishes once it is back (${mode})`, async () => {
			const { session, mock, probeRuns, retryStarts, retryEnds } = openSession({
				maxRetries: 5,
				sessionManager: SessionManager.inMemory(),
				outage: { keys: keyOutage(mode), startOn: "probe", resolvesWhileDown: 2 },
			});
			const waits = mockSchedulerWaitWithClock();

			await session.prompt("run the probe");
			await session.waitForIdle();

			const last = lastAssistant(session);
			expect({ stopReason: last.stopReason, errorMessage: last.errorMessage }).toEqual({
				stopReason: "stop",
				errorMessage: undefined,
			});
			expect(last.content).toContainEqual({ type: "text", text: FINAL_ANSWER });
			// Two failed resolutions, two backoff retries, then success.
			expect(retryStarts.map(event => event.attempt)).toEqual([1, 2]);
			expect(retryEnds).toEqual([expect.objectContaining({ success: true, attempt: 2 })]);
			// Exponential backoff from retry.baseDelayMs (downward jitter of at most 25%).
			const delays = retryStarts.map(event => event.delayMs);
			expect(delays[0]).toBeGreaterThanOrEqual(BASE_DELAY_MS * 0.75);
			expect(delays[0]).toBeLessThanOrEqual(BASE_DELAY_MS);
			expect(delays[1]).toBeGreaterThanOrEqual(BASE_DELAY_MS * 2 * 0.75);
			expect(delays[1]).toBeLessThanOrEqual(BASE_DELAY_MS * 2);
			// The session slept out each backoff, in order (the 1 ms waits schedule the
			// continuations; a failing OAuth refresh also sleeps between its own attempts).
			const slept = waits.mock.calls.map(call => call[0]).filter(delayMs => delayMs > 1);
			let backoffsSlept = 0;
			for (const delayMs of slept) {
				if (backoffsSlept < delays.length && Math.abs(delayMs - delays[backoffsSlept]!) < 0.5) backoffsSlept++;
			}
			expect(backoffsSlept).toBe(delays.length);
			// No request went out without a key, and the tool did not run again.
			expect(mock.calls).toHaveLength(2);
			expect(probeRuns).toEqual(["x"]);
		});

		it(`starts a prompt sent while the key is away and finishes it once the key is back (${mode})`, async () => {
			const keys = keyOutage(mode);
			await keys.start();
			const { session, mock, probeRuns, retryStarts, retryEnds } = openSession({
				maxRetries: 5,
				sessionManager: SessionManager.inMemory(),
				outage: { keys, startOn: "prompt", resolvesWhileDown: 2 },
			});
			mockSchedulerWaitWithClock();

			await session.prompt("run the probe");
			await session.waitForIdle();

			const last = lastAssistant(session);
			expect(last.stopReason).toBe("stop");
			expect(last.content).toContainEqual({ type: "text", text: FINAL_ANSWER });
			expect(retryStarts.map(event => event.attempt)).toEqual([1, 2]);
			expect(retryEnds).toEqual([expect.objectContaining({ success: true, attempt: 2 })]);
			expect(mock.calls).toHaveLength(2);
			expect(probeRuns).toEqual(["x"]);
		});

		it(`ends the turn with a resumable error past the bound, and omp --restore finishes it (${mode})`, async () => {
			const keys = keyOutage(mode);
			const sessionDir = path.join(tempDir.path(), "sessions");
			const worker = openSession({
				maxRetries: 2,
				sessionManager: SessionManager.create(tempDir.path(), sessionDir),
				outage: { keys, startOn: "probe", resolvesWhileDown: Number.POSITIVE_INFINITY },
			});
			mockSchedulerWaitWithClock();

			await worker.session.prompt("run the probe");
			await worker.session.waitForIdle();

			// The key never came back: the bound is spent and the turn ends on the error,
			// marked as a key that could not be resolved.
			const failed = lastAssistant(worker.session);
			expect(failed.stopReason).toBe("error");
			expect(failed.errorMessage).toStartWith("Retry budget exhausted after 2 retries: ");
			expect(AIError.is(failed.errorId, AIError.Flag.CredentialUnavailable)).toBe(true);
			expect(worker.retryStarts.map(event => event.attempt)).toEqual([1, 2]);
			expect(worker.retryEnds).toEqual([expect.objectContaining({ success: false, attempt: 2 })]);
			expect(worker.mock.calls).toHaveLength(1);

			// The worker process exits normally on the failed turn.
			const sessionFile = worker.session.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session file");
			sessions.splice(sessions.indexOf(worker.session), 1);
			await worker.session.dispose();

			// The key is readable again; a new process restores the session.
			await keys.end();
			const restarted = openSession({ maxRetries: 2, sessionManager: await SessionManager.open(sessionFile) });
			await expect(restarted.session.restoreInterruptedTurn()).resolves.toBe(true);
			await restarted.session.waitForIdle();

			const last = lastAssistant(restarted.session);
			expect(last.stopReason).toBe("stop");
			expect(last.content).toContainEqual({ type: "text", text: FINAL_ANSWER });
			// It went on from the tool result: one request, and the tool did not run again.
			expect(restarted.mock.calls).toHaveLength(1);
			expect(restarted.probeRuns).toEqual([]);
		});
	}

	it("keeps a stored GitHub Copilot credential whose lookup yields nothing, so the retry can use it", async () => {
		await authStorage.credentials.set("github-copilot", [{ type: "api_key", key: "ghu_test_token" }]);
		let readable = true;
		const readKey = authStorage.keys.getWithCredential.bind(authStorage.keys);
		vi.spyOn(authStorage.keys, "getWithCredential").mockImplementation(async (provider, sessionId, options) =>
			readable ? readKey(provider, sessionId, options) : undefined,
		);
		const keys: KeyOutage = {
			start: async () => {
				readable = false;
			},
			end: async () => {
				readable = true;
			},
		};
		const { session, mock, retryStarts } = openSession({
			maxRetries: 5,
			sessionManager: SessionManager.inMemory(),
			model: COPILOT_MODEL,
			outage: { keys, startOn: "probe", resolvesWhileDown: 2 },
		});
		mockSchedulerWaitWithClock();

		await session.prompt("run the probe");
		await session.waitForIdle();

		const last = lastAssistant(session);
		expect({ stopReason: last.stopReason, errorMessage: last.errorMessage }).toEqual({
			stopReason: "stop",
			errorMessage: undefined,
		});
		expect(retryStarts.map(event => event.attempt)).toEqual([1, 2]);
		expect(mock.calls).toHaveLength(2);
		expect(authStorage.credentials.has("github-copilot")).toBe(true);
	});

	it("ends the turn at once, and refuses the next prompt, when the user removed the credential", async () => {
		const keys: KeyOutage = {
			start: () => authStorage.credentials.remove("anthropic"),
			end: async () => {},
		};
		const sessionDir = path.join(tempDir.path(), "sessions");
		const { session, mock, retryStarts } = openSession({
			maxRetries: 5,
			sessionManager: SessionManager.create(tempDir.path(), sessionDir),
			outage: { keys, startOn: "probe", resolvesWhileDown: Number.POSITIVE_INFINITY },
		});
		mockSchedulerWaitWithClock();

		await session.prompt("run the probe");
		await session.waitForIdle();

		const failed = lastAssistant(session);
		expect({ stopReason: failed.stopReason, errorMessage: failed.errorMessage }).toEqual({
			stopReason: "error",
			errorMessage: "No API key for provider: anthropic",
		});
		expect(AIError.is(failed.errorId, AIError.Flag.CredentialUnavailable)).toBe(false);
		expect(retryStarts).toEqual([]);
		expect(mock.calls).toHaveLength(1);
		await expect(session.prompt("again")).rejects.toThrow("No API key found for anthropic");
		await expect(session.restoreInterruptedTurn()).resolves.toBe(false);
	});

	it("fails a pooled turn for good when a models.yml apiKey owns the provider", async () => {
		const model = getBundledModel(ANTHROPIC_MODEL.provider, ANTHROPIC_MODEL.id);
		if (!model) throw new Error("Expected bundled anthropic test model");
		authStorage.sessions.restrict("anthropic", PROVIDER_SESSION_ID, ["account:acc-live"]);
		authStorage.keys.setConfig("anthropic", "config-key");

		const error = await resolveApiKeyOnce(modelRegistry.turnResolver(model, PROVIDER_SESSION_ID)).catch(
			(failure: unknown) => failure,
		);

		expect(error).toBeInstanceOf(AIError.MissingApiKeyError);
		expect(AIError.retriable(AIError.classify(error))).toBe(false);
	});
});
