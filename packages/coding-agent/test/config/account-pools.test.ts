import { afterEach, describe, expect, it, vi } from "bun:test";
import { resolvedApiKeyBearer } from "@oh-my-pi/pi-ai/auth-retry";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { SessionAccountPoolScope, validateAgentAccountPools } from "@oh-my-pi/pi-coding-agent/config/account-pools";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgTaskAgentAccountPools } from "@oh-my-pi/pi-coding-agent/task/settings";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("task.agentAccountPools", () => {
	it("keeps an empty provider list as a deny-all pool and lets null clear an agent", () => {
		expect(validateAgentAccountPools(undefined)).toEqual({});
		expect(validateAgentAccountPools(null)).toEqual({});
		expect(
			validateAgentAccountPools({
				reviewer: { anthropic: ["email:a@example.com|org:org-a"], "openai-codex": [] },
				cleared: null,
			}),
		).toEqual({ reviewer: { anthropic: ["email:a@example.com|org:org-a"], "openai-codex": [] } });
	});

	it("rejects every malformed level instead of widening the agent to all accounts", () => {
		const malformed: [unknown, string][] = [
			["reviewer", "Invalid task.agentAccountPools:"],
			[[], "Invalid task.agentAccountPools:"],
			[{ reviewer: ["email:a@example.com"] }, "Invalid task.agentAccountPools.reviewer:"],
			[{ reviewer: { anthropic: "email:a@example.com" } }, "Invalid task.agentAccountPools.reviewer.anthropic:"],
			[{ reviewer: { anthropic: null } }, "Invalid task.agentAccountPools.reviewer.anthropic:"],
			[{ reviewer: { anthropic: [""] } }, "Invalid task.agentAccountPools.reviewer.anthropic:"],
			[{ reviewer: { anthropic: [" email:a@example.com"] } }, "Invalid task.agentAccountPools.reviewer.anthropic:"],
			[{ reviewer: { anthropic: [42] } }, "Invalid task.agentAccountPools.reviewer.anthropic:"],
		];
		for (const [value, message] of malformed) {
			expect(() => validateAgentAccountPools(value)).toThrow(message);
		}
	});

	it("fails settings load on a malformed pool", async () => {
		await expect(
			Settings.loadIsolated({
				inMemory: true,
				overrides: { "task.agentAccountPools": { reviewer: { anthropic: "email:a@example.com" } } },
			}),
		).rejects.toThrow("Invalid task.agentAccountPools.reviewer.anthropic:");
	});

	it("keeps an agent named __proto__ restricted across settings layers", async () => {
		// YAML parses `__proto__` as an own key; layer merging and validation must keep it one.
		const tempDir = TempDir.createSync("@pi-account-pools-");
		try {
			const overlay = tempDir.join("overlay.yml");
			await Bun.write(overlay, "task:\n  agentAccountPools:\n    __proto__:\n      anthropic: []\n");
			const settings = await Settings.loadIsolated({
				inMemory: true,
				configFiles: [overlay],
				overrides: { "task.agentAccountPools": { reviewer: { anthropic: [] } } },
			});
			// Dispatch and revival read the pools through the validator.
			const pools = validateAgentAccountPools(cfgTaskAgentAccountPools.get(settings));
			expect(Object.getOwnPropertyDescriptor(pools, "__proto__")?.value).toEqual({ anthropic: [] });
			expect(pools.reviewer).toEqual({ anthropic: [] });
		} finally {
			tempDir.removeSync();
		}
	});
});

describe("SessionAccountPoolScope resolver reset timing", () => {
	const provider = "account-pool-reset-test";
	const sourceId = "account-pool-reset-test";

	afterEach(() => {
		vi.restoreAllMocks();
		unregisterOAuthProviders(sourceId);
	});

	it.each(["model", "model with session", "provider options"] as const)(
		"%s rotates within the pool and restores a blocked account at its configured local reset",
		async form => {
			const now = Date.parse("2099-09-01T00:00:00Z");
			const clock = vi.spyOn(Date, "now").mockReturnValue(now);
			registerOAuthProvider({
				id: provider,
				name: "Account Pool Reset Test",
				sourceId,
				async login() {
					throw new Error("test credentials must not log in");
				},
				async refreshToken() {
					throw new Error("test credentials must not refresh");
				},
				getApiKey: credentials => credentials.access,
			});
			const tempDir = TempDir.createSync("@pi-account-pool-reset-");
			const authStorage = await AuthStorage.create(":memory:");
			const scope = new SessionAccountPoolScope(
				authStorage,
				{ [provider]: ["email:limited@example.com", "email:healthy@example.com"] },
				"primary-session",
			);
			try {
				await authStorage.credentials.set(
					provider,
					["limited", "healthy", "excluded"].map(account => ({
						type: "oauth" as const,
						access: `${account}-access`,
						refresh: `${account}-refresh`,
						expires: now + 24 * 60 * 60_000,
						email: `${account}@example.com`,
					})),
				);
				const limited = authStorage.credentials
					.list(provider)
					.find(row => row.credential.type === "oauth" && row.credential.access === "limited-access");
				if (!limited) throw new Error("expected limited test account");
				const registry = scope.registry(new ModelRegistry(authStorage, tempDir.join("models.yml")));
				const model = {
					provider,
					id: "pool-model",
					baseUrl: "https://account-pool-reset.example/v1",
					retryResetTimezoneOffset: "+08:00",
				};
				const sessionId = form === "model" ? "primary-session" : "child-session";
				const resolver =
					form === "model"
						? registry.resolver(model)
						: form === "model with session"
							? registry.resolver(model, sessionId)
							: registry.resolver(provider, {
									sessionId,
									baseUrl: model.baseUrl,
									modelId: model.id,
									retryResetTimezoneOffset: model.retryResetTimezoneOffset,
								});
				authStorage.sessions.pin(provider, sessionId, limited.id);
				expect(resolvedApiKeyBearer(await resolver({ lastChance: false, error: undefined }))).toBe(
					"limited-access",
				);

				const rotated = await resolver({
					lastChance: true,
					error: Object.assign(
						new Error("429 Usage limit reached. Your limit will reset at 2099-09-01 08:01:00"),
						{
							status: 429,
						},
					),
					previousKey: "limited-access",
				});
				expect(resolvedApiKeyBearer(rotated)).toBe("healthy-access");
				expect(authStorage.blocks.list([limited.id]).map(block => block.blockedUntilMs)).toEqual([now + 60_000]);

				// Prefer the failed account again: selection must skip it before reset and admit it exactly at reset.
				clock.mockReturnValue(now + 59_999);
				authStorage.sessions.pin(provider, sessionId, limited.id);
				expect(resolvedApiKeyBearer(await resolver({ lastChance: false, error: undefined }))).toBe(
					"healthy-access",
				);
				clock.mockReturnValue(now + 60_000);
				authStorage.sessions.pin(provider, sessionId, limited.id);
				expect(resolvedApiKeyBearer(await resolver({ lastChance: false, error: undefined }))).toBe(
					"limited-access",
				);
			} finally {
				scope.release();
				authStorage.close();
				tempDir.removeSync();
			}
		},
	);
});
