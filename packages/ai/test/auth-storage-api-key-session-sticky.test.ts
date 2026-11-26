import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { CredentialRankingStrategy, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { opencodeGoRankingStrategy } from "@oh-my-pi/pi-ai/usage/opencode-go";
import { removeWithRetries } from "../../utils/src/temp";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const WARM_MS = 30 * MINUTE_MS;

function rollingReport(usedFraction: number): UsageReport {
	return {
		provider: "opencode-go",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "rolling-5h",
				label: "5 Hour limit",
				scope: { provider: "opencode-go", windowId: "5h", shared: true },
				window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + HOUR_MS },
				amount: {
					unit: "percent",
					used: usedFraction * 100,
					usedFraction,
					remainingFraction: 1 - usedFraction,
				},
				status: usedFraction >= 1 ? "exhausted" : "ok",
			},
		],
	};
}

describe("AuthStorage OpenCode Go API-key session stickiness", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	const usedByKey = new Map<string, number>();
	let opencodeGoStrategy: CredentialRankingStrategy = opencodeGoRankingStrategy;

	const usageProvider: UsageProvider = {
		id: "opencode-go",
		async fetchUsage(params) {
			const apiKey = params.credential.apiKey;
			const usedFraction = apiKey === undefined ? undefined : usedByKey.get(apiKey);
			return usedFraction === undefined ? null : rollingReport(usedFraction);
		},
		supports: params => params.provider === "opencode-go" && params.credential.type === "api_key",
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-opencode-go-sticky-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		opencodeGoStrategy = opencodeGoRankingStrategy;
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "opencode-go" ? usageProvider : undefined),
			rankingStrategyResolver: provider => (provider === "opencode-go" ? opencodeGoStrategy : undefined),
		});
		usedByKey.clear();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		authStorage?.close();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir.length > 0) {
			await removeWithRetries(tempDir);
		}
		tempDir = "";
	});

	test("keeps a session on its pinned key after usage ranking flips, while a new session ranks", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const start = Date.now();

		await authStorage.credentials.set("opencode-go", [
			{ type: "api_key", key: "oc-key-a", source: "login" },
			{ type: "api_key", key: "oc-key-b", source: "login" },
		]);
		usedByKey.set("oc-key-a", 0.1);
		usedByKey.set("oc-key-b", 0.5);
		expect(await authStorage.keys.get("opencode-go", "session-1")).toBe("oc-key-a");

		// Key A becomes the busier account. An hour later the usage cache has expired, so
		// a fresh ranking would now pick key B.
		usedByKey.set("oc-key-a", 0.9);
		usedByKey.set("oc-key-b", 0.05);
		vi.spyOn(Date, "now").mockReturnValue(start + HOUR_MS);

		expect(await authStorage.keys.get("opencode-go", "session-1")).toBe("oc-key-a");
		expect(await authStorage.keys.get("opencode-go", "session-2")).toBe("oc-key-b");
	});

	test("moves a session off its pinned key when that key reaches its usage limit", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.credentials.set("opencode-go", [
			{ type: "api_key", key: "oc-key-a", source: "login" },
			{ type: "api_key", key: "oc-key-b", source: "login" },
		]);
		usedByKey.set("oc-key-a", 0.1);
		usedByKey.set("oc-key-b", 0.5);
		expect(await authStorage.keys.get("opencode-go", "session-1")).toBe("oc-key-a");

		usedByKey.set("oc-key-a", 1);
		const outcome = await authStorage.limits.markReached("opencode-go", "session-1", { apiKey: "oc-key-a" });

		expect(outcome.switched).toBe(true);
		expect(await authStorage.keys.get("opencode-go", "session-1")).toBe("oc-key-b");
	});

	test("a provider without a ranking strategy keeps its hashed key order once a block expires", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const start = Date.now();

		await authStorage.credentials.set("deepseek", [
			{ type: "api_key", key: "ds-key-a", source: "login" },
			{ type: "api_key", key: "ds-key-b", source: "login" },
			{ type: "api_key", key: "ds-key-c", source: "login" },
		]);
		const first = await authStorage.keys.get("deepseek", "session-1");
		if (!first) throw new Error("no key selected");

		// A 429 blocks the key the session is on, so it moves to the next key in its hashed order.
		await authStorage.limits.markReached("deepseek", "session-1", { apiKey: first, retryAfterMs: 10 * MINUTE_MS });
		expect(await authStorage.keys.get("deepseek", "session-1")).not.toBe(first);

		// Once the block expires the session is back on its first key: no pin holds it on the failover key.
		vi.spyOn(Date, "now").mockReturnValue(start + HOUR_MS);
		expect(await authStorage.keys.get("deepseek", "session-1")).toBe(first);
	});

	test("re-ranks a session whose pin has sat idle past the provider's warm window", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const start = Date.now();
		opencodeGoStrategy = { ...opencodeGoRankingStrategy, stickyWarmMs: WARM_MS };

		await authStorage.credentials.set("opencode-go", [
			{ type: "api_key", key: "oc-key-a", source: "login" },
			{ type: "api_key", key: "oc-key-b", source: "login" },
		]);
		usedByKey.set("oc-key-a", 0.1);
		usedByKey.set("oc-key-b", 0.5);
		expect(await authStorage.keys.get("opencode-go", "session-1")).toBe("oc-key-a");

		usedByKey.set("oc-key-a", 0.9);
		usedByKey.set("oc-key-b", 0.05);
		const clock = vi.spyOn(Date, "now").mockReturnValue(start + 10 * MINUTE_MS);
		// Inside the warm window the pin still holds.
		expect(await authStorage.keys.get("opencode-go", "session-1")).toBe("oc-key-a");

		// Idle past the window, a fresh usage ranking takes the session to key B.
		clock.mockReturnValue(start + 41 * MINUTE_MS);
		expect(await authStorage.keys.get("opencode-go", "session-1")).toBe("oc-key-b");
	});
});
