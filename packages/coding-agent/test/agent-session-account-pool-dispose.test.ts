import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { SessionAccountPoolScope } from "@oh-my-pi/pi-coding-agent/config/account-pools";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { credentialPinHash } from "@oh-my-pi/pi-coding-agent/session/credential-pin";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const PROVIDER_SESSION_ID = "pooled-provider-session";

describe("AgentSession account pools after a dispose deadline", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-pool-dispose-");
		authStorage = createInMemoryAuthStorage();
		await authStorage.credentials.set(
			"anthropic",
			["a", "b", "c"].map(suffix => ({
				type: "oauth" as const,
				access: `access-${suffix}`,
				refresh: `refresh-${suffix}`,
				expires: Date.now() + 60 * 60_000,
				accountId: `account-${suffix}`,
				email: `${suffix}@example.com`,
				orgId: `org-${suffix}`,
			})),
		);
		// An unrestricted session resolves the runtime key; a pooled one never does.
		authStorage.keys.setRuntime("anthropic", "runtime-key");
	});

	afterEach(async () => {
		for (const session of sessions.reverse()) await session.dispose();
		sessions = [];
		authStorage.close();
		AsyncJobManager.resetForTests();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	/**
	 * A session pooled to account c on {@link PROVIDER_SESSION_ID}. With
	 * `stallUntil`, its `message_end` handler holds dispose past its deadline
	 * until that promise resolves; `released` resolves once the session has
	 * released its pool scope.
	 */
	async function createPooledSession(
		stallUntil?: Promise<void>,
	): Promise<{ session: AgentSession; released: Promise<void> }> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const accountPoolScope = new SessionAccountPoolScope(
			authStorage,
			{ anthropic: ["email:c@example.com|org:org-c"] },
			PROVIDER_SESSION_ID,
		);
		const modelRegistry = accountPoolScope.registry(
			new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		);
		const reached = Promise.withResolvers<void>();
		let extensionRunner: ExtensionRunner | undefined;
		if (stallUntil) {
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.on("message_end", async () => {
						reached.resolve();
						await stallUntil;
					});
				},
				tempDir.path(),
				new EventBus(),
				runtime,
				"stalled-message-end",
			);
			extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		}
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			agentId: "Main",
			extensionRunner,
			providerSessionId: PROVIDER_SESSION_ID,
			accountPoolScope,
		});
		sessions.push(session);

		const released = Promise.withResolvers<void>();
		const release = accountPoolScope.release.bind(accountPoolScope);
		vi.spyOn(accountPoolScope, "release").mockImplementation(() => {
			release();
			released.resolve();
		});
		if (stallUntil) {
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
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
				stopReason: "stop",
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message });
			await reached.promise;
		}
		return { session, released: released.promise };
	}

	it("keeps an unconfigured session pin soft and persists its cache-affinity account", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		authStorage.keys.removeRuntime("anthropic");
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
		sessions.push(session);
		const rows = authStorage.credentials.list("anthropic");
		const accountA = rows.find(row => row.credential.type === "oauth" && row.credential.accountId === "account-a");
		const accountC = rows.find(row => row.credential.type === "oauth" && row.credential.accountId === "account-c");
		if (!accountA || accountA.credential.type !== "oauth" || !accountC || accountC.credential.type !== "oauth") {
			throw new Error("expected OAuth fixtures");
		}

		expect(session.pinCurrentProviderOAuthAccount(accountC.id)).toBe(true);
		expect(session.isCurrentProviderOAuthAccountPermitted(accountA.id)).toBe(true);
		expect(authStorage.sessions.permits("anthropic", session.sessionId, accountA.id)).toBe(true);
		expect(authStorage.sessions.permits("anthropic", session.sessionId, accountC.id)).toBe(true);
		expect(await authStorage.keys.get("anthropic", session.sessionId)).toBe("access-c");
		expect(sessionManager.getCredentialPins().get("anthropic")).toMatchObject({
			hash: credentialPinHash("anthropic", accountC.credential),
			hard: false,
		});

		await authStorage.credentials.disable(accountC.id, "test soft pin fallback");
		const fallbackKey = await authStorage.keys.get("anthropic", session.sessionId);
		if (!fallbackKey) throw new Error("expected OAuth fallback");
		expect(["access-a", "access-b"]).toContain(fallbackKey);
	});

	it("keeps configured hard pins inside the pool and drops them for a new session", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const providerSessionId = sessionManager.getSessionId();
		const pool = {
			anthropic: ["email:a@example.com|org:org-a", "email:b@example.com|org:org-b"],
		};
		const scope = new SessionAccountPoolScope(authStorage, pool, providerSessionId);
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: scope.registry(new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"))),
			providerSessionId,
			accountPoolScope: scope,
		});
		sessionManager.appendMessage({ role: "user", content: "keep this pinned session", timestamp: Date.now() });
		sessions.push(session);
		const rows = authStorage.credentials.list("anthropic");
		const accountA = rows.find(row => row.credential.type === "oauth" && row.credential.accountId === "account-a");
		const accountB = rows.find(row => row.credential.type === "oauth" && row.credential.accountId === "account-b");
		const accountC = rows.find(row => row.credential.type === "oauth" && row.credential.accountId === "account-c");
		if (!accountA || !accountB || !accountC) throw new Error("expected OAuth fixtures");

		expect(session.pinCurrentProviderOAuthAccount(accountC.id)).toBe(false);
		expect(session.isCurrentProviderOAuthAccountPermitted(accountC.id)).toBe(false);
		expect(session.pinCurrentProviderOAuthAccount(accountB.id)).toBe(true);
		expect(authStorage.sessions.permits("anthropic", session.sessionId, accountA.id)).toBe(false);
		expect(authStorage.sessions.permits("anthropic", session.sessionId, accountB.id)).toBe(true);
		expect(authStorage.sessions.permits("anthropic", session.sessionId, accountC.id)).toBe(false);
		expect(sessionManager.getCredentialPins().get("anthropic")?.hard).toBe(true);
		expect(await session.newSession()).toBe(true);
		expect(session.isCurrentProviderOAuthAccountPermitted(accountA.id)).toBe(true);
		expect(session.isCurrentProviderOAuthAccountPermitted(accountB.id)).toBe(true);
		expect(session.isCurrentProviderOAuthAccountPermitted(accountC.id)).toBe(false);
	});

	it("restores only explicit hard pins when configured-pool sessions resume", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const pool = {
			anthropic: ["email:a@example.com|org:org-a", "email:b@example.com|org:org-b"],
		};
		const rows = authStorage.credentials.list("anthropic");
		const accountA = rows.find(row => row.credential.type === "oauth" && row.credential.accountId === "account-a");
		const accountB = rows.find(row => row.credential.type === "oauth" && row.credential.accountId === "account-b");
		const accountC = rows.find(row => row.credential.type === "oauth" && row.credential.accountId === "account-c");
		if (
			!accountA ||
			accountA.credential.type !== "oauth" ||
			!accountB ||
			accountB.credential.type !== "oauth" ||
			!accountC
		) {
			throw new Error("expected OAuth fixtures");
		}

		const hardManager = SessionManager.create(tempDir.path(), tempDir.path());
		hardManager.appendMessage({ role: "user", content: "persist hard pin", timestamp: Date.now() });
		const hardProviderSessionId = hardManager.getSessionId();
		const hardScope = new SessionAccountPoolScope(authStorage, pool, hardProviderSessionId);
		const hardSession = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [] } }),
			sessionManager: hardManager,
			settings: Settings.isolated(),
			modelRegistry: hardScope.registry(new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"))),
			providerSessionId: hardProviderSessionId,
			accountPoolScope: hardScope,
		});
		sessions.push(hardSession);
		expect(hardSession.pinCurrentProviderOAuthAccount(accountB.id)).toBe(true);
		expect(hardManager.getCredentialPins().get("anthropic")?.hard).toBe(true);
		await hardManager.ensureOnDisk();
		const hardFile = hardManager.getSessionFile();
		if (!hardFile) throw new Error("expected persisted hard-pin session");
		hardScope.release();

		const resumedHardManager = await SessionManager.open(hardFile);
		expect(resumedHardManager.getCredentialPins().get("anthropic")?.hard).toBe(true);
		const resumedHardId = resumedHardManager.getSessionId();
		const resumedHardScope = new SessionAccountPoolScope(authStorage, pool, resumedHardId);
		const resumedHard = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [] } }),
			sessionManager: resumedHardManager,
			settings: Settings.isolated(),
			modelRegistry: resumedHardScope.registry(
				new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			),
			providerSessionId: resumedHardId,
			accountPoolScope: resumedHardScope,
		});
		sessions.push(resumedHard);
		expect(authStorage.sessions.permits("anthropic", resumedHard.sessionId, accountA.id)).toBe(false);
		expect(authStorage.sessions.permits("anthropic", resumedHard.sessionId, accountB.id)).toBe(true);
		expect(authStorage.sessions.permits("anthropic", resumedHard.sessionId, accountC.id)).toBe(false);

		const softManager = SessionManager.create(tempDir.path(), tempDir.path());
		softManager.appendMessage({ role: "user", content: "persist soft affinity", timestamp: Date.now() });
		const softHash = credentialPinHash("anthropic", accountA.credential);
		if (!softHash) throw new Error("expected soft pin hash");
		softManager.appendCredentialPin("anthropic", softHash);
		await softManager.ensureOnDisk();
		const softFile = softManager.getSessionFile();
		if (!softFile) throw new Error("expected persisted soft-pin session");
		const resumedSoftManager = await SessionManager.open(softFile);
		expect(resumedSoftManager.getCredentialPins().get("anthropic")?.hard).toBe(false);
		const resumedSoftId = resumedSoftManager.getSessionId();
		const resumedSoftScope = new SessionAccountPoolScope(authStorage, pool, resumedSoftId);
		const resumedSoft = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [] } }),
			sessionManager: resumedSoftManager,
			settings: Settings.isolated(),
			modelRegistry: resumedSoftScope.registry(
				new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			),
			providerSessionId: resumedSoftId,
			accountPoolScope: resumedSoftScope,
		});
		sessions.push(resumedSoft);
		expect(authStorage.sessions.permits("anthropic", resumedSoft.sessionId, accountA.id)).toBe(true);
		expect(authStorage.sessions.permits("anthropic", resumedSoft.sessionId, accountB.id)).toBe(true);
		expect(authStorage.sessions.permits("anthropic", resumedSoft.sessionId, accountC.id)).toBe(false);
	});

	it("lifts the pool once a run that outlived the deadline settles", async () => {
		const release = Promise.withResolvers<void>();
		const { session, released } = await createPooledSession(release.promise);
		await session.dispose({ drainTimeoutMs: 20 });
		// The unsettled run may still resolve keys, so the pool stays for now.
		expect(await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID)).toBe("access-c");

		release.resolve();
		await released;
		expect(await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID)).toBe("runtime-key");
	});

	it("keeps the pool a revival installed on the same provider session id", async () => {
		const release = Promise.withResolvers<void>();
		const { session, released } = await createPooledSession(release.promise);
		await session.dispose({ drainTimeoutMs: 20 });

		const { session: revived } = await createPooledSession();
		release.resolve();
		await released;
		// The late release holds the timed-out session's lease, not the revival's.
		expect(await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID)).toBe("access-c");

		await revived.dispose();
		expect(await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID)).toBe("runtime-key");
	});
});
