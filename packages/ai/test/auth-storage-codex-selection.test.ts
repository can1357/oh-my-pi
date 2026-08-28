import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseCodexRateLimitHeaders } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	RemoteAuthCredentialStore,
	type SnapshotResponse,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const FIVE_HOUR_MS = 5 * HOUR_MS;
const STALE_BLOCK_GUARD_MS = 5 * 60_000 + 1;

function ageCredentialBlockRows(dbPath: string): void {
	const db = new Database(dbPath);
	try {
		db.prepare("UPDATE auth_credential_blocks SET updated_at = ?").run(
			Math.floor((Date.now() - STALE_BLOCK_GUARD_MS) / 1000),
		);
	} finally {
		db.close();
	}
}

function insertLegacyCodexSharedBlock(
	dbPath: string,
	credentialId: number,
	blockedUntilMs: number,
	updatedAtSec = Math.floor(Date.now() / 1000),
): void {
	const db = new Database(dbPath);
	try {
		db.prepare(
			"INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, 'shared', ?, ?)",
		).run(credentialId, "openai-codex:oauth", blockedUntilMs, updatedAtSec);
	} finally {
		db.close();
	}
}

function readLegacyCodexSharedBlock(dbPath: string, credentialId: number): number | undefined {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db
			.prepare(
				"SELECT blocked_until_ms FROM auth_credential_blocks WHERE credential_id = ? AND provider_key = 'openai-codex:oauth' AND block_scope = 'shared' AND blocked_until_ms > ?",
			)
			.get(credentialId, Date.now()) as { blocked_until_ms?: number } | undefined;
		return row?.blocked_until_ms;
	} finally {
		db.close();
	}
}

type UsageWindowSpec = {
	usedFraction: number;
	resetInMs: number;
};

type UsageWindowConfig = {
	windowId: string;
	windowLabel: string;
	durationMs: number;
};

type CodexUsageMetadata = {
	accountId?: string;
	allowed?: boolean;
	limitReached?: boolean;
	planType?: string;
	email?: string;
};

function createLimit(args: {
	key: "primary" | "secondary";
	windowId: string;
	windowLabel: string;
	durationMs: number;
	usedFraction: number;
	resetInMs: number;
}): UsageLimit {
	const clamped = Math.min(Math.max(args.usedFraction, 0), 1);
	const used = clamped * 100;
	return {
		id: `openai-codex:${args.key}`,
		label: args.windowLabel,
		scope: {
			provider: "openai-codex",
			windowId: args.windowId,
			shared: true,
		},
		window: {
			id: args.windowId,
			label: args.windowLabel,
			durationMs: args.durationMs,
			resetsAt: Date.now() + args.resetInMs,
		},
		amount: {
			unit: "percent",
			used,
			limit: 100,
			remaining: 100 - used,
			usedFraction: clamped,
			remainingFraction: Math.max(0, 1 - clamped),
		},
		status: clamped >= 1 ? "exhausted" : clamped >= 0.9 ? "warning" : "ok",
	};
}

function createCodexUsageReport(args: {
	accountId: string;
	primary: UsageWindowSpec;
	secondary: UsageWindowSpec;
	primaryWindow?: UsageWindowConfig;
	secondaryWindow?: UsageWindowConfig;
	metadata?: CodexUsageMetadata;
}): UsageReport {
	const primaryWindow = args.primaryWindow ?? { windowId: "1h", windowLabel: "1 Hour", durationMs: HOUR_MS };
	const secondaryWindow = args.secondaryWindow ?? { windowId: "7d", windowLabel: "7 Day", durationMs: WEEK_MS };
	return {
		provider: "openai-codex",
		fetchedAt: Date.now(),
		limits: [
			createLimit({
				key: "primary",
				windowId: primaryWindow.windowId,
				windowLabel: primaryWindow.windowLabel,
				durationMs: primaryWindow.durationMs,
				usedFraction: args.primary.usedFraction,
				resetInMs: args.primary.resetInMs,
			}),
			createLimit({
				key: "secondary",
				windowId: secondaryWindow.windowId,
				windowLabel: secondaryWindow.windowLabel,
				durationMs: secondaryWindow.durationMs,
				usedFraction: args.secondary.usedFraction,
				resetInMs: args.secondary.resetInMs,
			}),
		],
		metadata: { accountId: args.accountId, ...args.metadata },
	};
}
function addSparkUsage(
	report: UsageReport,
	primaryUsedFraction: number,
	secondaryUsedFraction: number,
	meterState: { allowed: boolean; limitReached: boolean } = {
		allowed: primaryUsedFraction < 1 && secondaryUsedFraction < 1,
		limitReached: primaryUsedFraction >= 1 || secondaryUsedFraction >= 1,
	},
): UsageReport {
	const makeSparkLimit = (key: "primary" | "secondary", usedFraction: number): UsageLimit => {
		const limit = createLimit({
			key,
			windowId: key === "primary" ? "5h" : "7d",
			windowLabel: key === "primary" ? "5 Hours (Spark)" : "7 Days (Spark)",
			durationMs: key === "primary" ? FIVE_HOUR_MS : WEEK_MS,
			usedFraction,
			resetInMs: key === "primary" ? FIVE_HOUR_MS : WEEK_MS,
		});
		return {
			...limit,
			id: `openai-codex:spark:${key}`,
			scope: {
				provider: "openai-codex",
				windowId: limit.scope.windowId,
				tier: "spark",
				modelId: "gpt-5.3-codex-spark",
			},
		};
	};
	return {
		...report,
		limits: [
			...report.limits,
			makeSparkLimit("primary", primaryUsedFraction),
			makeSparkLimit("secondary", secondaryUsedFraction),
		],
		metadata: {
			...report.metadata,
			meterStates: {
				...(report.metadata?.meterStates as Record<string, unknown> | undefined),
				chat: {
					allowed: report.metadata?.allowed,
					limitReached: report.metadata?.limitReached,
				},
				spark: meterState,
			},
		},
	};
}

function createCredential(accountId: string, email: string): OAuthCredentials {
	return {
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + WEEK_MS,
		accountId,
		email,
	};
}

async function countApiKeySelections(
	authStorage: AuthStorage,
	provider: string,
	sessionPrefix: string,
	samples = 150,
	modelId?: string,
): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	for (let index = 0; index < samples; index += 1) {
		const apiKey = await authStorage.getApiKey(
			provider,
			`${sessionPrefix}-${index}`,
			modelId === undefined ? undefined : { modelId },
		);
		if (!apiKey) continue;
		counts.set(apiKey, (counts.get(apiKey) ?? 0) + 1);
	}
	return counts;
}

function countFor(counts: Map<string, number>, apiKey: string): number {
	return counts.get(apiKey) ?? 0;
}

function expectExclusivePreference(counts: Map<string, number>, preferred: string, fallback: string): void {
	expect(countFor(counts, preferred)).toBeGreaterThan(0);
	expect(countFor(counts, fallback)).toBe(0);
}

describe("AuthStorage codex oauth ranking", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let dbPath = "";
	let authStorage: AuthStorage | null = null;
	const usageByAccount = new Map<string, UsageReport>();

	const usageProvider: UsageProvider = {
		id: "openai-codex",
		parseRateLimitHeaders: parseCodexRateLimitHeaders,
		async fetchUsage(params) {
			const accountId = params.credential.accountId;
			if (!accountId) return null;
			return usageByAccount.get(accountId) ?? null;
		},
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-codex-selection-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "openai-codex" ? usageProvider : undefined),
		});
		usageByAccount.clear();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials["openai-codex"] as OAuthCredentials | undefined;
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

	test("prefers near-reset weekly account over lower-used far-reset account", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-near", "near@example.com") },
			{ type: "oauth", ...createCredential("acct-far", "far@example.com") },
		]);

		usageByAccount.set(
			"acct-near",
			createCodexUsageReport({
				accountId: "acct-near",
				primary: { usedFraction: 0.4, resetInMs: 10 * 60 * 1000 },
				secondary: { usedFraction: 0.92, resetInMs: 15 * 60 * 1000 },
			}),
		);
		usageByAccount.set(
			"acct-far",
			createCodexUsageReport({
				accountId: "acct-far",
				primary: { usedFraction: 0.3, resetInMs: 40 * 60 * 1000 },
				secondary: { usedFraction: 0.55, resetInMs: 6 * 24 * 60 * 60 * 1000 },
			}),
		);

		const counts = await countApiKeySelections(authStorage, "openai-codex", "weighted-codex-near");
		expectExclusivePreference(counts, "api-acct-near", "api-acct-far");
	});

	test("keeps a Codex session pinned after >1h idle", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;

		await storage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-pinned", "pinned@example.com") },
			{ type: "oauth", ...createCredential("acct-sibling", "sibling@example.com") },
		]);

		const base = Date.now();
		let clockOffset = 0;
		vi.spyOn(Date, "now").mockImplementation(() => base + clockOffset);

		const setUsage = (pinnedPrimary: number, siblingPrimary: number): void => {
			usageByAccount.set(
				"acct-pinned",
				createCodexUsageReport({
					accountId: "acct-pinned",
					primary: { usedFraction: pinnedPrimary, resetInMs: HOUR_MS },
					secondary: { usedFraction: 0.5, resetInMs: 5 * 24 * HOUR_MS },
				}),
			);
			usageByAccount.set(
				"acct-sibling",
				createCodexUsageReport({
					accountId: "acct-sibling",
					primary: { usedFraction: siblingPrimary, resetInMs: HOUR_MS },
					secondary: { usedFraction: 0.5, resetInMs: 5 * 24 * HOUR_MS },
				}),
			);
		};

		setUsage(0.2, 0.9);
		expect(await storage.getApiKey("openai-codex", "codex-idle-boundary")).toBe("api-acct-pinned");

		// Codex long retention can preserve a prompt cache for 24h, so the
		// Anthropic-specific 1h gate must not re-rank this still-usable pin.
		setUsage(0.9, 0.2);
		clockOffset = 2 * HOUR_MS;
		expect(await storage.getApiKey("openai-codex", "codex-idle-boundary")).toBe("api-acct-pinned");
	});

	test("prefers fresh 5h ticker account at 0% usage", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-zero", "zero@example.com") },
			{ type: "oauth", ...createCredential("acct-progress", "progress@example.com") },
		]);

		const fiveHourWindow: UsageWindowConfig = {
			windowId: "5h",
			windowLabel: "5 Hours",
			durationMs: FIVE_HOUR_MS,
		};

		usageByAccount.set(
			"acct-zero",
			createCodexUsageReport({
				accountId: "acct-zero",
				primary: { usedFraction: 0, resetInMs: FIVE_HOUR_MS },
				secondary: { usedFraction: 0.8, resetInMs: 2 * HOUR_MS },
				primaryWindow: fiveHourWindow,
			}),
		);
		usageByAccount.set(
			"acct-progress",
			createCodexUsageReport({
				accountId: "acct-progress",
				primary: { usedFraction: 0.05, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.1, resetInMs: 6 * 24 * HOUR_MS },
				primaryWindow: fiveHourWindow,
			}),
		);

		const counts = await countApiKeySelections(authStorage, "openai-codex", "weighted-codex-zero");
		expectExclusivePreference(counts, "api-acct-zero", "api-acct-progress");
	});
	test("preserves the uncapped-Pro priority signal when only the secondary window is reported", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-uncapped-pro", "uncapped-pro@example.com") },
			{ type: "oauth", ...createCredential("acct-capped", "capped@example.com") },
		]);

		const uncapped = createCodexUsageReport({
			accountId: "acct-uncapped-pro",
			primary: { usedFraction: 0, resetInMs: FIVE_HOUR_MS },
			secondary: { usedFraction: 0.9, resetInMs: WEEK_MS },
			metadata: { planType: "pro", allowed: true, limitReached: false },
		});
		uncapped.limits = uncapped.limits.filter(limit => limit.id !== "openai-codex:primary");
		usageByAccount.set("acct-uncapped-pro", uncapped);
		usageByAccount.set(
			"acct-capped",
			createCodexUsageReport({
				accountId: "acct-capped",
				primary: { usedFraction: 0, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.5, resetInMs: WEEK_MS },
			}),
		);

		const counts = await countApiKeySelections(authStorage, "openai-codex", "uncapped-pro");
		expectExclusivePreference(counts, "api-acct-uncapped-pro", "api-acct-capped");
	});

	test("does not boost incomplete or differently-scoped Codex usage over measured quota", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-status", "status@example.com") },
			{ type: "oauth", ...createCredential("acct-chat", "chat@example.com") },
			{ type: "oauth", ...createCredential("acct-chat-only", "chat-only@example.com") },
			{ type: "oauth", ...createCredential("acct-spark", "spark@example.com") },
		]);

		usageByAccount.set("acct-status", {
			provider: "openai-codex",
			fetchedAt: Date.now(),
			limits: [],
			metadata: { accountId: "acct-status", allowed: true, limitReached: false },
		});
		usageByAccount.set(
			"acct-chat",
			createCodexUsageReport({
				accountId: "acct-chat",
				primary: { usedFraction: 0.8, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.8, resetInMs: WEEK_MS },
			}),
		);
		const sparkOnlyReport = addSparkUsage(
			createCodexUsageReport({
				accountId: "acct-spark",
				primary: { usedFraction: 0.1, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.1, resetInMs: WEEK_MS },
			}),
			0.1,
			0.1,
		);
		sparkOnlyReport.limits = sparkOnlyReport.limits.filter(limit => limit.id.includes(":spark:"));
		usageByAccount.set("acct-spark", sparkOnlyReport);
		const otherMeterReport = addSparkUsage(
			createCodexUsageReport({
				accountId: "acct-chat-only",
				primary: { usedFraction: 0.9, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.9, resetInMs: WEEK_MS },
			}),
			0.9,
			0.9,
		);
		otherMeterReport.limits = otherMeterReport.limits.filter(limit => limit.id.includes(":spark:"));
		usageByAccount.set("acct-chat-only", otherMeterReport);

		const chatCounts = await countApiKeySelections(authStorage, "openai-codex", "incomplete-chat");
		expectExclusivePreference(chatCounts, "api-acct-chat", "api-acct-status");
		expect(countFor(chatCounts, "api-acct-spark")).toBe(0);
		expect(countFor(chatCounts, "api-acct-chat-only")).toBe(0);

		const sparkCounts = await countApiKeySelections(
			authStorage,
			"openai-codex",
			"incomplete-spark",
			150,
			"gpt-5.3-codex-spark",
		);
		expectExclusivePreference(sparkCounts, "api-acct-spark", "api-acct-chat-only");
	});

	test("does not treat a secondary-only Spark report as an uncapped primary meter", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-incomplete", "incomplete@example.com") },
			{ type: "oauth", ...createCredential("acct-measured", "measured@example.com") },
		]);

		const incomplete = addSparkUsage(
			createCodexUsageReport({
				accountId: "acct-incomplete",
				primary: { usedFraction: 0.9, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.9, resetInMs: WEEK_MS },
			}),
			0.9,
			0.9,
		);
		incomplete.limits = incomplete.limits.filter(limit => limit.id === "openai-codex:spark:secondary");
		usageByAccount.set("acct-incomplete", incomplete);
		usageByAccount.set(
			"acct-measured",
			addSparkUsage(
				createCodexUsageReport({
					accountId: "acct-measured",
					primary: { usedFraction: 0.1, resetInMs: HOUR_MS },
					secondary: { usedFraction: 0.1, resetInMs: WEEK_MS },
				}),
				0.1,
				0.1,
			),
		);

		const counts = await countApiKeySelections(
			authStorage,
			"openai-codex",
			"incomplete-spark-primary",
			150,
			"gpt-5.3-codex-spark",
		);
		expectExclusivePreference(counts, "api-acct-measured", "api-acct-incomplete");
	});

	test("skips exhausted weekly account even when reset is near", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-exhausted", "exhausted@example.com") },
			{ type: "oauth", ...createCredential("acct-healthy", "healthy@example.com") },
		]);

		usageByAccount.set(
			"acct-exhausted",
			createCodexUsageReport({
				accountId: "acct-exhausted",
				primary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
				secondary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
			}),
		);
		usageByAccount.set(
			"acct-healthy",
			createCodexUsageReport({
				accountId: "acct-healthy",
				primary: { usedFraction: 0.5, resetInMs: 20 * 60 * 1000 },
				secondary: { usedFraction: 0.4, resetInMs: 3 * 24 * 60 * 60 * 1000 },
			}),
		);

		const apiKey = await authStorage.getApiKey("openai-codex", "session-exhausted");
		expect(apiKey).toBe("api-acct-healthy");
	});

	test("selects an explicitly allowed 100% Team account over a rejected exhausted sibling", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-exhausted", "exhausted@example.com") },
			{ type: "oauth", ...createCredential("acct-team", "team@example.com") },
		]);

		usageByAccount.set(
			"acct-exhausted",
			createCodexUsageReport({
				accountId: "acct-exhausted",
				primary: { usedFraction: 1, resetInMs: 3 * 24 * HOUR_MS },
				secondary: { usedFraction: 1, resetInMs: 3 * 24 * HOUR_MS },
				metadata: { allowed: false, limitReached: true, planType: "prolite" },
			}),
		);
		const teamReport = createCodexUsageReport({
			accountId: "acct-team",
			primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
			secondary: { usedFraction: 1, resetInMs: 6 * 24 * HOUR_MS },
			metadata: { allowed: true, limitReached: false, planType: "team" },
		});
		const teamSecondary = teamReport.limits.find(limit => limit.id === "openai-codex:secondary");
		if (!teamSecondary) throw new Error("expected Team weekly usage limit");
		teamSecondary.status = "warning";
		usageByAccount.set("acct-team", teamReport);

		expect(await authStorage.getApiKey("openai-codex", "allowed-team-at-100-percent")).toBe("api-acct-team");
	});

	test("temporarily blocks only the exhausted Codex OAuth credential after a quota 429", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-A", "a@example.com") },
			{ type: "oauth", ...createCredential("acct-B", "b@example.com") },
		]);
		usageByAccount.set(
			"acct-A",
			createCodexUsageReport({
				accountId: "acct-A",
				primary: { usedFraction: 0.1, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.1, resetInMs: WEEK_MS },
			}),
		);
		usageByAccount.set(
			"acct-B",
			createCodexUsageReport({
				accountId: "acct-B",
				primary: { usedFraction: 0.1, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.1, resetInMs: WEEK_MS },
			}),
		);

		const sessionId = "session-codex-quota-429";
		const firstKey = await authStorage.getApiKey("openai-codex", sessionId);
		if (!firstKey) throw new Error("expected initial Codex credential");
		const exhaustedAccount = firstKey.replace(/^api-/, "");
		const healthyAccount = exhaustedAccount === "acct-A" ? "acct-B" : "acct-A";
		usageByAccount.set(
			exhaustedAccount,
			createCodexUsageReport({
				accountId: exhaustedAccount,
				primary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
				secondary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
			}),
		);

		const usageLimitSpy = vi.spyOn(authStorage, "markUsageLimitReached");
		const switched = await authStorage.rotateSessionCredential("openai-codex", sessionId, {
			error: Object.assign(new Error("insufficient_quota"), { status: 429 }),
		});

		expect(switched).toBe(true);
		expect(usageLimitSpy).toHaveBeenCalledTimes(1);
		expect(await authStorage.getApiKey("openai-codex", sessionId)).toBe(`api-${healthyAccount}`);
		const activeAccounts = (await authStorage.checkCredentials())
			.map(result => result.accountId)
			.filter((accountId): accountId is string => accountId !== undefined)
			.sort();
		expect(activeAccounts).toEqual(["acct-A", "acct-B"]);
	});

	test("honors a persisted unscoped Codex block for Spark requests", async () => {
		if (!authStorage || !store?.upsertCredentialBlock) throw new Error("test setup failed");
		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-globally-blocked", "globally-blocked@example.com") },
			{ type: "oauth", ...createCredential("acct-sibling", "sibling@example.com") },
		]);
		const blockedRow = store.listAuthCredentials("openai-codex").find(row => {
			const credential = row.credential;
			return credential.type === "oauth" && credential.accountId === "acct-globally-blocked";
		});
		if (!blockedRow) throw new Error("expected blocked credential row");
		store.upsertCredentialBlock({
			credentialId: blockedRow.id,
			providerKey: "openai-codex:oauth",
			blockScope: "",
			blockedUntilMs: Date.now() + HOUR_MS,
		});

		for (let index = 0; index < 20; index++) {
			expect(
				await authStorage.getApiKey("openai-codex", `global-block-spark-${index}`, {
					modelId: "gpt-5.3-codex-spark",
				}),
			).toBe("api-acct-sibling");
		}
	});

	test("a healthy live Codex usage report clears a stale persisted block so the account is selectable again", async () => {
		if (!authStorage || !store?.upsertCredentialBlock || !store.getCredentialBlock) {
			throw new Error("test setup failed");
		}

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-blocked", "blocked@example.com") },
			{ type: "oauth", ...createCredential("acct-healthy", "healthy@example.com") },
		]);

		const blockedRow = store.listAuthCredentials("openai-codex").find(row => {
			const credential = row.credential;
			return credential.type === "oauth" && credential.accountId === "acct-blocked";
		});
		if (!blockedRow) throw new Error("expected blocked credential row");

		store.upsertCredentialBlock({
			credentialId: blockedRow.id,
			providerKey: "openai-codex:oauth",
			blockScope: "shared",
			blockedUntilMs: Date.now() + 6 * 24 * HOUR_MS,
		});
		ageCredentialBlockRows(dbPath);
		store.cleanExpiredCredentialBlocks?.(Date.now() + STALE_BLOCK_GUARD_MS);

		usageByAccount.set(
			"acct-blocked",
			createCodexUsageReport({
				accountId: "acct-blocked",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "blocked@example.com",
					accountId: "acct-blocked",
				},
			}),
		);
		usageByAccount.set(
			"acct-healthy",
			createCodexUsageReport({
				accountId: "acct-healthy",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "healthy@example.com",
					accountId: "acct-healthy",
				},
			}),
		);

		const generationBeforeFetch = authStorage.getGeneration();

		await authStorage.fetchUsageReports();

		expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "shared")).toBeUndefined();
		expect(authStorage.getGeneration()).toBeGreaterThan(generationBeforeFetch);

		const reconciledSelectionCounts = await countApiKeySelections(
			authStorage,
			"openai-codex",
			"stale-codex-block-after-fetch",
			150,
		);
		expect(countFor(reconciledSelectionCounts, "api-acct-blocked")).toBeGreaterThan(0);
	});

	test("re-evaluates a stale persisted Codex block during selection when the 5h window recovered", async () => {
		if (!authStorage || !store?.upsertCredentialBlock || !store.getCredentialBlock) {
			throw new Error("test setup failed");
		}

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-recovered-blocked", "recovered-blocked@example.com") },
			{ type: "oauth", ...createCredential("acct-recovered-sibling", "recovered-sibling@example.com") },
		]);

		const blockedRow = store.listAuthCredentials("openai-codex").find(row => {
			const credential = row.credential;
			return credential.type === "oauth" && credential.accountId === "acct-recovered-blocked";
		});
		if (!blockedRow) throw new Error("expected blocked credential row");

		store.upsertCredentialBlock({
			credentialId: blockedRow.id,
			providerKey: "openai-codex:oauth",
			blockScope: "shared",
			blockedUntilMs: Date.now() + 6 * 24 * HOUR_MS,
		});
		ageCredentialBlockRows(dbPath);
		store.cleanExpiredCredentialBlocks?.(Date.now() + STALE_BLOCK_GUARD_MS);

		const fiveHourWindow: UsageWindowConfig = {
			windowId: "5h",
			windowLabel: "5 Hours",
			durationMs: FIVE_HOUR_MS,
		};

		usageByAccount.set(
			"acct-recovered-blocked",
			createCodexUsageReport({
				accountId: "acct-recovered-blocked",
				primary: { usedFraction: 0.2, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: 6 * 24 * HOUR_MS },
				primaryWindow: fiveHourWindow,
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "recovered-blocked@example.com",
					accountId: "acct-recovered-blocked",
				},
			}),
		);
		usageByAccount.set(
			"acct-recovered-sibling",
			createCodexUsageReport({
				accountId: "acct-recovered-sibling",
				primary: { usedFraction: 0.2, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: 6 * 24 * HOUR_MS },
				primaryWindow: fiveHourWindow,
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "recovered-sibling@example.com",
					accountId: "acct-recovered-sibling",
				},
			}),
		);

		const selectionCounts = await countApiKeySelections(
			authStorage,
			"openai-codex",
			"codex-stale-block-selection-recovered",
			150,
		);

		expect(countFor(selectionCounts, "api-acct-recovered-blocked")).toBeGreaterThan(0);
		expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "shared")).toBeUndefined();
	});

	test("keeps a stale Codex block when the 5h window recovered but the 7d window remains exhausted", async () => {
		if (!authStorage || !store?.upsertCredentialBlock || !store.getCredentialBlock) {
			throw new Error("test setup failed");
		}

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-secondary-exhausted", "secondary-exhausted@example.com") },
			{ type: "oauth", ...createCredential("acct-secondary-healthy", "secondary-healthy@example.com") },
		]);

		const blockedRow = store.listAuthCredentials("openai-codex").find(row => {
			const credential = row.credential;
			return credential.type === "oauth" && credential.accountId === "acct-secondary-exhausted";
		});
		if (!blockedRow) throw new Error("expected blocked credential row");

		const blockedUntilMs = Date.now() + 6 * 24 * HOUR_MS;
		store.upsertCredentialBlock({
			credentialId: blockedRow.id,
			providerKey: "openai-codex:oauth",
			blockScope: "shared",
			blockedUntilMs,
		});

		const fiveHourWindow: UsageWindowConfig = {
			windowId: "5h",
			windowLabel: "5 Hours",
			durationMs: FIVE_HOUR_MS,
		};

		usageByAccount.set(
			"acct-secondary-exhausted",
			createCodexUsageReport({
				accountId: "acct-secondary-exhausted",
				primary: { usedFraction: 0.2, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 1, resetInMs: 6 * 24 * HOUR_MS },
				primaryWindow: fiveHourWindow,
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "secondary-exhausted@example.com",
					accountId: "acct-secondary-exhausted",
				},
			}),
		);
		usageByAccount.set(
			"acct-secondary-healthy",
			createCodexUsageReport({
				accountId: "acct-secondary-healthy",
				primary: { usedFraction: 0.2, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: 6 * 24 * HOUR_MS },
				primaryWindow: fiveHourWindow,
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "secondary-healthy@example.com",
					accountId: "acct-secondary-healthy",
				},
			}),
		);

		const selectionCounts = await countApiKeySelections(
			authStorage,
			"openai-codex",
			"codex-stale-block-secondary-exhausted",
			150,
		);

		expect(countFor(selectionCounts, "api-acct-secondary-exhausted")).toBe(0);
		expect(countFor(selectionCounts, "api-acct-secondary-healthy")).toBeGreaterThan(0);
		expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "shared")).toBeUndefined();
		expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBe(blockedUntilMs);
		expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "spark")).toBe(blockedUntilMs);
	});

	test("keeps a fresh Codex usage-limit block when selection sees healthy usage", async () => {
		if (!authStorage || !store?.getCredentialBlock) {
			throw new Error("test setup failed");
		}

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-fresh-blocked", "fresh-blocked@example.com") },
			{ type: "oauth", ...createCredential("acct-fresh-healthy", "fresh-healthy@example.com") },
		]);

		usageByAccount.set(
			"acct-fresh-blocked",
			createCodexUsageReport({
				accountId: "acct-fresh-blocked",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "fresh-blocked@example.com",
					accountId: "acct-fresh-blocked",
				},
			}),
		);
		usageByAccount.set(
			"acct-fresh-healthy",
			createCodexUsageReport({
				accountId: "acct-fresh-healthy",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "fresh-healthy@example.com",
					accountId: "acct-fresh-healthy",
				},
			}),
		);

		const blockedRow = store.listAuthCredentials("openai-codex").find(row => {
			const credential = row.credential;
			return credential.type === "oauth" && credential.accountId === "acct-fresh-blocked";
		});
		if (!blockedRow) throw new Error("expected blocked credential row");

		let blockedSessionId: string | undefined;
		for (let index = 0; index < 100; index += 1) {
			const sessionId = `codex-fresh-block-selected-${index}`;
			if ((await authStorage.getApiKey("openai-codex", sessionId)) === "api-acct-fresh-blocked") {
				blockedSessionId = sessionId;
				break;
			}
		}
		if (!blockedSessionId) throw new Error("expected a session selecting the soon-blocked account");

		const markResult = await authStorage.markUsageLimitReached("openai-codex", blockedSessionId, {
			retryAfterMs: 6 * 24 * HOUR_MS,
		});

		expect(markResult.switched).toBe(true);
		const selectionAfterBlock = await authStorage.getApiKey("openai-codex", blockedSessionId);
		expect(selectionAfterBlock).not.toBe("api-acct-fresh-blocked");
		expect(selectionAfterBlock).toBe("api-acct-fresh-healthy");
		expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBeDefined();
	});

	test("protects a fresh Codex block after reopening SQLite storage", async () => {
		if (!authStorage || !store?.getCredentialBlock) {
			throw new Error("test setup failed");
		}

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-reopened-blocked", "reopened-blocked@example.com") },
			{ type: "oauth", ...createCredential("acct-reopened-healthy", "reopened-healthy@example.com") },
		]);

		usageByAccount.set(
			"acct-reopened-blocked",
			createCodexUsageReport({
				accountId: "acct-reopened-blocked",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "reopened-blocked@example.com",
					accountId: "acct-reopened-blocked",
				},
			}),
		);
		usageByAccount.set(
			"acct-reopened-healthy",
			createCodexUsageReport({
				accountId: "acct-reopened-healthy",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "reopened-healthy@example.com",
					accountId: "acct-reopened-healthy",
				},
			}),
		);

		const firstSelectionSessionId = "codex-reopened-fresh-block-initial";
		const firstSelection = await authStorage.getApiKey("openai-codex", firstSelectionSessionId);
		if (!firstSelection) throw new Error("expected initial Codex credential");

		const blockedAccountId = firstSelection.replace(/^api-/, "");
		const healthyAccountId =
			blockedAccountId === "acct-reopened-blocked" ? "acct-reopened-healthy" : "acct-reopened-blocked";

		const blockedRow = store.listAuthCredentials("openai-codex").find(row => {
			const credential = row.credential;
			return credential.type === "oauth" && credential.accountId === blockedAccountId;
		});
		if (!blockedRow) throw new Error("expected blocked credential row");

		const markResult = await authStorage.markUsageLimitReached("openai-codex", firstSelectionSessionId, {
			retryAfterMs: 6 * 24 * HOUR_MS,
		});

		expect(markResult.switched).toBe(true);
		expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBeDefined();

		authStorage.close();
		authStorage = null;
		store = null;

		const reopenedStore = await SqliteAuthCredentialStore.open(dbPath);
		const reopenedAuthStorage = new AuthStorage(reopenedStore, {
			usageProviderResolver: provider => (provider === "openai-codex" ? usageProvider : undefined),
		});
		try {
			await reopenedAuthStorage.reload();

			const selectionAfterReopen = await reopenedAuthStorage.getApiKey(
				"openai-codex",
				"codex-reopened-fresh-block-sibling",
			);
			expect(selectionAfterReopen).toBe(`api-${healthyAccountId}`);
			expect(reopenedStore.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBeDefined();
		} finally {
			reopenedAuthStorage.close();
		}
	});

	test("keeps broker-sourced fresh Codex block when sibling selection sees healthy usage", async () => {
		if (!authStorage || !store?.getCredentialBlock) {
			throw new Error("test setup failed");
		}

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-broker-fresh-blocked", "broker-fresh-blocked@example.com") },
			{ type: "oauth", ...createCredential("acct-broker-fresh-healthy", "broker-fresh-healthy@example.com") },
		]);

		usageByAccount.set(
			"acct-broker-fresh-blocked",
			createCodexUsageReport({
				accountId: "acct-broker-fresh-blocked",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "broker-fresh-blocked@example.com",
					accountId: "acct-broker-fresh-blocked",
				},
			}),
		);
		usageByAccount.set(
			"acct-broker-fresh-healthy",
			createCodexUsageReport({
				accountId: "acct-broker-fresh-healthy",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "broker-fresh-healthy@example.com",
					accountId: "acct-broker-fresh-healthy",
				},
			}),
		);

		const token = "codex-broker-fresh-block";
		const handle = startAuthBroker({
			storage: authStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		try {
			const clientA = new AuthBrokerClient({ url: handle.url, token });
			const clientB = new AuthBrokerClient({ url: handle.url, token });
			const initialResult = await clientB.fetchSnapshot();
			if (initialResult.status !== 200) throw new Error("expected initial broker snapshot");
			const blockedRow = initialResult.snapshot.credentials.find(entry => {
				const credential = entry.credential;
				return credential.type === "oauth" && credential.accountId === "acct-broker-fresh-blocked";
			});
			if (!blockedRow) throw new Error("expected blocked credential row");

			const remoteStoreA = new RemoteAuthCredentialStore({
				client: clientA,
				initialSnapshot: initialResult.snapshot,
				streamSnapshots: false,
			});
			const remoteStoreB = new RemoteAuthCredentialStore({
				client: clientB,
				initialSnapshot: initialResult.snapshot,
				streamSnapshots: false,
			});
			const clientStorageA = new AuthStorage(remoteStoreA);
			const clientStorageB = new AuthStorage(remoteStoreB);
			await clientStorageA.reload();
			await clientStorageB.reload();
			try {
				let blockedSessionId: string | undefined;
				for (let index = 0; index < 100; index += 1) {
					const sessionId = `codex-broker-fresh-block-selected-${index}`;
					if ((await clientStorageA.getApiKey("openai-codex", sessionId)) === "api-acct-broker-fresh-blocked") {
						blockedSessionId = sessionId;
						break;
					}
				}
				if (!blockedSessionId) throw new Error("expected client A to select the soon-blocked account");

				const markResult = await clientStorageA.markUsageLimitReached("openai-codex", blockedSessionId, {
					retryAfterMs: 6 * 24 * HOUR_MS,
				});
				expect(markResult.switched).toBe(true);

				const updatedSnapshot = await clientB.fetchSnapshot({
					ifGenerationGt: initialResult.generation,
					waitMs: 1000,
				});
				if (updatedSnapshot.status !== 200) throw new Error("expected broker snapshot containing fresh block");

				await remoteStoreB.refreshSnapshot();
				expect(remoteStoreB.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBeDefined();
				expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBeDefined();

				expect(await clientStorageB.getApiKey("openai-codex", "codex-broker-fresh-block-sibling")).toBe(
					"api-acct-broker-fresh-healthy",
				);
				expect(remoteStoreB.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBeDefined();
				expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBeDefined();
			} finally {
				clientStorageA.close();
				clientStorageB.close();
				remoteStoreA.close();
				remoteStoreB.close();
			}
		} finally {
			await handle.close();
		}
	});

	test("refreshes broker-sourced Codex block protection when the same deadline is re-upserted", async () => {
		if (!authStorage || !store?.getCredentialBlock) {
			throw new Error("test setup failed");
		}

		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				...createCredential("acct-broker-same-deadline-blocked", "broker-same-deadline-blocked@example.com"),
			},
			{
				type: "oauth",
				...createCredential("acct-broker-same-deadline-healthy", "broker-same-deadline-healthy@example.com"),
			},
		]);

		usageByAccount.set(
			"acct-broker-same-deadline-blocked",
			createCodexUsageReport({
				accountId: "acct-broker-same-deadline-blocked",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "broker-same-deadline-blocked@example.com",
					accountId: "acct-broker-same-deadline-blocked",
				},
			}),
		);
		usageByAccount.set(
			"acct-broker-same-deadline-healthy",
			createCodexUsageReport({
				accountId: "acct-broker-same-deadline-healthy",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "broker-same-deadline-healthy@example.com",
					accountId: "acct-broker-same-deadline-healthy",
				},
			}),
		);

		const token = "codex-broker-same-deadline-block";
		const handle = startAuthBroker({
			storage: authStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		try {
			const clientA = new AuthBrokerClient({ url: handle.url, token });
			const clientB = new AuthBrokerClient({ url: handle.url, token });
			const initialResult = await clientB.fetchSnapshot();
			if (initialResult.status !== 200) throw new Error("expected initial broker snapshot");
			const blockedRow = initialResult.snapshot.credentials.find(entry => {
				const credential = entry.credential;
				return credential.type === "oauth" && credential.accountId === "acct-broker-same-deadline-blocked";
			});
			if (!blockedRow) throw new Error("expected blocked credential row");

			const blockedUntilMs = Date.now() + 6 * 24 * HOUR_MS;
			await clientA.upsertCredentialBlock(blockedRow.id, {
				providerKey: "openai-codex:oauth",
				blockScope: "chat",
				blockedUntilMs,
			});

			const initialUpdatedAtSec = Math.floor(Date.now() / 1000) - 1;
			const db = new Database(dbPath);
			try {
				db.prepare(
					"UPDATE auth_credential_blocks SET updated_at = ? WHERE credential_id = ? AND provider_key = ? AND block_scope = ?",
				).run(initialUpdatedAtSec, blockedRow.id, "openai-codex:oauth", "chat");
				const updated = db
					.prepare(
						"SELECT updated_at FROM auth_credential_blocks WHERE credential_id = ? AND provider_key = ? AND block_scope = ?",
					)
					.get(blockedRow.id, "openai-codex:oauth", "chat") as { updated_at?: number } | undefined;
				expect(updated?.updated_at).toBe(initialUpdatedAtSec);
			} finally {
				db.close();
			}

			const snapshotWithBlock = await clientB.fetchSnapshot({
				ifGenerationGt: initialResult.generation,
				waitMs: 1000,
			});
			if (snapshotWithBlock.status !== 200)
				throw new Error("expected broker snapshot containing same-deadline block");
			const initialSnapshotBlock = snapshotWithBlock.snapshot.credentials
				.find(entry => entry.id === blockedRow.id)
				?.blocks?.find(block => block.providerKey === "openai-codex:oauth" && block.blockScope === "chat");
			expect(initialSnapshotBlock?.blockedUntilMs).toBe(blockedUntilMs);
			expect(initialSnapshotBlock?.updatedAtMs).toBe(initialUpdatedAtSec * 1000);

			const remoteStoreB = new RemoteAuthCredentialStore({
				client: clientB,
				initialSnapshot: snapshotWithBlock.snapshot,
				streamSnapshots: false,
			});
			const clientStorageB = new AuthStorage(remoteStoreB);
			await clientStorageB.reload();
			try {
				expect(remoteStoreB.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBe(blockedUntilMs);
				expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBe(blockedUntilMs);

				remoteStoreB.cleanExpiredCredentialBlocks(Date.now() + STALE_BLOCK_GUARD_MS);

				await clientA.upsertCredentialBlock(blockedRow.id, {
					providerKey: "openai-codex:oauth",
					blockScope: "chat",
					blockedUntilMs,
				});
				const refreshedSnapshot = await clientB.fetchSnapshot({
					ifGenerationGt: snapshotWithBlock.generation,
					waitMs: 1000,
				});
				if (refreshedSnapshot.status !== 200) {
					throw new Error("expected broker snapshot containing refreshed same-deadline block");
				}

				await remoteStoreB.refreshSnapshot();
				const refreshedBlock = remoteStoreB.snapshot.credentials
					.find(entry => entry.id === blockedRow.id)
					?.blocks?.find(block => block.providerKey === "openai-codex:oauth" && block.blockScope === "chat");
				expect(refreshedBlock?.blockedUntilMs).toBe(blockedUntilMs);
				expect(refreshedBlock?.updatedAtMs).toBeGreaterThan(initialSnapshotBlock!.updatedAtMs!);

				expect(await clientStorageB.getApiKey("openai-codex", "codex-broker-same-deadline-sibling")).toBe(
					"api-acct-broker-same-deadline-healthy",
				);
				expect(remoteStoreB.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBe(blockedUntilMs);
				expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBe(blockedUntilMs);
			} finally {
				clientStorageB.close();
				remoteStoreB.close();
			}
		} finally {
			await handle.close();
		}
	});

	test("normalizes a legacy shared block posted by an older broker client", async () => {
		if (!authStorage || !store?.getCredentialBlock || !store.listCredentialBlocks) {
			throw new Error("test setup failed");
		}
		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-broker-legacy", "broker-legacy@example.com") },
		]);

		const token = "codex-broker-legacy-block";
		const handle = startAuthBroker({
			storage: authStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		try {
			const client = new AuthBrokerClient({ url: handle.url, token });
			const initialResult = await client.fetchSnapshot();
			if (initialResult.status !== 200) throw new Error("expected initial broker snapshot");
			const credential = initialResult.snapshot.credentials.find(entry => {
				return entry.credential.type === "oauth" && entry.credential.accountId === "acct-broker-legacy";
			});
			if (!credential) throw new Error("expected broker credential");
			const blockedUntilMs = Date.now() + WEEK_MS;
			usageByAccount.set(
				"acct-broker-legacy",
				addSparkUsage(
					createCodexUsageReport({
						accountId: "acct-broker-legacy",
						primary: { usedFraction: 0.06, resetInMs: FIVE_HOUR_MS },
						secondary: { usedFraction: 0.09, resetInMs: WEEK_MS },
						metadata: {
							allowed: true,
							limitReached: false,
							planType: "pro",
							email: "broker-legacy@example.com",
							accountId: "acct-broker-legacy",
						},
					}),
					1,
					1,
					{ allowed: false, limitReached: true },
				),
			);

			await client.upsertCredentialBlock(credential.id, {
				providerKey: "openai-codex:oauth",
				blockScope: "shared",
				blockedUntilMs,
			});
			const result = await client.fetchSnapshot({
				ifGenerationGt: initialResult.generation,
				waitMs: 1000,
			});
			if (result.status !== 200) throw new Error("expected broker snapshot with normalized blocks");
			const blocks = result.snapshot.credentials
				.find(entry => entry.id === credential.id)
				?.blocks?.filter(block => block.providerKey === "openai-codex:oauth");

			expect(blocks?.map(block => [block.blockScope, block.blockedUntilMs])).toEqual([
				["chat", blockedUntilMs],
				["spark", blockedUntilMs],
			]);

			const legacyResponse = await fetch(`${handle.url}/v1/snapshot`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			expect(legacyResponse.status).toBe(200);
			const legacySnapshot = (await legacyResponse.json()) as SnapshotResponse;
			const legacyBlocks = legacySnapshot.credentials
				.find(entry => entry.id === credential.id)
				?.blocks?.filter(block => block.providerKey === "openai-codex:oauth");
			expect(legacyBlocks?.map(block => [block.blockScope, block.blockedUntilMs])).toEqual([
				["shared", blockedUntilMs],
			]);
			const legacyStore = new RemoteAuthCredentialStore({
				client,
				initialSnapshot: legacySnapshot,
				streamSnapshots: false,
			});
			try {
				expect(legacyStore.getCredentialBlock(credential.id, "openai-codex:oauth", "shared")).toBe(blockedUntilMs);
			} finally {
				legacyStore.close();
			}

			expect(store.getCredentialBlock(credential.id, "openai-codex:oauth", "shared")).toBeUndefined();
			expect(store.getCredentialBlock(credential.id, "openai-codex:oauth", "chat")).toBe(blockedUntilMs);
			expect(store.getCredentialBlock(credential.id, "openai-codex:oauth", "spark")).toBe(blockedUntilMs);

			ageCredentialBlockRows(dbPath);
			store.cleanExpiredCredentialBlocks?.(Date.now() + STALE_BLOCK_GUARD_MS);
			const remoteStore = new RemoteAuthCredentialStore({
				client,
				initialSnapshot: result.snapshot,
				streamSnapshots: false,
			});
			const clientStorage = new AuthStorage(remoteStore);
			await clientStorage.reload();
			try {
				remoteStore.cleanExpiredCredentialBlocks(Date.now() + STALE_BLOCK_GUARD_MS);
				await clientStorage.fetchUsageReports();
				await remoteStore.refreshSnapshot();

				const health = await clientStorage.getModelUsageHealth("openai-codex", {
					modelId: "gpt-5.6-sol",
					reserveFraction: 0.1,
				});
				expect(health.state).toBe("healthy");
				expect(remoteStore.listCredentialBlocks([credential.id]).map(block => block.blockScope)).toEqual(["spark"]);
				expect(store.listCredentialBlocks([credential.id]).map(block => block.blockScope)).toEqual(["spark"]);

				const legacyAfterHealingResponse = await fetch(`${handle.url}/v1/snapshot`, {
					headers: { Authorization: `Bearer ${token}` },
				});
				expect(legacyAfterHealingResponse.status).toBe(200);
				const legacyAfterHealingSnapshot = (await legacyAfterHealingResponse.json()) as SnapshotResponse;
				const legacyAfterHealingBlocks = legacyAfterHealingSnapshot.credentials
					.find(entry => entry.id === credential.id)
					?.blocks?.filter(block => block.providerKey === "openai-codex:oauth");
				expect(legacyAfterHealingBlocks?.map(block => [block.blockScope, block.blockedUntilMs])).toEqual([
					["shared", blockedUntilMs],
				]);
			} finally {
				clientStorage.close();
				remoteStore.close();
			}
		} finally {
			await handle.close();
		}
	});

	test("protects fresh Codex blocks present in the initial broker snapshot from healthy selection reconciliation", async () => {
		if (!authStorage || !store?.getCredentialBlock) {
			throw new Error("test setup failed");
		}

		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				...createCredential("acct-broker-initial-snapshot-blocked", "broker-initial-snapshot-blocked@example.com"),
			},
			{
				type: "oauth",
				...createCredential("acct-broker-initial-snapshot-healthy", "broker-initial-snapshot-healthy@example.com"),
			},
		]);

		usageByAccount.set(
			"acct-broker-initial-snapshot-blocked",
			createCodexUsageReport({
				accountId: "acct-broker-initial-snapshot-blocked",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "broker-initial-snapshot-blocked@example.com",
					accountId: "acct-broker-initial-snapshot-blocked",
				},
			}),
		);
		usageByAccount.set(
			"acct-broker-initial-snapshot-healthy",
			createCodexUsageReport({
				accountId: "acct-broker-initial-snapshot-healthy",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "broker-initial-snapshot-healthy@example.com",
					accountId: "acct-broker-initial-snapshot-healthy",
				},
			}),
		);

		const token = "codex-broker-initial-snapshot-block";
		const handle = startAuthBroker({
			storage: authStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		try {
			const clientA = new AuthBrokerClient({ url: handle.url, token });
			const clientB = new AuthBrokerClient({ url: handle.url, token });
			const clientAInitial = await clientA.fetchSnapshot();
			if (clientAInitial.status !== 200) throw new Error("expected client A broker snapshot");

			const remoteStoreA = new RemoteAuthCredentialStore({
				client: clientA,
				initialSnapshot: clientAInitial.snapshot,
				streamSnapshots: false,
			});
			const clientStorageA = new AuthStorage(remoteStoreA);
			await clientStorageA.reload();
			try {
				let blockedSessionId: string | undefined;
				let blockedAccountId: string | undefined;
				for (let index = 0; index < 100; index += 1) {
					const sessionId = `codex-broker-initial-snapshot-block-selected-${index}`;
					const apiKey = await clientStorageA.getApiKey("openai-codex", sessionId);
					if (
						apiKey === "api-acct-broker-initial-snapshot-blocked" ||
						apiKey === "api-acct-broker-initial-snapshot-healthy"
					) {
						blockedSessionId = sessionId;
						blockedAccountId = apiKey.replace(/^api-/, "");
						break;
					}
				}
				if (!blockedSessionId || !blockedAccountId) {
					throw new Error("expected client A to select a Codex account to block");
				}
				const healthyAccountId =
					blockedAccountId === "acct-broker-initial-snapshot-blocked"
						? "acct-broker-initial-snapshot-healthy"
						: "acct-broker-initial-snapshot-blocked";

				const markResult = await clientStorageA.markUsageLimitReached("openai-codex", blockedSessionId, {
					retryAfterMs: 6 * 24 * HOUR_MS,
				});
				expect(markResult.switched).toBe(true);

				const snapshotWithBlock = await clientB.fetchSnapshot({
					ifGenerationGt: clientAInitial.generation,
					waitMs: 1000,
				});
				if (snapshotWithBlock.status !== 200) throw new Error("expected broker snapshot containing initial block");

				const blockedRow = snapshotWithBlock.snapshot.credentials.find(entry => {
					const credential = entry.credential;
					return credential.type === "oauth" && credential.accountId === blockedAccountId;
				});
				if (!blockedRow) throw new Error("expected blocked credential row");
				expect(
					blockedRow.blocks?.some(
						block => block.providerKey === "openai-codex:oauth" && block.blockScope === "chat",
					),
				).toBe(true);
				expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBeDefined();

				const remoteStoreB = new RemoteAuthCredentialStore({
					client: clientB,
					initialSnapshot: snapshotWithBlock.snapshot,
					streamSnapshots: false,
				});
				const clientStorageB = new AuthStorage(remoteStoreB);
				await clientStorageB.reload();
				try {
					expect(remoteStoreB.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBeDefined();

					expect(await clientStorageB.getApiKey("openai-codex", "codex-broker-initial-snapshot-sibling")).toBe(
						`api-${healthyAccountId}`,
					);
					expect(remoteStoreB.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBeDefined();
					expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBeDefined();
				} finally {
					clientStorageB.close();
					remoteStoreB.close();
				}
			} finally {
				clientStorageA.close();
				remoteStoreA.close();
			}
		} finally {
			await handle.close();
		}
	});

	test("an older in-flight healthy Codex usage report does not clear a newer usage-limit block", async () => {
		if (!authStorage || !store?.getCredentialBlock) {
			throw new Error("test setup failed");
		}

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-race-blocked", "race-blocked@example.com") },
			{ type: "oauth", ...createCredential("acct-race-healthy", "race-healthy@example.com") },
		]);

		const blockedReport = createCodexUsageReport({
			accountId: "acct-race-blocked",
			primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
			secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
			metadata: {
				allowed: true,
				limitReached: false,
				planType: "pro",
				email: "race-blocked@example.com",
				accountId: "acct-race-blocked",
			},
		});
		usageByAccount.set("acct-race-blocked", blockedReport);
		usageByAccount.set(
			"acct-race-healthy",
			createCodexUsageReport({
				accountId: "acct-race-healthy",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "race-healthy@example.com",
					accountId: "acct-race-healthy",
				},
			}),
		);

		const blockedRow = store.listAuthCredentials("openai-codex").find(row => {
			const credential = row.credential;
			return credential.type === "oauth" && credential.accountId === "acct-race-blocked";
		});
		if (!blockedRow) throw new Error("expected blocked credential row");

		let blockedSessionId: string | undefined;
		for (let index = 0; index < 100; index += 1) {
			const sessionId = `codex-inflight-race-selected-${index}`;
			if ((await authStorage.getApiKey("openai-codex", sessionId)) === "api-acct-race-blocked") {
				blockedSessionId = sessionId;
				break;
			}
		}
		if (!blockedSessionId) throw new Error("expected a session selecting the race-blocked account");

		const inFlightBaseUrl = "https://codex-inflight-race.example";
		const inFlightStarted = Promise.withResolvers<void>();
		const inFlightUsage = Promise.withResolvers<UsageReport | null>();
		vi.spyOn(usageProvider, "fetchUsage").mockImplementation(async params => {
			const accountId = params.credential.accountId;
			if (params.baseUrl === inFlightBaseUrl && accountId === "acct-race-blocked") {
				inFlightStarted.resolve();
				return inFlightUsage.promise;
			}
			if (!accountId) return null;
			return usageByAccount.get(accountId) ?? null;
		});

		const inFlightReports = authStorage.fetchUsageReports({
			baseUrlResolver: provider => (provider === "openai-codex" ? inFlightBaseUrl : undefined),
		});
		await inFlightStarted.promise;
		expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBeUndefined();

		const markResult = await authStorage.markUsageLimitReached("openai-codex", blockedSessionId, {
			retryAfterMs: 6 * 24 * HOUR_MS,
		});

		expect(markResult.switched).toBe(true);
		expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBeDefined();

		inFlightUsage.resolve(blockedReport);
		await inFlightReports;

		expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBeDefined();
	});

	test("broker-sourced healthy Codex usage clears remote gateway backoff", async () => {
		if (!authStorage || !store?.getCredentialBlock || !store.upsertCredentialBlock) {
			throw new Error("test setup failed");
		}

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-broker-blocked", "broker-blocked@example.com") },
			{ type: "oauth", ...createCredential("acct-broker-healthy", "broker-healthy@example.com") },
		]);

		usageByAccount.set(
			"acct-broker-blocked",
			createCodexUsageReport({
				accountId: "acct-broker-blocked",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "broker-blocked@example.com",
					accountId: "acct-broker-blocked",
				},
			}),
		);
		usageByAccount.set(
			"acct-broker-healthy",
			createCodexUsageReport({
				accountId: "acct-broker-healthy",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "broker-healthy@example.com",
					accountId: "acct-broker-healthy",
				},
			}),
		);

		const staleBlockedRow = store.listAuthCredentials("openai-codex").find(row => {
			const credential = row.credential;
			return credential.type === "oauth" && credential.accountId === "acct-broker-blocked";
		});
		if (!staleBlockedRow) throw new Error("expected stale blocked credential row");
		store.upsertCredentialBlock({
			credentialId: staleBlockedRow.id,
			providerKey: "openai-codex:oauth",
			blockScope: "chat",
			blockedUntilMs: Date.now() + 6 * 24 * HOUR_MS,
		});
		ageCredentialBlockRows(dbPath);
		store.cleanExpiredCredentialBlocks?.(Date.now() + STALE_BLOCK_GUARD_MS);

		const token = "codex-broker-reconcile";
		const handle = startAuthBroker({
			storage: authStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		try {
			const brokerClient = new AuthBrokerClient({ url: handle.url, token });
			const initialResult = await brokerClient.fetchSnapshot();
			if (initialResult.status !== 200) throw new Error("expected broker snapshot");
			const blockedRow = initialResult.snapshot.credentials.find(entry => {
				const credential = entry.credential;
				return credential.type === "oauth" && credential.accountId === "acct-broker-blocked";
			});
			if (!blockedRow) throw new Error("expected blocked credential row");
			const remoteStore = new RemoteAuthCredentialStore({
				client: brokerClient,
				initialSnapshot: initialResult.snapshot,
				streamSnapshots: false,
			});
			const clientStorage = new AuthStorage(remoteStore);
			await clientStorage.reload();
			try {
				expect(remoteStore.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBeDefined();
				expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBeDefined();
				remoteStore.cleanExpiredCredentialBlocks(Date.now() + STALE_BLOCK_GUARD_MS);

				await clientStorage.fetchUsageReports();
				// The broker heals its own store synchronously while serving /v1/usage,
				// but the client snapshot converges via the background long-poll. Pull
				// one explicit snapshot so the assertion doesn't race that poll.
				await remoteStore.refreshSnapshot();

				expect(remoteStore.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBeUndefined();
				expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBeUndefined();
				expect(await clientStorage.getApiKey("openai-codex", "broker-codex-reconciled")).toBe(
					"api-acct-broker-blocked",
				);
			} finally {
				clientStorage.close();
				remoteStore.close();
			}
		} finally {
			await handle.close();
		}
	});

	test("an unhealthy live Codex usage report leaves a stale persisted block in place", async () => {
		if (!authStorage || !store?.upsertCredentialBlock || !store.getCredentialBlock) {
			throw new Error("test setup failed");
		}

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-blocked", "blocked@example.com") },
			{ type: "oauth", ...createCredential("acct-healthy", "healthy@example.com") },
		]);

		const blockedRow = store.listAuthCredentials("openai-codex").find(row => {
			const credential = row.credential;
			return credential.type === "oauth" && credential.accountId === "acct-blocked";
		});
		if (!blockedRow) throw new Error("expected blocked credential row");

		const blockedUntilMs = Date.now() + 6 * 24 * HOUR_MS;
		store.upsertCredentialBlock({
			credentialId: blockedRow.id,
			providerKey: "openai-codex:oauth",
			blockScope: "shared",
			blockedUntilMs,
		});

		usageByAccount.set(
			"acct-blocked",
			createCodexUsageReport({
				accountId: "acct-blocked",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: true,
					planType: "pro",
					email: "blocked@example.com",
					accountId: "acct-blocked",
				},
			}),
		);
		usageByAccount.set(
			"acct-healthy",
			createCodexUsageReport({
				accountId: "acct-healthy",
				primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: WEEK_MS },
				metadata: {
					allowed: true,
					limitReached: false,
					planType: "pro",
					email: "healthy@example.com",
					accountId: "acct-healthy",
				},
			}),
		);

		await authStorage.fetchUsageReports();

		expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "shared")).toBeUndefined();
		expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "chat")).toBe(blockedUntilMs);
		expect(store.getCredentialBlock(blockedRow.id, "openai-codex:oauth", "spark")).toBe(blockedUntilMs);
	});

	test("falls back to earliest-unblocking account when all exhausted", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-soon", "soon@example.com") },
			{ type: "oauth", ...createCredential("acct-later", "later@example.com") },
		]);

		usageByAccount.set(
			"acct-soon",
			createCodexUsageReport({
				accountId: "acct-soon",
				primary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
				secondary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
			}),
		);
		usageByAccount.set(
			"acct-later",
			createCodexUsageReport({
				accountId: "acct-later",
				primary: { usedFraction: 1, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 1, resetInMs: 30 * 60 * 1000 },
			}),
		);

		const apiKey = await authStorage.getApiKey("openai-codex", "session-all-exhausted");
		expect(apiKey).toBe("api-acct-soon");
	});

	test("works with single credential (no ranking)", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [{ type: "oauth", ...createCredential("acct-solo", "solo@example.com") }]);

		usageByAccount.set(
			"acct-solo",
			createCodexUsageReport({
				accountId: "acct-solo",
				primary: { usedFraction: 0.3, resetInMs: 20 * 60 * 1000 },
				secondary: { usedFraction: 0.2, resetInMs: 5 * 24 * 60 * 60 * 1000 },
			}),
		);

		const apiKey = await authStorage.getApiKey("openai-codex", "session-single");
		expect(apiKey).toBe("api-acct-solo");
	});

	test.each([
		["gpt-5.6-sol", "free", "plus"],
		["gpt-5.6-luna", "go", "business"],
		["gpt-5.6-sol-pro", "free", "team"],
	])("%s routes away from a less-used %s account to an eligible %s account", async (modelId, freePlan, paidPlan) => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-free", "free@example.com") },
			{ type: "oauth", ...createCredential("acct-paid", "paid@example.com") },
		]);

		usageByAccount.set(
			"acct-free",
			createCodexUsageReport({
				accountId: "acct-free",
				primary: { usedFraction: 0.01, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.01, resetInMs: 6 * 24 * 60 * 60 * 1000 },
				metadata: { planType: freePlan, email: "free@example.com" },
			}),
		);
		usageByAccount.set(
			"acct-paid",
			createCodexUsageReport({
				accountId: "acct-paid",
				primary: { usedFraction: 0.8, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.8, resetInMs: 6 * 24 * 60 * 60 * 1000 },
				metadata: { planType: paidPlan, email: "paid@example.com" },
			}),
		);

		const apiKey = await authStorage.getApiKey("openai-codex", undefined, { modelId });
		expect(apiKey).toBe("api-acct-paid");
	});

	test.each([
		["gpt-5.6-terra", "free", "enterprise"],
		["gpt-5.6-terra-pro", "go", "pro"],
	])(
		"%s keeps a less-used %s account in ordinary ranking ahead of %s",
		async (modelId, lowUsagePlan, highUsagePlan) => {
			if (!authStorage) throw new Error("test setup failed");

			await authStorage.set("openai-codex", [
				{ type: "oauth", ...createCredential("acct-low-usage", "low-usage@example.com") },
				{ type: "oauth", ...createCredential("acct-high-usage", "high-usage@example.com") },
			]);

			usageByAccount.set(
				"acct-low-usage",
				createCodexUsageReport({
					accountId: "acct-low-usage",
					primary: { usedFraction: 0.01, resetInMs: 30 * 60 * 1000 },
					secondary: { usedFraction: 0.01, resetInMs: 6 * 24 * 60 * 60 * 1000 },
					metadata: { planType: lowUsagePlan, email: "low-usage@example.com" },
				}),
			);
			usageByAccount.set(
				"acct-high-usage",
				createCodexUsageReport({
					accountId: "acct-high-usage",
					primary: { usedFraction: 0.8, resetInMs: 30 * 60 * 1000 },
					secondary: { usedFraction: 0.8, resetInMs: 6 * 24 * 60 * 60 * 1000 },
					metadata: { planType: highUsagePlan, email: "high-usage@example.com" },
				}),
			);

			const apiKey = await authStorage.getApiKey("openai-codex", undefined, { modelId });
			expect(apiKey).toBe("api-acct-low-usage");
		},
	);

	test("keeps an eligible Codex session credential when usage headroom makes its sibling rank better", async () => {
		if (!authStorage) throw new Error("test setup failed");

		const modelId = "gpt-5.6-sol";
		const sessionId = "codex-sticky-usage-rerank";
		const accounts = [
			{ id: "acct-sticky-usage-a", email: "sticky-usage-a@example.com" },
			{ id: "acct-sticky-usage-b", email: "sticky-usage-b@example.com" },
		];
		const reportByAccount: Record<string, UsageReport> = {};
		const setUsedFraction = (report: UsageReport, usedFraction: number): void => {
			const used = usedFraction * 100;
			for (const limit of report.limits) {
				limit.amount.used = used;
				limit.amount.remaining = 100 - used;
				limit.amount.usedFraction = usedFraction;
				limit.amount.remainingFraction = 1 - usedFraction;
				limit.status = usedFraction >= 1 ? "exhausted" : usedFraction >= 0.9 ? "warning" : "ok";
			}
		};

		const base = Date.now();
		let clockOffset = 0;
		vi.spyOn(Date, "now").mockImplementation(() => base + clockOffset);

		await authStorage.set(
			"openai-codex",
			accounts.map(account => ({ type: "oauth", ...createCredential(account.id, account.email) })),
		);
		for (const account of accounts) {
			const report = createCodexUsageReport({
				accountId: account.id,
				primary: { usedFraction: 0.25, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.25, resetInMs: 6 * 24 * 60 * 60 * 1000 },
				metadata: { planType: "business", email: account.email },
			});
			reportByAccount[account.id] = report;
			usageByAccount.set(account.id, report);
		}

		const firstApiKey = await authStorage.getApiKey("openai-codex", sessionId, { modelId });
		if (!firstApiKey) throw new Error("expected initial Codex credential");
		const stickyAccount = firstApiKey.replace(/^api-/, "");
		const siblingAccount = stickyAccount === accounts[0]!.id ? accounts[1]!.id : accounts[0]!.id;
		const stickyReport = reportByAccount[stickyAccount];
		const siblingReport = reportByAccount[siblingAccount];
		if (!stickyReport || !siblingReport) throw new Error("expected reports for both Codex accounts");

		setUsedFraction(stickyReport, 0.85);
		setUsedFraction(siblingReport, 0.01);
		// Step past the usage-report TTL so the second resolve re-fetches the
		// inverted headroom instead of ranking on the cached first-resolve reports
		// (mirrors mid-session header ingest / TTL expiry in a real session).
		clockOffset = 10 * 60 * 1000;
		expect(await authStorage.getApiKey("openai-codex", sessionId, { modelId })).toBe(firstApiKey);
	});

	test("reranks a Terra session on a Go account when it switches to Sol", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-go", "go@example.com") },
			{ type: "oauth", ...createCredential("acct-business", "business@example.com") },
		]);

		usageByAccount.set(
			"acct-go",
			createCodexUsageReport({
				accountId: "acct-go",
				primary: { usedFraction: 0.01, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.01, resetInMs: 6 * 24 * 60 * 60 * 1000 },
				metadata: { planType: "go", email: "go@example.com" },
			}),
		);
		usageByAccount.set(
			"acct-business",
			createCodexUsageReport({
				accountId: "acct-business",
				primary: { usedFraction: 0.8, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.8, resetInMs: 6 * 24 * 60 * 60 * 1000 },
				metadata: { planType: "business", email: "business@example.com" },
			}),
		);

		let terraSession: string | undefined;
		let terraApiKey: string | undefined;
		for (let index = 0; index < 100; index += 1) {
			const sessionId = `session-terra-to-sol-${index}`;
			const apiKey = await authStorage.getApiKey("openai-codex", sessionId, {
				modelId: "gpt-5.6-terra",
			});
			if (apiKey === "api-acct-go") {
				terraSession = sessionId;
				terraApiKey = apiKey;
				break;
			}
		}
		expect(terraApiKey).toBe("api-acct-go");
		if (!terraSession) throw new Error("expected Terra to select the lower-usage Go account");

		const solApiKey = await authStorage.getApiKey("openai-codex", terraSession, {
			modelId: "gpt-5.6-sol",
		});
		expect(solApiKey).toBe("api-acct-business");
	});

	test("falls back by ordinary usage ranking for Sol when no account is confirmed paid", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-free", "free@example.com") },
			{ type: "oauth", ...createCredential("acct-go", "go@example.com") },
		]);

		usageByAccount.set(
			"acct-free",
			createCodexUsageReport({
				accountId: "acct-free",
				primary: { usedFraction: 0.8, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.8, resetInMs: 6 * 24 * 60 * 60 * 1000 },
				metadata: { planType: "free", email: "free@example.com" },
			}),
		);
		usageByAccount.set(
			"acct-go",
			createCodexUsageReport({
				accountId: "acct-go",
				primary: { usedFraction: 0.01, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.01, resetInMs: 6 * 24 * 60 * 60 * 1000 },
				metadata: { planType: "go", email: "go@example.com" },
			}),
		);

		const apiKey = await authStorage.getApiKey("openai-codex", undefined, {
			modelId: "gpt-5.6-sol",
		});
		expect(apiKey).toBe("api-acct-go");
	});

	test("yields an exhausted paid account over an idle free account for a paid-gated model", async () => {
		if (!authStorage) throw new Error("test setup failed");

		// Regression: with every plan-eligible account usage-blocked and an
		// unblocked free account present, resolution used to return NO
		// credential at all ("No API key found") because the old last-resort
		// fallback only fired when the top-ranked candidate happened to be
		// blocked — and the idle free account ranked first. The plan-fitting
		// last-resort pass must yield the exhausted paid account instead, so
		// the caller gets real usage-limit semantics from the wire.
		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-free", "free@example.com") },
			{ type: "oauth", ...createCredential("acct-paid", "paid@example.com") },
		]);

		usageByAccount.set(
			"acct-free",
			createCodexUsageReport({
				accountId: "acct-free",
				primary: { usedFraction: 0.05, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.05, resetInMs: 6 * 24 * 60 * 60 * 1000 },
				metadata: { planType: "free", email: "free@example.com" },
			}),
		);
		usageByAccount.set(
			"acct-paid",
			createCodexUsageReport({
				accountId: "acct-paid",
				primary: { usedFraction: 1, resetInMs: 2 * HOUR_MS },
				secondary: { usedFraction: 1, resetInMs: 6 * 24 * 60 * 60 * 1000 },
				metadata: { planType: "plus", email: "paid@example.com", limitReached: true },
			}),
		);

		const apiKey = await authStorage.getApiKey("openai-codex", "session-paid-gated-all-blocked", {
			modelId: "gpt-5.6-sol",
		});
		expect(apiKey).toBe("api-acct-paid");
	});

	test("attempts every exhausted account for a paid-gated model until one passes the plan gate", async () => {
		if (!authStorage) throw new Error("test setup failed");

		// Production shape of the same regression: EVERY seat is usage-blocked
		// (the free seat resets soonest, so it leads the blocked ordering) and
		// only a later-resetting paid seat can serve gpt-5.6-sol. The blocked
		// pass must keep iterating past the plan-ineligible free seat instead
		// of giving up after the first blocked candidate.
		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-free", "free@example.com") },
			{ type: "oauth", ...createCredential("acct-paid", "paid@example.com") },
		]);

		usageByAccount.set(
			"acct-free",
			createCodexUsageReport({
				accountId: "acct-free",
				primary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
				secondary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
				metadata: { planType: "free", email: "free@example.com", limitReached: true },
			}),
		);
		usageByAccount.set(
			"acct-paid",
			createCodexUsageReport({
				accountId: "acct-paid",
				primary: { usedFraction: 1, resetInMs: 2 * HOUR_MS },
				secondary: { usedFraction: 1, resetInMs: 6 * 24 * 60 * 60 * 1000 },
				metadata: { planType: "plus", email: "paid@example.com", limitReached: true },
			}),
		);

		const apiKey = await authStorage.getApiKey("openai-codex", "session-sol-all-exhausted", {
			modelId: "gpt-5.6-sol",
		});
		expect(apiKey).toBe("api-acct-paid");
	});

	test("prefers Pro accounts for codex spark models over Plus accounts", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-plus", "plus@example.com") },
			{ type: "oauth", ...createCredential("acct-pro", "pro@example.com") },
		]);

		const plusReport = createCodexUsageReport({
			accountId: "acct-plus",
			primary: { usedFraction: 0.05, resetInMs: 30 * 60 * 1000 },
			secondary: { usedFraction: 0.05, resetInMs: 6 * 24 * 60 * 60 * 1000 },
		});
		plusReport.metadata = { ...plusReport.metadata, planType: "plus" };
		usageByAccount.set("acct-plus", plusReport);

		const proReport = createCodexUsageReport({
			accountId: "acct-pro",
			primary: { usedFraction: 0.2, resetInMs: 30 * 60 * 1000 },
			secondary: { usedFraction: 0.2, resetInMs: 6 * 24 * 60 * 60 * 1000 },
		});
		proReport.metadata = { ...proReport.metadata, planType: "pro" };
		usageByAccount.set("acct-pro", proReport);

		const apiKey = await authStorage.getApiKey("openai-codex", "session-spark-prefers-pro", {
			modelId: "gpt-5.3-codex-spark",
		});
		expect(apiKey).toBe("api-acct-pro");
	});

	test("ignores plan-ineligible headroom when reporting Spark model health", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-free", "free@example.com") },
			{ type: "oauth", ...createCredential("acct-pro", "pro@example.com") },
		]);
		usageByAccount.set(
			"acct-free",
			addSparkUsage(
				createCodexUsageReport({
					accountId: "acct-free",
					primary: { usedFraction: 0.05, resetInMs: 30 * 60 * 1000 },
					secondary: { usedFraction: 0.05, resetInMs: 6 * 24 * 60 * 60 * 1000 },
					metadata: { planType: "free", email: "free@example.com" },
				}),
				0.05,
				0.05,
			),
		);
		usageByAccount.set(
			"acct-pro",
			addSparkUsage(
				createCodexUsageReport({
					accountId: "acct-pro",
					primary: { usedFraction: 1, resetInMs: 2 * HOUR_MS },
					secondary: { usedFraction: 1, resetInMs: 6 * 24 * 60 * 60 * 1000 },
					metadata: { planType: "pro", email: "pro@example.com", limitReached: true },
				}),
				1,
				1,
			),
		);

		const health = await authStorage.getModelUsageHealth("openai-codex", {
			modelId: "gpt-5.3-codex-spark",
			reserveFraction: 0.1,
		});

		expect(health.state).toBe("depleted");
		expect(health.accounts).toHaveLength(1);
		expect(health.accounts[0]?.state).toBe("depleted");
	});

	test("reports an all-plan-ineligible Codex pool as depleted", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-free", "free@example.com") },
			{ type: "oauth", ...createCredential("acct-plus", "plus@example.com") },
		]);
		usageByAccount.set(
			"acct-free",
			createCodexUsageReport({
				accountId: "acct-free",
				primary: { usedFraction: 0.05, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.05, resetInMs: 6 * 24 * 60 * 60 * 1000 },
				metadata: { planType: "free", email: "free@example.com" },
			}),
		);
		usageByAccount.set(
			"acct-plus",
			createCodexUsageReport({
				accountId: "acct-plus",
				primary: { usedFraction: 0.05, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.05, resetInMs: 6 * 24 * 60 * 60 * 1000 },
				metadata: { planType: "plus", email: "plus@example.com" },
			}),
		);

		const paidHealth = await authStorage.getModelUsageHealth("openai-codex", {
			modelId: "gpt-5.6-sol",
			reserveFraction: 0.1,
		});
		const proHealth = await authStorage.getModelUsageHealth("openai-codex", {
			modelId: "gpt-5.3-codex-spark",
			reserveFraction: 0.1,
		});

		expect(paidHealth.state).toBe("healthy");
		expect(paidHealth.accounts).toHaveLength(1);
		expect(proHealth).toEqual({ state: "depleted", accounts: [] });
	});

	test("routes codex spark to a single Plus account when no Pro is connected", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [{ type: "oauth", ...createCredential("acct-plus", "plus@example.com") }]);

		const plusReport = createCodexUsageReport({
			accountId: "acct-plus",
			primary: { usedFraction: 0.05, resetInMs: 30 * 60 * 1000 },
			secondary: { usedFraction: 0.05, resetInMs: 6 * 24 * 60 * 60 * 1000 },
		});
		plusReport.metadata = { ...plusReport.metadata, planType: "plus" };
		usageByAccount.set("acct-plus", plusReport);

		const apiKey = await authStorage.getApiKey("openai-codex", "session-spark-single-plus", {
			modelId: "gpt-5.3-codex-spark",
		});
		expect(apiKey).toBe("api-acct-plus");
	});

	test("falls back to Plus accounts for codex spark models when no Pro is connected", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-plus-a", "plus-a@example.com") },
			{ type: "oauth", ...createCredential("acct-plus-b", "plus-b@example.com") },
		]);

		for (const accountId of ["acct-plus-a", "acct-plus-b"]) {
			const plusReport = createCodexUsageReport({
				accountId,
				primary: { usedFraction: 0.05, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.05, resetInMs: 6 * 24 * 60 * 60 * 1000 },
			});
			plusReport.metadata = { ...plusReport.metadata, planType: "plus" };
			usageByAccount.set(accountId, plusReport);
		}

		const apiKey = await authStorage.getApiKey("openai-codex", "session-spark-all-plus", {
			modelId: "gpt-5.3-codex-spark",
		});
		expect(apiKey).toBeDefined();
		expect(apiKey?.startsWith("api-acct-plus-")).toBe(true);
	});

	test("times out slow usage ranking instead of blocking first account selection", async () => {
		if (!store) throw new Error("test setup failed");

		const slowAuthStorage = new AuthStorage(store, {
			usageProviderResolver: provider =>
				provider === "openai-codex"
					? ({
							id: "openai-codex",
							async fetchUsage(params) {
								const { promise, resolve } = Promise.withResolvers<UsageReport | null>();
								params.signal?.addEventListener("abort", () => resolve(null), { once: true });
								// 2s "would-block" fallback: if the per-request timeout below fails
								// to abort the fetch, ranking blocks for this long instead of the
								// ~10ms timeout path. Kept well above the assertion bound so a broken
								// timeout is still caught, while leaving generous slack for CI jitter.
								return Promise.race([promise, Bun.sleep(2_000).then(() => null)]);
							},
						} satisfies UsageProvider)
					: undefined,
			usageRequestTimeoutMs: 10,
		});

		await slowAuthStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-first", "first@example.com") },
			{ type: "oauth", ...createCredential("acct-second", "second@example.com") },
		]);

		const startedAt = Date.now();
		const apiKey = await slowAuthStorage.getApiKey("openai-codex");
		const elapsedMs = Date.now() - startedAt;

		expect(apiKey).toBe("api-acct-first");
		// Timeout path resolves in ~10ms; the would-block fallback is 2s. A bound
		// of 1s proves the 10ms per-request timeout fired without being fooled by
		// the block path, and absorbs scheduling jitter under parallel CI load.
		expect(elapsedMs).toBeLessThan(1_000);
	});

	test("weights 3 accounts by weekly drain rate", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-fast", "fast@example.com") },
			{ type: "oauth", ...createCredential("acct-medium", "medium@example.com") },
			{ type: "oauth", ...createCredential("acct-slow", "slow@example.com") },
		]);

		usageByAccount.set(
			"acct-slow",
			createCodexUsageReport({
				accountId: "acct-slow",
				primary: { usedFraction: 0.2, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.1, resetInMs: 6 * 24 * 60 * 60 * 1000 },
			}),
		);
		usageByAccount.set(
			"acct-medium",
			createCodexUsageReport({
				accountId: "acct-medium",
				primary: { usedFraction: 0.2, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.3, resetInMs: 5 * 24 * 60 * 60 * 1000 },
			}),
		);
		usageByAccount.set(
			"acct-fast",
			createCodexUsageReport({
				accountId: "acct-fast",
				primary: { usedFraction: 0.2, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.7, resetInMs: 3 * 24 * 60 * 60 * 1000 },
			}),
		);

		const counts = await countApiKeySelections(authStorage, "openai-codex", "weighted-codex-three");
		expect(countFor(counts, "api-acct-slow")).toBeGreaterThan(countFor(counts, "api-acct-medium"));
		expect(countFor(counts, "api-acct-slow")).toBeGreaterThan(countFor(counts, "api-acct-fast"));
	});

	test("handles usage fetch failure gracefully (null report)", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-null", "null@example.com") },
			{ type: "oauth", ...createCredential("acct-known", "known@example.com") },
		]);

		// acct-null has no entry in usageByAccount — fetchUsage returns null
		usageByAccount.set(
			"acct-known",
			createCodexUsageReport({
				accountId: "acct-known",
				primary: { usedFraction: 0.2, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 0.3, resetInMs: 5 * 24 * 60 * 60 * 1000 },
			}),
		);

		const counts = await countApiKeySelections(authStorage, "openai-codex", "weighted-codex-known", 300);
		expectExclusivePreference(counts, "api-acct-known", "api-acct-null");
	});

	test("exhausted response headers block the sticky account before the next request", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-hdr-a", "hdr-a@example.com") },
			{ type: "oauth", ...createCredential("acct-hdr-b", "hdr-b@example.com") },
		]);
		for (const accountId of ["acct-hdr-a", "acct-hdr-b"]) {
			usageByAccount.set(
				accountId,
				createCodexUsageReport({
					accountId,
					primary: { usedFraction: 0.2, resetInMs: HOUR_MS },
					secondary: { usedFraction: 0.3, resetInMs: 5 * 24 * HOUR_MS },
				}),
			);
		}

		const sessionId = "hdr-sticky-session";
		const stickyKey = await authStorage.getApiKey("openai-codex", sessionId);
		if (!stickyKey) throw new Error("expected sticky key");
		const stickyAccount = stickyKey.replace("api-", "");
		const siblingKey = stickyAccount === "acct-hdr-a" ? "api-acct-hdr-b" : "api-acct-hdr-a";

		const healthyHeaders = {
			"x-codex-primary-used-percent": "20",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": String(Math.floor((Date.now() + HOUR_MS) / 1000)),
			"x-codex-secondary-used-percent": "30",
			"x-codex-secondary-window-minutes": String(7 * 24 * 60),
			"x-codex-secondary-reset-at": String(Math.floor((Date.now() + 5 * 24 * HOUR_MS) / 1000)),
		};
		expect(authStorage.ingestUsageHeaders("openai-codex", healthyHeaders, { sessionId })).toBe(true);
		// Within the ingest throttle window a healthy snapshot is dropped...
		expect(authStorage.ingestUsageHeaders("openai-codex", healthyHeaders, { sessionId })).toBe(false);
		// ...but an exhausted weekly window bypasses the throttle immediately.
		const exhaustedHeaders = {
			...healthyHeaders,
			"x-codex-secondary-used-percent": "100",
		};
		expect(authStorage.ingestUsageHeaders("openai-codex", exhaustedHeaders, { sessionId })).toBe(true);

		// The next request for the same session must rotate to the sibling
		// without a wire 429: the ingested snapshot blocks the sticky account.
		const rotatedKey = await authStorage.getApiKey("openai-codex", sessionId);
		expect(rotatedKey).toBe(siblingKey);
	});
	test("refreshes expired oauth candidates in parallel before selection", async () => {
		if (!authStorage) throw new Error("test setup failed");

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials["openai-codex"] as OAuthCredentials | undefined;
			if (!credential?.accountId) return null;

			let nextCredential = credential;
			if (Date.now() >= credential.expires) {
				nextCredential = await oauthUtils.refreshOAuthToken("openai-codex", credential);
			}

			if (nextCredential.accountId === "acct-first" || nextCredential.accountId === "acct-second") {
				return null;
			}

			return {
				apiKey: nextCredential.access,
				newCredentials: nextCredential,
			};
		});

		const allRefreshesStarted = Promise.withResolvers<void>();
		const releaseRefreshes = Promise.withResolvers<void>();
		let inFlight = 0;
		let maxConcurrent = 0;
		const refreshStarts: number[] = [];
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
			refreshStarts.push(Date.now());
			inFlight += 1;
			maxConcurrent = Math.max(maxConcurrent, inFlight);
			if (inFlight === 3) allRefreshesStarted.resolve();
			await releaseRefreshes.promise;
			inFlight -= 1;
			return {
				...credential,
				access: `refreshed-${credential.accountId}`,
				expires: Date.now() + HOUR_MS,
			};
		});

		const expiredAt = Date.now() - HOUR_MS;
		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-first", "first@example.com"), expires: expiredAt },
			{ type: "oauth", ...createCredential("acct-second", "second@example.com"), expires: expiredAt },
			{ type: "oauth", ...createCredential("acct-third", "third@example.com"), expires: expiredAt },
		]);

		const apiKeyPromise = authStorage.getApiKey("openai-codex");
		await allRefreshesStarted.promise;
		releaseRefreshes.resolve();
		const apiKey = await apiKeyPromise;

		expect(apiKey).toBe("refreshed-acct-third");
		expect(refreshStarts).toHaveLength(3);
		// Parallelism is proven deterministically by the concurrency counter: serial
		// refreshes never overlap (peak in-flight stays 1). A wall-clock bound here was
		// flaky on loaded CI runners, so maxConcurrent is the authoritative signal.
		expect(maxConcurrent).toBe(3);
	});

	test("skips expired access-token-only sticky credential and selects fresh sibling", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const sessionId = "sticky-token-only-session";
		await authStorage.set("openai-codex", [{ type: "oauth", ...createCredential("acct-k12", "k12@example.com") }]);
		usageByAccount.set(
			"acct-k12",
			createCodexUsageReport({
				accountId: "acct-k12",
				primary: { usedFraction: 0.3, resetInMs: 20 * 60 * 1000 },
				secondary: { usedFraction: 0.2, resetInMs: 5 * 24 * 60 * 60 * 1000 },
			}),
		);
		expect(await authStorage.getApiKey("openai-codex", sessionId)).toBe("api-acct-k12");
		usageByAccount.set(
			"acct-k12",
			createCodexUsageReport({
				accountId: "acct-k12",
				primary: { usedFraction: 1, resetInMs: FIVE_HOUR_MS },
				secondary: { usedFraction: 0.17, resetInMs: WEEK_MS },
			}),
		);
		usageByAccount.set(
			"acct-plus",
			createCodexUsageReport({
				accountId: "acct-plus",
				primary: { usedFraction: 0.2, resetInMs: FIVE_HOUR_MS },
				secondary: { usedFraction: 0.74, resetInMs: WEEK_MS },
			}),
		);

		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "access-acct-k12",
				refresh: "",
				expires: Date.now() - 1_000,
				accountId: "acct-k12",
				email: "k12@example.com",
			},
			{
				type: "oauth",
				...createCredential("acct-plus", "plus@example.com"),
			},
		]);

		expect(await authStorage.getApiKey("openai-codex", sessionId)).toBe("api-acct-plus");
	});

	test("ranks chat and Spark requests by their own usage windows", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-chat-headroom", "chat-headroom@example.com") },
			{ type: "oauth", ...createCredential("acct-spark-headroom", "spark-headroom@example.com") },
		]);
		usageByAccount.set(
			"acct-chat-headroom",
			addSparkUsage(
				createCodexUsageReport({
					accountId: "acct-chat-headroom",
					primary: { usedFraction: 0.1, resetInMs: FIVE_HOUR_MS },
					secondary: { usedFraction: 0.1, resetInMs: WEEK_MS },
					metadata: { allowed: true, limitReached: false, planType: "pro" },
				}),
				0.9,
				0.9,
			),
		);
		usageByAccount.set(
			"acct-spark-headroom",
			addSparkUsage(
				createCodexUsageReport({
					accountId: "acct-spark-headroom",
					primary: { usedFraction: 0.8, resetInMs: FIVE_HOUR_MS },
					secondary: { usedFraction: 0.8, resetInMs: WEEK_MS },
					metadata: { allowed: true, limitReached: false, planType: "pro" },
				}),
				0.2,
				0.2,
			),
		);

		expect(await authStorage.getApiKey("openai-codex", undefined, { modelId: "gpt-5.3-codex" })).toBe(
			"api-acct-chat-headroom",
		);
		expect(await authStorage.getApiKey("openai-codex", undefined, { modelId: "gpt-5.3-codex-spark" })).toBe(
			"api-acct-spark-headroom",
		);
	});

	test.each([
		["gpt-5.6-sol", 0.06, 0.09, true, false, 1, 1, false, true, "spark"],
		["gpt-5.3-codex-spark", 1, 1, false, true, 0.06, 0.09, true, false, "chat"],
	] as const)(
		"reports %s healthy after splitting a legacy shared block when only its meter has headroom",
		async (modelId, chatPrimary, chatSecondary, chatAllowed, chatLimitReached, sparkPrimary, sparkSecondary, sparkAllowed, sparkLimitReached, remainingBlockScope) => {
			if (!authStorage || !store?.listCredentialBlocks) throw new Error("test setup failed");
			await authStorage.set("openai-codex", [
				{ type: "oauth", ...createCredential("acct-legacy-meter", "legacy-meter@example.com") },
			]);
			const [row] = store.listAuthCredentials("openai-codex");
			if (!row) throw new Error("expected credential row");
			const blockedUntilMs = Date.now() + WEEK_MS;
			insertLegacyCodexSharedBlock(
				dbPath,
				row.id,
				blockedUntilMs,
				Math.floor((Date.now() - STALE_BLOCK_GUARD_MS) / 1000),
			);
			usageByAccount.set(
				"acct-legacy-meter",
				addSparkUsage(
					createCodexUsageReport({
						accountId: "acct-legacy-meter",
						primary: { usedFraction: chatPrimary, resetInMs: FIVE_HOUR_MS },
						secondary: { usedFraction: chatSecondary, resetInMs: WEEK_MS },
						metadata: {
							allowed: chatAllowed,
							limitReached: chatLimitReached,
							planType: "pro",
							email: "legacy-meter@example.com",
							accountId: "acct-legacy-meter",
						},
					}),
					sparkPrimary,
					sparkSecondary,
					{ allowed: sparkAllowed, limitReached: sparkLimitReached },
				),
			);

			const health = await authStorage.getModelUsageHealth("openai-codex", {
				modelId,
				reserveFraction: 0.1,
			});

			expect(health).toMatchObject({
				state: "healthy",
				accounts: [
					{
						credentialId: row.id,
						credentialType: "oauth",
						state: "healthy",
					},
				],
			});
			expect(health.accounts[0]?.remainingFraction).toBeCloseTo(0.91, 10);
			expect(store.listCredentialBlocks([row.id]).map(block => [block.blockScope, block.blockedUntilMs])).toEqual([
				[remainingBlockScope, blockedUntilMs],
			]);
			expect(readLegacyCodexSharedBlock(dbPath, row.id)).toBe(blockedUntilMs);
		},
	);

	test("deletes only the recovered persisted Codex meter block", async () => {
		if (!authStorage || !store?.upsertCredentialBlock || !store.getCredentialBlock) {
			throw new Error("test setup failed");
		}
		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-meter-recovery", "meter-recovery@example.com") },
		]);
		const row = store.listAuthCredentials("openai-codex")[0];
		if (!row) throw new Error("expected credential row");
		const blockedUntilMs = Date.now() + WEEK_MS;
		store.upsertCredentialBlock({
			credentialId: row.id,
			providerKey: "openai-codex:oauth",
			blockScope: "chat",
			blockedUntilMs,
		});
		store.upsertCredentialBlock({
			credentialId: row.id,
			providerKey: "openai-codex:oauth",
			blockScope: "spark",
			blockedUntilMs,
		});
		ageCredentialBlockRows(dbPath);
		store.cleanExpiredCredentialBlocks?.(Date.now() + STALE_BLOCK_GUARD_MS);
		usageByAccount.set(
			"acct-meter-recovery",
			addSparkUsage(
				createCodexUsageReport({
					accountId: "acct-meter-recovery",
					primary: { usedFraction: 0.2, resetInMs: FIVE_HOUR_MS },
					secondary: { usedFraction: 0.2, resetInMs: WEEK_MS },
					metadata: { allowed: true, limitReached: false, planType: "pro" },
				}),
				1,
				1,
			),
		);

		await authStorage.fetchUsageReports();
		expect(await authStorage.getApiKey("openai-codex", "meter-recovery", { modelId: "gpt-5.3-codex" })).toBe(
			"api-acct-meter-recovery",
		);
		expect(store.getCredentialBlock(row.id, "openai-codex:oauth", "chat")).toBeUndefined();
		expect(store.getCredentialBlock(row.id, "openai-codex:oauth", "spark")).toBe(blockedUntilMs);
		expect(readLegacyCodexSharedBlock(dbPath, row.id)).toBe(blockedUntilMs);
	});

	test("keeps a stale Spark block when live usage omits the Spark meter", async () => {
		if (!authStorage || !store?.upsertCredentialBlock || !store.getCredentialBlock) {
			throw new Error("test setup failed");
		}
		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-missing-spark", "missing-spark@example.com") },
		]);
		const row = store.listAuthCredentials("openai-codex")[0];
		if (!row) throw new Error("expected credential row");
		const blockedUntilMs = Date.now() + WEEK_MS;
		store.upsertCredentialBlock({
			credentialId: row.id,
			providerKey: "openai-codex:oauth",
			blockScope: "spark",
			blockedUntilMs,
		});
		ageCredentialBlockRows(dbPath);
		store.cleanExpiredCredentialBlocks?.(Date.now() + STALE_BLOCK_GUARD_MS);
		usageByAccount.set(
			"acct-missing-spark",
			createCodexUsageReport({
				accountId: "acct-missing-spark",
				primary: { usedFraction: 0.2, resetInMs: FIVE_HOUR_MS },
				secondary: { usedFraction: 0.2, resetInMs: WEEK_MS },
				metadata: { allowed: true, limitReached: false, planType: "pro" },
			}),
		);

		await authStorage.fetchUsageReports();
		expect(store.getCredentialBlock(row.id, "openai-codex:oauth", "spark")).toBe(blockedUntilMs);
	});

	test("reconciles each meter against its own provider status", async () => {
		if (!authStorage || !store?.upsertCredentialBlock || !store.getCredentialBlock) {
			throw new Error("test setup failed");
		}
		await authStorage.set("openai-codex", [
			{ type: "oauth", ...createCredential("acct-meter-status", "meter-status@example.com") },
		]);
		const row = store.listAuthCredentials("openai-codex")[0];
		if (!row) throw new Error("expected credential row");
		const blockedUntilMs = Date.now() + WEEK_MS;
		for (const blockScope of ["chat", "spark"]) {
			store.upsertCredentialBlock({
				credentialId: row.id,
				providerKey: "openai-codex:oauth",
				blockScope,
				blockedUntilMs,
			});
		}
		ageCredentialBlockRows(dbPath);
		store.cleanExpiredCredentialBlocks?.(Date.now() + STALE_BLOCK_GUARD_MS);
		usageByAccount.set(
			"acct-meter-status",
			addSparkUsage(
				createCodexUsageReport({
					accountId: "acct-meter-status",
					primary: { usedFraction: 1, resetInMs: FIVE_HOUR_MS },
					secondary: { usedFraction: 1, resetInMs: WEEK_MS },
					metadata: { allowed: false, limitReached: true, planType: "pro" },
				}),
				0.2,
				0.2,
				{ allowed: true, limitReached: false },
			),
		);

		await authStorage.fetchUsageReports();
		expect(store.getCredentialBlock(row.id, "openai-codex:oauth", "chat")).toBe(blockedUntilMs);
		expect(store.getCredentialBlock(row.id, "openai-codex:oauth", "spark")).toBeUndefined();
	});

	test("does not reselect a pinned Spark credential with a legacy shared block", async () => {
		if (!authStorage || !store?.upsertCredentialBlock) throw new Error("test setup failed");
		const accounts = ["acct-pinned-a", "acct-pinned-b"];
		await authStorage.set(
			"openai-codex",
			accounts.map(accountId => ({
				type: "oauth" as const,
				...createCredential(accountId, `${accountId}@example.com`),
			})),
		);
		for (const accountId of accounts) {
			usageByAccount.set(
				accountId,
				addSparkUsage(
					createCodexUsageReport({
						accountId,
						primary: { usedFraction: 0.2, resetInMs: FIVE_HOUR_MS },
						secondary: { usedFraction: 0.2, resetInMs: WEEK_MS },
						metadata: { allowed: true, limitReached: false, planType: "pro" },
					}),
					0.2,
					0.2,
				),
			);
		}
		const sessionId = "spark-legacy-shared-pin";
		const modelId = "gpt-5.3-codex-spark";
		const firstKey = await authStorage.getApiKey("openai-codex", sessionId, { modelId });
		if (!firstKey) throw new Error("expected initial selection");
		const firstAccountId = firstKey.replace(/^api-/, "");
		const siblingAccountId = accounts.find(accountId => accountId !== firstAccountId);
		const pinnedRow = store
			.listAuthCredentials("openai-codex")
			.find(row => row.credential.type === "oauth" && row.credential.accountId === firstAccountId);
		if (!pinnedRow || !siblingAccountId) throw new Error("expected pinned credential and sibling");
		store.upsertCredentialBlock({
			credentialId: pinnedRow.id,
			providerKey: "openai-codex:oauth",
			blockScope: "shared",
			blockedUntilMs: Date.now() + WEEK_MS,
		});

		expect(await authStorage.getApiKey("openai-codex", sessionId, { modelId })).toBe(`api-${siblingAccountId}`);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Claude (Anthropic) ranking tests
// ─────────────────────────────────────────────────────────────────────────────

function createClaudeLimit(args: {
	key: "5h" | "7d";
	durationMs: number;
	usedFraction: number;
	resetInMs?: number;
	tier?: "fable";
}): UsageLimit {
	const clamped = Math.min(Math.max(args.usedFraction, 0), 1);
	const used = clamped * 100;
	const label = args.key === "5h" ? "Claude 5 Hour" : args.tier === "fable" ? "Claude 7 Day (Fable)" : "Claude 7 Day";
	return {
		id: args.tier ? `anthropic:${args.key}:${args.tier}` : `anthropic:${args.key}`,
		label,
		scope: {
			provider: "anthropic",
			windowId: args.key,
			...(args.tier ? { tier: args.tier } : { shared: true }),
		},
		window: {
			id: args.key,
			label,
			durationMs: args.durationMs,
			...(args.resetInMs === undefined ? {} : { resetsAt: Date.now() + args.resetInMs }),
		},
		amount: {
			unit: "percent",
			used,
			limit: 100,
			remaining: 100 - used,
			usedFraction: clamped,
			remainingFraction: Math.max(0, 1 - clamped),
		},
		status: clamped >= 1 ? "exhausted" : clamped >= 0.9 ? "warning" : "ok",
	};
}

function createClaudeUsageReport(args: {
	accountId: string;
	primary: { usedFraction: number; resetInMs?: number };
	secondary?: { usedFraction: number; resetInMs?: number };
	fableSecondary?: { usedFraction: number; resetInMs?: number };
}): UsageReport {
	const limits = [
		createClaudeLimit({
			key: "5h",
			durationMs: FIVE_HOUR_MS,
			usedFraction: args.primary.usedFraction,
			resetInMs: args.primary.resetInMs,
		}),
	];
	if (args.secondary) {
		limits.push(
			createClaudeLimit({
				key: "7d",
				durationMs: WEEK_MS,
				usedFraction: args.secondary.usedFraction,
				resetInMs: args.secondary.resetInMs,
			}),
		);
	}
	if (args.fableSecondary) {
		limits.push(
			createClaudeLimit({
				key: "7d",
				durationMs: WEEK_MS,
				usedFraction: args.fableSecondary.usedFraction,
				resetInMs: args.fableSecondary.resetInMs,
				tier: "fable",
			}),
		);
	}
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits,
		metadata: { accountId: args.accountId },
	};
}

describe("AuthStorage claude oauth ranking", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	const usageByAccount = new Map<string, UsageReport>();

	const usageProvider: UsageProvider = {
		id: "anthropic",
		async fetchUsage(params) {
			const accountId = params.credential.accountId;
			if (!accountId) return null;
			return usageByAccount.get(accountId) ?? null;
		},
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-claude-selection-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? usageProvider : undefined),
		});
		usageByAccount.clear();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials.anthropic as OAuthCredentials | undefined;
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

	test("prefers the account whose expiring weekly headroom drains fastest", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-near", "near@example.com") },
			{ type: "oauth", ...createCredential("acct-far", "far@example.com") },
		]);

		usageByAccount.set(
			"acct-near",
			createClaudeUsageReport({
				accountId: "acct-near",
				primary: { usedFraction: 0.4, resetInMs: 2 * HOUR_MS },
				secondary: { usedFraction: 0.92, resetInMs: 15 * 60 * 1000 },
			}),
		);
		usageByAccount.set(
			"acct-far",
			createClaudeUsageReport({
				accountId: "acct-far",
				primary: { usedFraction: 0.3, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.55, resetInMs: 6 * 24 * HOUR_MS },
			}),
		);

		const counts = await countApiKeySelections(authStorage, "anthropic", "weighted-claude-near");
		expectExclusivePreference(counts, "api-acct-near", "api-acct-far");
	});

	test("assumes the full duration remains when ranking clockless windows", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-clockless", "clockless@example.com") },
			{ type: "oauth", ...createCredential("acct-clocked", "clocked@example.com") },
		]);

		usageByAccount.set(
			"acct-clockless",
			createClaudeUsageReport({
				accountId: "acct-clockless",
				primary: { usedFraction: 0 },
				secondary: { usedFraction: 0 },
			}),
		);
		usageByAccount.set(
			"acct-clocked",
			createClaudeUsageReport({
				accountId: "acct-clocked",
				primary: { usedFraction: 0, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.05, resetInMs: 22 * HOUR_MS },
			}),
		);

		const apiKey = await authStorage.getApiKey("anthropic", "session-claude-clockless");
		expect(apiKey).toBe("api-acct-clocked");
	});

	test("does not rank a missing weekly window as the account's 5h window", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-missing-weekly", "missing@example.com") },
			{ type: "oauth", ...createCredential("acct-complete", "complete@example.com") },
		]);

		usageByAccount.set(
			"acct-missing-weekly",
			createClaudeUsageReport({
				accountId: "acct-missing-weekly",
				primary: { usedFraction: 0.8, resetInMs: 3 * HOUR_MS },
			}),
		);
		usageByAccount.set(
			"acct-complete",
			createClaudeUsageReport({
				accountId: "acct-complete",
				primary: { usedFraction: 0 },
				secondary: { usedFraction: 0 },
			}),
		);

		const apiKey = await authStorage.getApiKey("anthropic", "session-claude-missing-weekly", {
			modelId: "claude-opus-4-8",
		});
		expect(apiKey).toBe("api-acct-complete");
	});

	test("resolves equal-priority accounts to one deterministic pick", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-a", "a@example.com") },
			{ type: "oauth", ...createCredential("acct-b", "b@example.com") },
		]);

		for (const accountId of ["acct-a", "acct-b"]) {
			usageByAccount.set(
				accountId,
				createClaudeUsageReport({
					accountId,
					primary: { usedFraction: 0.25, resetInMs: 4 * HOUR_MS },
					secondary: { usedFraction: 0.25, resetInMs: 4 * 24 * HOUR_MS },
				}),
			);
		}

		const counts = await countApiKeySelections(authStorage, "anthropic", "weighted-claude-equal", 200);
		expect(Math.max(countFor(counts, "api-acct-a"), countFor(counts, "api-acct-b"))).toBe(200);
	});

	test("routes every session to the top-ranked account without weighted spread", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-best", "best@example.com") },
			{ type: "oauth", ...createCredential("acct-base-a", "base-a@example.com") },
			{ type: "oauth", ...createCredential("acct-base-b", "base-b@example.com") },
		]);

		usageByAccount.set(
			"acct-best",
			createClaudeUsageReport({
				accountId: "acct-best",
				primary: { usedFraction: 0.05, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.05, resetInMs: 1 * 24 * HOUR_MS },
			}),
		);
		for (const accountId of ["acct-base-a", "acct-base-b"]) {
			usageByAccount.set(
				accountId,
				createClaudeUsageReport({
					accountId,
					primary: { usedFraction: 0.7, resetInMs: 2 * HOUR_MS },
					secondary: { usedFraction: 0.7, resetInMs: 2 * 24 * HOUR_MS },
				}),
			);
		}

		const counts = await countApiKeySelections(authStorage, "anthropic", "claude-cap", 300);
		expectExclusivePreference(counts, "api-acct-best", "api-acct-base-a");
		expectExclusivePreference(counts, "api-acct-best", "api-acct-base-b");
	});

	test("demotes an account whose 5h window is nearly exhausted despite higher weekly drain", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-urgent-hot", "urgent-hot@example.com") },
			{ type: "oauth", ...createCredential("acct-cool", "cool@example.com") },
		]);

		// Urgent-hot: weekly quota expiring in 30min with headroom left (huge
		// required drain), but its 5h window sits at 90% — an imminent
		// mid-session block, so the cool sibling must win.
		usageByAccount.set(
			"acct-urgent-hot",
			createClaudeUsageReport({
				accountId: "acct-urgent-hot",
				primary: { usedFraction: 0.9, resetInMs: 3 * HOUR_MS },
				secondary: { usedFraction: 0.9, resetInMs: 30 * 60 * 1000 },
			}),
		);
		usageByAccount.set(
			"acct-cool",
			createClaudeUsageReport({
				accountId: "acct-cool",
				primary: { usedFraction: 0.2, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.5, resetInMs: 6 * 24 * HOUR_MS },
			}),
		);

		const counts = await countApiKeySelections(authStorage, "anthropic", "claude-hot-guard", 100);
		expectExclusivePreference(counts, "api-acct-cool", "api-acct-urgent-hot");
	});

	test("skips exhausted account and picks healthy", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-exhausted", "exhausted@example.com") },
			{ type: "oauth", ...createCredential("acct-healthy", "healthy@example.com") },
		]);

		usageByAccount.set(
			"acct-exhausted",
			createClaudeUsageReport({
				accountId: "acct-exhausted",
				primary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
				secondary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
			}),
		);
		usageByAccount.set(
			"acct-healthy",
			createClaudeUsageReport({
				accountId: "acct-healthy",
				primary: { usedFraction: 0.5, resetInMs: 3 * HOUR_MS },
				secondary: { usedFraction: 0.4, resetInMs: 3 * 24 * HOUR_MS },
			}),
		);

		const apiKey = await authStorage.getApiKey("anthropic", "session-claude-exhausted");
		expect(apiKey).toBe("api-acct-healthy");
	});

	test("falls back to earliest-unblocking when all exhausted", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-soon", "soon@example.com") },
			{ type: "oauth", ...createCredential("acct-later", "later@example.com") },
		]);

		usageByAccount.set(
			"acct-soon",
			createClaudeUsageReport({
				accountId: "acct-soon",
				primary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
				secondary: { usedFraction: 1, resetInMs: 5 * 60 * 1000 },
			}),
		);
		usageByAccount.set(
			"acct-later",
			createClaudeUsageReport({
				accountId: "acct-later",
				primary: { usedFraction: 1, resetInMs: 30 * 60 * 1000 },
				secondary: { usedFraction: 1, resetInMs: 30 * 60 * 1000 },
			}),
		);

		const apiKey = await authStorage.getApiKey("anthropic", "session-claude-all-exhausted");
		expect(apiKey).toBe("api-acct-soon");
	});

	test("weights 3 accounts by secondary drain rate", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-fast", "fast@example.com") },
			{ type: "oauth", ...createCredential("acct-medium", "medium@example.com") },
			{ type: "oauth", ...createCredential("acct-slow", "slow@example.com") },
		]);

		usageByAccount.set(
			"acct-slow",
			createClaudeUsageReport({
				accountId: "acct-slow",
				primary: { usedFraction: 0.2, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.1, resetInMs: 6 * 24 * HOUR_MS },
			}),
		);
		usageByAccount.set(
			"acct-medium",
			createClaudeUsageReport({
				accountId: "acct-medium",
				primary: { usedFraction: 0.2, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.3, resetInMs: 5 * 24 * HOUR_MS },
			}),
		);
		usageByAccount.set(
			"acct-fast",
			createClaudeUsageReport({
				accountId: "acct-fast",
				primary: { usedFraction: 0.2, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.7, resetInMs: 3 * 24 * HOUR_MS },
			}),
		);

		const counts = await countApiKeySelections(authStorage, "anthropic", "weighted-claude-three");
		expect(countFor(counts, "api-acct-slow")).toBeGreaterThan(countFor(counts, "api-acct-medium"));
		expect(countFor(counts, "api-acct-slow")).toBeGreaterThan(countFor(counts, "api-acct-fast"));
	});

	test("selects the account with lower Fable weekly usage for Claude Fable requests", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-a", "a@example.com") },
			{ type: "oauth", ...createCredential("acct-b", "b@example.com") },
		]);

		usageByAccount.set(
			"acct-a",
			createClaudeUsageReport({
				accountId: "acct-a",
				primary: { usedFraction: 0.2, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.1, resetInMs: 6 * 24 * HOUR_MS },
				fableSecondary: { usedFraction: 0.85, resetInMs: 6 * 24 * HOUR_MS },
			}),
		);
		usageByAccount.set(
			"acct-b",
			createClaudeUsageReport({
				accountId: "acct-b",
				primary: { usedFraction: 0.2, resetInMs: 4 * HOUR_MS },
				secondary: { usedFraction: 0.7, resetInMs: 6 * 24 * HOUR_MS },
				fableSecondary: { usedFraction: 0.2, resetInMs: 6 * 24 * HOUR_MS },
			}),
		);

		const apiKey = await authStorage.getApiKey("anthropic", undefined, { modelId: "claude-fable-5" });
		expect(apiKey).toBe("api-acct-b");
	});

	test("single credential works without ranking", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [{ type: "oauth", ...createCredential("acct-solo", "solo@example.com") }]);

		usageByAccount.set(
			"acct-solo",
			createClaudeUsageReport({
				accountId: "acct-solo",
				primary: { usedFraction: 0.3, resetInMs: 3 * HOUR_MS },
				secondary: { usedFraction: 0.2, resetInMs: 5 * 24 * HOUR_MS },
			}),
		);

		const apiKey = await authStorage.getApiKey("anthropic", "session-claude-single");
		expect(apiKey).toBe("api-acct-solo");
	});

	test("re-ranks a session pinned to a now-worse account after >1h of Anthropic idle", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;

		await storage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-pinned", "pinned@example.com") },
			{ type: "oauth", ...createCredential("acct-fresh", "fresh@example.com") },
		]);

		const base = Date.now();
		let clockOffset = 0;
		vi.spyOn(Date, "now").mockImplementation(() => base + clockOffset);

		// t0: acct-pinned is healthy; acct-fresh's 5h window is hot (>=85%),
		// so ranking picks acct-pinned and pins the session to it.
		const setUsage = (pinnedPrimary: number, freshPrimary: number): void => {
			usageByAccount.set(
				"acct-pinned",
				createClaudeUsageReport({
					accountId: "acct-pinned",
					primary: { usedFraction: pinnedPrimary, resetInMs: 4 * HOUR_MS },
					secondary: { usedFraction: 0.5, resetInMs: 5 * 24 * HOUR_MS },
				}),
			);
			usageByAccount.set(
				"acct-fresh",
				createClaudeUsageReport({
					accountId: "acct-fresh",
					primary: { usedFraction: freshPrimary, resetInMs: 4 * HOUR_MS },
					secondary: { usedFraction: 0.5, resetInMs: 5 * 24 * HOUR_MS },
				}),
			);
		};

		setUsage(0.2, 0.9);
		expect(await storage.getApiKey("anthropic", "claude-idle-gating")).toBe("api-acct-pinned");

		// The tables turn: acct-pinned's 5h window is now hot, acct-fresh is cool.
		setUsage(0.9, 0.2);

		// Within 1h of the last resolve the conversation prefix is plausibly warm,
		// so the pin must hold even though it is now the worse account.
		clockOffset = 30 * 60 * 1000;
		expect(await storage.getApiKey("anthropic", "claude-idle-gating")).toBe("api-acct-pinned");

		// After >1h of Anthropic request inactivity the prompt cache is no longer
		// guaranteed warm, so ranking must run again and rotate to the better sibling.
		clockOffset = 30 * 60 * 1000 + 2 * HOUR_MS;
		expect(await storage.getApiKey("anthropic", "claude-idle-gating")).toBe("api-acct-fresh");
	});

	test("keeps the pinned account after idle when siblings rank equal (tie-break)", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;

		await storage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-a", "a@example.com") },
			{ type: "oauth", ...createCredential("acct-b", "b@example.com") },
		]);

		const base = Date.now();
		let clockOffset = 0;
		vi.spyOn(Date, "now").mockImplementation(() => base + clockOffset);

		for (const accountId of ["acct-a", "acct-b"]) {
			usageByAccount.set(
				accountId,
				createClaudeUsageReport({
					accountId,
					primary: { usedFraction: 0.25, resetInMs: 4 * HOUR_MS },
					secondary: { usedFraction: 0.25, resetInMs: 4 * 24 * HOUR_MS },
				}),
			);
		}

		const first = await storage.getApiKey("anthropic", "claude-idle-tie");
		expect(first).toBeDefined();

		// Past the warm window ranking runs again, but both accounts score equal,
		// so the pin must win the tie rather than churn to the sibling.
		clockOffset = HOUR_MS + 1;
		expect(await storage.getApiKey("anthropic", "claude-idle-tie")).toBe(first);
	});
});
