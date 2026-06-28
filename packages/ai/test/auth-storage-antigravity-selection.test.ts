/**
 * Antigravity OAuth ranking smoke test. Proves the
 * `antigravityRankingStrategy` is wired into `DEFAULT_RANKING_STRATEGIES`
 * (issue #2198): a credential whose usage report shows an exhausted
 * counter must be skipped in favour of a healthy sibling on the next
 * `getApiKey` call.
 *
 * Without the registration `getApiKey` would round-robin between
 * credentials and could pin a session to the exhausted account.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@pk-nerdsaver-ai/pi-ai/auth-storage";
import * as oauthUtils from "@pk-nerdsaver-ai/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@pk-nerdsaver-ai/pi-ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@pk-nerdsaver-ai/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

const HOUR_MS = 60 * 60 * 1000;

type AntigravityWindowSpec = {
	counter: "google" | "anthropic" | "openai" | "default";
	usedFraction: number;
	resetInMs: number;
};

function createAntigravityLimit(spec: AntigravityWindowSpec, projectId: string): UsageLimit {
	const used = Math.min(Math.max(spec.usedFraction, 0), 1);
	return {
		id: `google-antigravity:${spec.counter}:default:WINDOW_DAILY`,
		label: `Usage (${spec.counter})`,
		scope: {
			provider: "google-antigravity",
			projectId,
			windowId: "WINDOW_DAILY",
		},
		window: {
			id: "WINDOW_DAILY",
			label: "Default",
			resetsAt: Date.now() + spec.resetInMs,
		},
		amount: {
			unit: "percent",
			used: used * 100,
			limit: 100,
			remaining: (1 - used) * 100,
			usedFraction: used,
			remainingFraction: 1 - used,
		},
		status: used >= 1 ? "exhausted" : used >= 0.9 ? "warning" : "ok",
	};
}

function createAntigravityReport(args: {
	projectId: string;
	accountId: string;
	windows: AntigravityWindowSpec[];
}): UsageReport {
	// fetchAntigravityUsage sorts ascending by remainingFraction; mirror
	// that here so the strategy sees the same shape it would in production.
	const limits = args.windows
		.map(w => createAntigravityLimit(w, args.projectId))
		.sort((a, b) => (a.amount.remainingFraction ?? 1) - (b.amount.remainingFraction ?? 1));
	return {
		provider: "google-antigravity",
		fetchedAt: Date.now(),
		limits,
		metadata: { accountId: args.accountId, projectId: args.projectId },
	};
}

function createCredential(accountId: string, projectId: string, email: string): OAuthCredentials {
	return {
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + HOUR_MS,
		accountId,
		projectId,
		email,
	};
}

describe("AuthStorage google-antigravity oauth ranking", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	const usageByAccount = new Map<string, UsageReport>();

	const usageProvider: UsageProvider = {
		id: "google-antigravity",
		async fetchUsage(params) {
			const accountId = params.credential.accountId;
			if (!accountId) return null;
			return usageByAccount.get(accountId) ?? null;
		},
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-antigravity-selection-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "google-antigravity" ? usageProvider : undefined),
		});
		usageByAccount.clear();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials["google-antigravity"] as OAuthCredentials | undefined;
			if (!credential?.accountId) return null;
			return {
				apiKey: `api-${credential.accountId}`,
				newCredentials: credential,
			};
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("blocks exhausted Antigravity Gemini counter without blocking healthy Claude counter", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("google-antigravity", [
			{
				type: "oauth",
				...createCredential("acct-gemini-exhausted", "proj-gemini-exhausted", "exhausted@example.com"),
			},
			{ type: "oauth", ...createCredential("acct-gemini-healthy", "proj-gemini-healthy", "healthy@example.com") },
		]);

		usageByAccount.set(
			"acct-gemini-exhausted",
			createAntigravityReport({
				accountId: "acct-gemini-exhausted",
				projectId: "proj-gemini-exhausted",
				windows: [
					{ counter: "google", usedFraction: 1, resetInMs: 12 * HOUR_MS },
					{ counter: "anthropic", usedFraction: 0.05, resetInMs: 12 * HOUR_MS },
				],
			}),
		);
		usageByAccount.set(
			"acct-gemini-healthy",
			createAntigravityReport({
				accountId: "acct-gemini-healthy",
				projectId: "proj-gemini-healthy",
				windows: [
					{ counter: "google", usedFraction: 0.3, resetInMs: 20 * HOUR_MS },
					{ counter: "anthropic", usedFraction: 0.7, resetInMs: 20 * HOUR_MS },
				],
			}),
		);

		const geminiKey = await authStorage.getApiKey("google-antigravity", "session-antigravity-gemini", {
			modelId: "gemini-3-flash",
		});
		expect(geminiKey).toBe("api-acct-gemini-healthy");

		const counts = new Map<string, number>();
		for (let i = 0; i < 80; i += 1) {
			const apiKey = await authStorage.getApiKey("google-antigravity", `session-antigravity-claude-${i}`, {
				modelId: "claude-sonnet-4-5",
			});
			if (!apiKey) continue;
			counts.set(apiKey, (counts.get(apiKey) ?? 0) + 1);
		}

		expect(counts.get("api-acct-gemini-exhausted") ?? 0).toBeGreaterThan(counts.get("api-acct-gemini-healthy") ?? 0);
	});

	test("ranks by bottleneck counter instead of healthier secondary counter", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("google-antigravity", [
			{ type: "oauth", ...createCredential("acct-gemini-hot", "proj-gemini-hot", "hot@example.com") },
			{ type: "oauth", ...createCredential("acct-balanced", "proj-balanced", "balanced@example.com") },
		]);

		usageByAccount.set(
			"acct-gemini-hot",
			createAntigravityReport({
				accountId: "acct-gemini-hot",
				projectId: "proj-gemini-hot",
				windows: [
					{ counter: "google", usedFraction: 0.95, resetInMs: 8 * HOUR_MS },
					{ counter: "anthropic", usedFraction: 0, resetInMs: 8 * HOUR_MS },
				],
			}),
		);
		usageByAccount.set(
			"acct-balanced",
			createAntigravityReport({
				accountId: "acct-balanced",
				projectId: "proj-balanced",
				windows: [
					{ counter: "google", usedFraction: 0.8, resetInMs: 8 * HOUR_MS },
					{ counter: "anthropic", usedFraction: 0.7, resetInMs: 8 * HOUR_MS },
				],
			}),
		);

		const counts = new Map<string, number>();
		for (let i = 0; i < 80; i += 1) {
			const apiKey = await authStorage.getApiKey("google-antigravity", `session-antigravity-bottleneck-${i}`, {
				modelId: "gemini-3-flash",
			});
			if (!apiKey) continue;
			counts.set(apiKey, (counts.get(apiKey) ?? 0) + 1);
		}

		expect(counts.get("api-acct-balanced") ?? 0).toBeGreaterThan(counts.get("api-acct-gemini-hot") ?? 0);
	});
	test("prefers less-pressured antigravity account when neither is exhausted", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("google-antigravity", [
			{ type: "oauth", ...createCredential("acct-loaded", "proj-loaded", "loaded@example.com") },
			{ type: "oauth", ...createCredential("acct-fresh", "proj-fresh", "fresh@example.com") },
		]);

		usageByAccount.set(
			"acct-loaded",
			createAntigravityReport({
				accountId: "acct-loaded",
				projectId: "proj-loaded",
				windows: [{ counter: "google", usedFraction: 0.8, resetInMs: 4 * HOUR_MS }],
			}),
		);
		usageByAccount.set(
			"acct-fresh",
			createAntigravityReport({
				accountId: "acct-fresh",
				projectId: "proj-fresh",
				windows: [{ counter: "google", usedFraction: 0.05, resetInMs: 4 * HOUR_MS }],
			}),
		);

		// Sample several sessions; the weighted picker must favour the fresh
		// account by a clear margin even though both are unblocked.
		const counts = new Map<string, number>();
		for (let i = 0; i < 60; i += 1) {
			const apiKey = await authStorage.getApiKey("google-antigravity", `session-antigravity-fresh-${i}`, {
				modelId: "gemini-3-flash",
			});
			if (!apiKey) continue;
			counts.set(apiKey, (counts.get(apiKey) ?? 0) + 1);
		}

		const fresh = counts.get("api-acct-fresh") ?? 0;
		const loaded = counts.get("api-acct-loaded") ?? 0;
		expect(fresh).toBeGreaterThan(loaded);
	});
});
