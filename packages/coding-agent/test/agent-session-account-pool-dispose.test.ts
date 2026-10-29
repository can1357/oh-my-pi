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
