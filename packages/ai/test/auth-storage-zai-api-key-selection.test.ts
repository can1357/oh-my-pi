import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

const HOUR_MS = 60 * 60 * 1000;

describe("AuthStorage Z.AI API-key usage ranking", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	const usageByKey = new Map<string, UsageReport>();

	const usageProvider: UsageProvider = {
		id: "zai",
		async fetchUsage(params) {
			const apiKey = params.credential.apiKey;
			if (!apiKey) return null;
			return usageByKey.get(apiKey) ?? null;
		},
		supports: params => params.provider === "zai" && params.credential.type === "api_key",
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-zai-selection-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "zai" ? usageProvider : undefined),
			async configValueResolver(config) {
				if (config === "ZAI_EXHAUSTED_REF") return "zai-exhausted";
				if (config === "ZAI_HEALTHY_REF") return "zai-healthy";
				return config;
			},
		});
		usageByKey.clear();
	});

	afterEach(async () => {
		authStorage?.close();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir.length > 0) {
			await removeWithRetries(tempDir);
		}
		tempDir = "";
	});

	test("skips an exhausted login API key when a Z.AI sibling has request quota", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("zai", [
			{ type: "api_key", key: "zai-exhausted", source: "login" },
			{ type: "api_key", key: "zai-healthy", source: "login" },
		]);
		usageByKey.set("zai-exhausted", {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:requests:5h",
					label: "ZAI Request Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + HOUR_MS },
					amount: {
						unit: "requests",
						used: 100,
						limit: 100,
						remaining: 0,
						usedFraction: 1,
						remainingFraction: 0,
					},
					status: "exhausted",
				},
			],
		});
		usageByKey.set("zai-healthy", {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:requests:5h",
					label: "ZAI Request Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + 2 * HOUR_MS },
					amount: {
						unit: "requests",
						used: 20,
						limit: 100,
						remaining: 80,
						usedFraction: 0.2,
						remainingFraction: 0.8,
					},
					status: "ok",
				},
			],
		});

		expect(await authStorage.getApiKey("zai")).toBe("zai-healthy");
	});

	test("resolves stored API-key references before probing Z.AI usage", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("zai", [
			{ type: "api_key", key: "ZAI_EXHAUSTED_REF", source: "login" },
			{ type: "api_key", key: "ZAI_HEALTHY_REF", source: "login" },
		]);
		usageByKey.set("zai-exhausted", {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:requests:5h",
					label: "ZAI Request Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + HOUR_MS },
					amount: {
						unit: "requests",
						used: 100,
						limit: 100,
						remaining: 0,
						usedFraction: 1,
						remainingFraction: 0,
					},
					status: "exhausted",
				},
			],
		});
		usageByKey.set("zai-healthy", {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:requests:5h",
					label: "ZAI Request Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + 2 * HOUR_MS },
					amount: {
						unit: "requests",
						used: 20,
						limit: 100,
						remaining: 80,
						usedFraction: 0.2,
						remainingFraction: 0.8,
					},
					status: "ok",
				},
			],
		});
		expect(await authStorage.getApiKey("zai")).toBe("zai-healthy");
	});

	test("markUsageLimitReached inspects usage report for API keys to determine accurate reset time", async () => {
		if (!authStorage || !store?.getCredentialBlock) throw new Error("test setup failed");

		await authStorage.set("zai", [
			{ type: "api_key", key: "zai-acc1", source: "login" },
			{ type: "api_key", key: "zai-acc2", source: "login" },
		]);
		const earlyReset = Date.now() + HOUR_MS;
		const futureReset = Date.now() + 24 * HOUR_MS;
		usageByKey.set("zai-acc1", {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:requests:5h",
					label: "ZAI Request Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: earlyReset },
					amount: {
						unit: "requests",
						used: 100,
						limit: 100,
						remaining: 0,
						usedFraction: 1,
						remainingFraction: 0,
					},
					status: "exhausted",
				},
				{
					id: "zai:credits:1w",
					label: "ZAI Weekly Credit Quota",
					scope: { provider: "zai", windowId: "1w", shared: true },
					window: { id: "1w", label: "Weekly", durationMs: 7 * 24 * HOUR_MS, resetsAt: futureReset },
					amount: {
						unit: "credits",
						used: 140000,
						limit: 140000,
						remaining: 0,
						usedFraction: 1,
						remainingFraction: 0,
					},
					status: "exhausted",
				},
			],
		});

		const outcome = await authStorage.markUsageLimitReached("zai", "session-xyz", {
			apiKey: "zai-acc1",
		});

		const blockedRow = store
			.listAuthCredentials("zai")
			.find(entry => entry.credential.type === "api_key" && entry.credential.key === "zai-acc1");
		if (!blockedRow) throw new Error("blocked credential missing");
		expect(outcome.switched).toBe(true);
		expect(store.getCredentialBlock(blockedRow.id, "zai:api_key", "")).toBe(futureReset);
		expect(await authStorage.getApiKey("zai", "session-xyz")).toBe("zai-acc2");
	});

	test("ignores exhausted Z.AI feature quotas for model request routing", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("zai", [
			{ type: "api_key", key: "zai-feature-exhausted", source: "login" },
			{ type: "api_key", key: "zai-general-busier", source: "login" },
		]);
		usageByKey.set("zai-feature-exhausted", {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:features:zread:5h",
					label: "ZAI Zread Quota",
					scope: { provider: "zai", windowId: "5h", tier: "zread", shared: false },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + HOUR_MS },
					amount: {
						unit: "requests",
						used: 100,
						limit: 100,
						remaining: 0,
						usedFraction: 1,
						remainingFraction: 0,
					},
					status: "exhausted",
				},
				{
					id: "zai:requests:5h",
					label: "ZAI Request Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + 2 * HOUR_MS },
					amount: {
						unit: "requests",
						used: 10,
						limit: 100,
						remaining: 90,
						usedFraction: 0.1,
						remainingFraction: 0.9,
					},
					status: "ok",
				},
			],
		});
		usageByKey.set("zai-general-busier", {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:requests:5h",
					label: "ZAI Request Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + 2 * HOUR_MS },
					amount: {
						unit: "requests",
						used: 80,
						limit: 100,
						remaining: 20,
						usedFraction: 0.8,
						remainingFraction: 0.2,
					},
					status: "ok",
				},
			],
		});

		expect(await authStorage.getApiKey("zai")).toBe("zai-feature-exhausted");
	});
});
