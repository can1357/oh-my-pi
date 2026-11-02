import { afterEach, expect, test, vi } from "bun:test";
import { AuthStorage, REMOTE_REFRESH_SENTINEL } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, RemoteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-broker";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";

afterEach(() => {
	vi.restoreAllMocks();
});

test("excluded providers stay out of usage and credential health", async () => {
	const brokerClient = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused" });
	const now = Date.now();
	const oauth = (email: string) => ({
		type: "oauth" as const,
		access: `access-${email}`,
		refresh: REMOTE_REFRESH_SENTINEL,
		expires: now + 120_000,
		email,
	});
	const reports: UsageReport[] = [
		{ provider: "anthropic", fetchedAt: now, limits: [], metadata: { email: "friend@example.com" } },
		{ provider: "devin", fetchedAt: now, limits: [], metadata: { email: "owner@example.com" } },
	];
	vi.spyOn(brokerClient, "fetchUsage").mockResolvedValue({ generatedAt: now, reports });
	const store = new RemoteAuthCredentialStore({
		client: brokerClient,
		streamSnapshots: false,
		initialSnapshot: {
			generation: 1,
			generatedAt: now,
			serverNowMs: now,
			refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
			credentials: [
				{
					id: 1,
					provider: "anthropic",
					credential: oauth("friend@example.com"),
					identityKey: "email:friend@example.com",
					rotatesInMs: null,
				},
				{
					id: 2,
					provider: "devin",
					credential: oauth("owner@example.com"),
					identityKey: "email:owner@example.com",
					rotatesInMs: null,
				},
				{
					id: 3,
					provider: "openrouter",
					credential: { type: "api_key", key: "owner-key" },
					identityKey: null,
					rotatesInMs: null,
				},
			],
		},
	});
	const storage = new AuthStorage(store, { usageProviderResolver: () => undefined });
	await storage.credentials.reload();
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: [],
		storage,
		resolveModel: () => undefined,
		excludeProviders: new Set(["devin", "openrouter"]),
		version: "test",
	});

	try {
		const usage = (await (await fetch(`${handle.url}/v1/usage`)).json()) as { reports: UsageReport[] };
		expect(usage.reports.map(report => report.metadata?.email)).toEqual(["friend@example.com"]);

		const check = (await (await fetch(`${handle.url}/v1/credentials/check`)).json()) as {
			credentials: { id: number; provider: string }[];
		};
		expect(check.credentials.map(row => [row.id, row.provider])).toEqual([[1, "anthropic"]]);
	} finally {
		await handle.close();
		storage.close();
	}
});
