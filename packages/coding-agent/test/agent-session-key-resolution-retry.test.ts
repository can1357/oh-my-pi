import { describe, expect, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, resolveCredentialIdentityKey } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SessionAccountPoolScope } from "@oh-my-pi/pi-coding-agent/config/account-pools";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";
import { TestCleanup } from "./helpers/test-cleanup";
import { trackTestLifetime } from "./helpers/test-lifetime";

const { it, beforeEach, afterEach } = trackTestLifetime();

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

/** One test's own credential store and model registry, and the cleanup that owns them. */
interface KeyResolutionContext {
	owner: TestCleanup;
	tempDir: TempDir;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
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
	let cleanup = new TestCleanup();

	beforeEach(() => {
		cleanup = new TestCleanup();
	});

	afterEach(async () => {
		// Restore spies first, so a cleanup that throws or hangs cannot leave them installed.
		// Nothing after the await touches shared state: a disposal can outlive this hook's
		// timeout, and code after the await would then run during the next test.
		vi.restoreAllMocks();
		const failures = await cleanup.end();
		if (failures.length > 0) throw new AggregateError(failures, "test cleanup failed");
	});

	/**
	 * The test's credential store, holding one anthropic OAuth login, and its model registry.
	 * Each disposal is registered as its resource is created, so a setup that resumes after
	 * its test timed out closes what it opened instead of leaving it to the next test.
	 */
	async function setUp(): Promise<KeyResolutionContext> {
		const owner = cleanup;
		const tempDir = TempDir.createSync("@pi-key-resolution-retry-");
		await owner.add(() => tempDir.removeSync());
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		await owner.add(() => authStorage.close());
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		await authStorage.credentials.set("anthropic", [oauthLogin("acc-live")]);
		registerMockApi(MOCK_API_SOURCE);
		owner.release(() => unregisterCustomApis(MOCK_API_SOURCE));
		return { owner, tempDir, authStorage, modelRegistry };
	}

	/**
	 * The outage `mode` describes, on the test's own credential store. `refresh-unavailable`
	 * spies on the shared OAuth refresh module, which `afterEach` restores.
	 */
	function keyOutage(ctx: KeyResolutionContext, mode: OutageMode): KeyOutage {
		const { authStorage } = ctx;
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
						const identity = resolveCredentialIdentityKey("anthropic", oauthLogin("acc-live"))!;
						const lease = authStorage.sessions.restrict("anthropic", PROVIDER_SESSION_ID, [identity]);
						for (const account of authStorage.oauth.accounts("anthropic")) {
							await authStorage.credentials.disable(account.credentialId, "oauth refresh failed: invalid_grant");
						}
						lift = () => authStorage.sessions.unrestrict("anthropic", PROVIDER_SESSION_ID, lease);
					},
					end: async () => {
						await authStorage.credentials.set("anthropic", [oauthLogin("acc-live")]);
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
		return outage;
	}

	/**
	 * A session on the production key path (`ModelRegistry.turnResolver`, as
	 * sdk.ts wires it) whose model calls `probe` once and then answers. With
	 * `outage`, the key goes away while `probe` runs (`startOn: "probe"`) or
	 * before the prompt (`startOn: "prompt"`, the caller starts it), and comes
	 * back after `resolvesWhileDown` of the turn's key resolutions have failed.
	 */
	async function openSession(
		ctx: KeyResolutionContext,
		options: {
			maxRetries: number;
			sessionManager: SessionManager;
			model?: { provider: string; id: string };
			outage?: { keys: KeyOutage; startOn: "probe" | "prompt"; resolvesWhileDown: number };
		},
	) {
		const { owner, modelRegistry } = ctx;
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

		const retryStarts: AutoRetryStartEvent[] = [];
		const retryEnds: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
			if (event.type === "auto_retry_end") retryEnds.push(event);
		});
		await owner.add(() => session.dispose());
		return { session, mock, probeRuns, retryStarts, retryEnds };
	}

	for (const mode of OUTAGE_MODES) {
		it(`retries a turn whose key went away mid-turn and finishes once it is back (${mode})`, async () => {
			const ctx = await setUp();
			const { session, mock, probeRuns, retryStarts, retryEnds } = await openSession(ctx, {
				maxRetries: 5,
				sessionManager: SessionManager.inMemory(),
				outage: { keys: keyOutage(ctx, mode), startOn: "probe", resolvesWhileDown: 2 },
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
			const ctx = await setUp();
			const keys = keyOutage(ctx, mode);
			await keys.start();
			const { session, mock, probeRuns, retryStarts, retryEnds } = await openSession(ctx, {
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
			const ctx = await setUp();
			const keys = keyOutage(ctx, mode);
			const sessionDir = path.join(ctx.tempDir.path(), "sessions");
			const worker = await openSession(ctx, {
				maxRetries: 2,
				sessionManager: SessionManager.create(ctx.tempDir.path(), sessionDir),
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

			// The worker process exits normally on the failed turn. (The cleanup's later dispose
			// of the same session returns this call's promise.)
			const sessionFile = worker.session.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session file");
			await worker.session.dispose();

			// The key is readable again; a new process restores the session.
			await keys.end();
			const restarted = await openSession(ctx, {
				maxRetries: 2,
				sessionManager: await SessionManager.open(sessionFile),
			});
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
		const ctx = await setUp();
		const { authStorage } = ctx;
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
		const { session, mock, retryStarts } = await openSession(ctx, {
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

	/** Ways the user ends a provider's credentials; each must end a turn at once, never retry it. */
	const USER_REMOVALS: Record<string, (authStorage: AuthStorage) => Promise<void>> = {
		"removed the credential": authStorage => authStorage.credentials.remove("anthropic"),
		"logged out on the auth broker": async authStorage => {
			for (const account of authStorage.oauth.accounts("anthropic")) {
				// What `omp auth-broker logout` records.
				await authStorage.credentials.disable(account.credentialId, "logged out by user");
			}
		},
		"removed it after a failure disabled it": async authStorage => {
			for (const account of authStorage.oauth.accounts("anthropic")) {
				await authStorage.credentials.disable(
					account.credentialId,
					'oauth refresh failed: HTTP 400 {"error":"invalid_grant"}',
				);
			}
			await authStorage.credentials.remove("anthropic");
		},
	};

	for (const [removal, remove] of Object.entries(USER_REMOVALS)) {
		for (const pooled of [false, true]) {
			const where = pooled ? " in a session restricted to its account pool" : "";
			it(`ends the turn at once, and refuses the next prompt, when the user ${removal}${where}`, async () => {
				const ctx = await setUp();
				if (pooled) {
					// The pool holds the session's own login, so the turn starts and the user's removal ends it.
					const identity = resolveCredentialIdentityKey("anthropic", oauthLogin("acc-live"));
					ctx.authStorage.sessions.restrict("anthropic", PROVIDER_SESSION_ID, [identity!]);
				}
				const keys: KeyOutage = { start: () => remove(ctx.authStorage), end: async () => {} };
				const sessionDir = path.join(ctx.tempDir.path(), "sessions");
				const { session, mock, retryStarts } = await openSession(ctx, {
					maxRetries: 5,
					sessionManager: SessionManager.create(ctx.tempDir.path(), sessionDir),
					outage: { keys, startOn: "probe", resolvesWhileDown: Number.POSITIVE_INFINITY },
				});
				mockSchedulerWaitWithClock();

				await session.prompt("run the probe");
				await session.waitForIdle();

				const failed = lastAssistant(session);
				expect(failed.stopReason).toBe("error");
				// A pooled session names its pool; an unrestricted one names the provider.
				expect(failed.errorMessage).toContain(pooled ? "account pool" : "No API key for provider: anthropic");
				expect(AIError.is(failed.errorId, AIError.Flag.CredentialUnavailable)).toBe(false);
				expect(retryStarts).toEqual([]);
				expect(mock.calls).toHaveLength(1);
				await expect(session.prompt("again")).rejects.toThrow("No API key found for anthropic");
				await expect(session.restoreInterruptedTurn()).resolves.toBe(false);
			});
		}
	}

	for (const siblingDisabled of [false, true]) {
		it(`keeps implicit and side-session recovery in the configured pool with an ${siblingDisabled ? "disabled" : "active"} outside login`, async () => {
			const ctx = await setUp();
			const a = oauthLogin("acc-a");
			await ctx.authStorage.credentials.set("anthropic", [a, oauthLogin("acc-b")]);
			const [rowA, rowB] = ctx.authStorage.oauth.accounts("anthropic");
			const scope = new SessionAccountPoolScope(
				ctx.authStorage,
				{ anthropic: [resolveCredentialIdentityKey("anthropic", a)!] },
				PROVIDER_SESSION_ID,
			);
			ctx.owner.release(() => scope.release());
			const registry = scope.registry(ctx.modelRegistry);
			if (siblingDisabled)
				await ctx.authStorage.credentials.disable(rowB!.credentialId, "oauth refresh failed: invalid_grant");
			await ctx.authStorage.credentials.removeById("anthropic", rowA!.credentialId);
			const model = getBundledModel(ANTHROPIC_MODEL.provider, ANTHROPIC_MODEL.id)!;
			for (const sessionId of [undefined, "side-session"]) {
				expect(await registry.missingKeyMayRecover("anthropic", sessionId)).toBe(false);
				const error = await resolveApiKeyOnce(registry.turnResolver(model, sessionId)).catch(
					(failure: unknown) => failure,
				);
				expect(error).toBeInstanceOf(AIError.AccountPoolUnavailableError);
				expect(AIError.retriable(AIError.classify(error))).toBe(false);
			}
		});
	}

	for (const siblingDisabled of [false, true]) {
		for (const removal of ["remove", "removeById", "broker logout"] as const) {
			it(`does not retry or resume a removed pool account with an ${siblingDisabled ? "failure-disabled" : "active"} outside account (${removal})`, async () => {
				const ctx = await setUp();
				const { authStorage } = ctx;
				const a = oauthLogin("acc-a");
				await authStorage.credentials.set("anthropic", [a, oauthLogin("acc-b")]);
				const [rowA, rowB] = authStorage.oauth.accounts("anthropic");
				authStorage.sessions.restrict("anthropic", PROVIDER_SESSION_ID, [
					resolveCredentialIdentityKey("anthropic", a)!,
				]);
				if (siblingDisabled)
					await authStorage.credentials.disable(rowB!.credentialId, "oauth refresh failed: invalid_grant");
				const keys: KeyOutage = {
					start: async () => {
						if (removal === "remove") await authStorage.credentials.remove("anthropic");
						else if (removal === "removeById")
							await authStorage.credentials.removeById("anthropic", rowA!.credentialId);
						else await authStorage.credentials.disable(rowA!.credentialId, "logged out by user");
					},
					end: async () => {},
				};
				const { session, mock, retryStarts } = await openSession(ctx, {
					maxRetries: 2,
					sessionManager: SessionManager.inMemory(),
					outage: { keys, startOn: "probe", resolvesWhileDown: Number.POSITIVE_INFINITY },
				});
				mockSchedulerWaitWithClock();
				await session.prompt("run the probe");
				await session.waitForIdle();
				const failed = lastAssistant(session);
				expect(failed.stopReason).toBe("error");
				expect(AIError.is(failed.errorId, AIError.Flag.CredentialUnavailable)).toBe(false);
				expect(retryStarts).toEqual([]);
				expect(mock.calls).toHaveLength(1);
				await expect(session.prompt("again")).rejects.toThrow("No API key found for anthropic");
				await expect(session.restoreInterruptedTurn()).resolves.toBe(false);
			});
		}
	}

	for (const sharedWorkspace of [false, true]) {
		it(`recovers a failure-disabled account after removing ${sharedWorkspace ? "another member of the same workspace" : "the same email in a different organization"}`, async () => {
			const ctx = await setUp();
			const a = {
				...oauthLogin("a"),
				accountId: sharedWorkspace ? "workspace" : undefined,
				email: "a@example.com",
				orgId: sharedWorkspace ? "workspace" : "org-a",
			};
			const b = {
				...oauthLogin("b"),
				accountId: sharedWorkspace ? "workspace" : undefined,
				email: sharedWorkspace ? "b@example.com" : "a@example.com",
				orgId: sharedWorkspace ? "workspace" : "org-b",
			};
			await ctx.authStorage.credentials.set("anthropic", [a, b]);
			const [rowA, rowB] = ctx.authStorage.oauth.accounts("anthropic");
			const keys: KeyOutage = {
				start: async () => {
					await ctx.authStorage.credentials.disable(rowA!.credentialId, "oauth refresh failed: invalid_grant");
					await ctx.authStorage.credentials.removeById("anthropic", rowB!.credentialId);
				},
				end: () => ctx.authStorage.credentials.set("anthropic", [a]),
			};
			const { session, retryStarts } = await openSession(ctx, {
				maxRetries: 2,
				sessionManager: SessionManager.inMemory(),
				outage: { keys, startOn: "probe", resolvesWhileDown: 1 },
			});
			mockSchedulerWaitWithClock();
			await session.prompt("run the probe");
			await session.waitForIdle();
			expect(lastAssistant(session).stopReason).toBe("stop");
			expect(lastAssistant(session).content).toContainEqual({ type: "text", text: FINAL_ANSWER });
			expect(retryStarts.map(event => event.attempt)).toEqual([1]);
		});
	}

	it("keeps another account's failure recoverable when the user removes one account", async () => {
		const ctx = await setUp();
		const { authStorage, modelRegistry } = ctx;
		await authStorage.credentials.set("anthropic", [oauthLogin("acc-a"), oauthLogin("acc-b")]);
		const [a, b] = authStorage.oauth.accounts("anthropic");
		await authStorage.credentials.disable(
			a!.credentialId,
			'oauth refresh failed: HTTP 400 {"error":"invalid_grant"}',
		);
		await authStorage.credentials.removeById("anthropic", b!.credentialId);

		// A's failure is still A's: a new login of A brings the provider back.
		expect(await modelRegistry.missingKeyMayRecover("anthropic")).toBe(true);

		await authStorage.credentials.removeById("anthropic", a!.credentialId);

		expect(await modelRegistry.missingKeyMayRecover("anthropic")).toBe(false);
	});

	it("fails a pooled turn for good when a models.yml apiKey owns the provider", async () => {
		const ctx = await setUp();
		const model = getBundledModel(ANTHROPIC_MODEL.provider, ANTHROPIC_MODEL.id);
		if (!model) throw new Error("Expected bundled anthropic test model");
		ctx.authStorage.sessions.restrict("anthropic", PROVIDER_SESSION_ID, [
			resolveCredentialIdentityKey("anthropic", oauthLogin("acc-live"))!,
		]);
		ctx.authStorage.keys.setConfig("anthropic", "config-key");

		const error = await resolveApiKeyOnce(ctx.modelRegistry.turnResolver(model, PROVIDER_SESSION_ID)).catch(
			(failure: unknown) => failure,
		);

		expect(error).toBeInstanceOf(AIError.MissingApiKeyError);
		expect(AIError.retriable(AIError.classify(error))).toBe(false);
	});
});
