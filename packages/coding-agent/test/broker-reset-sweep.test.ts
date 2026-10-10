import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type AuthAccountPolicy,
	DEFAULT_USAGE_RESERVE_PCT,
	type ResetCreditAccountStatus,
	type ResetCreditTarget,
	type UsageReport,
	type UsageResetCredit,
} from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { BrokerResetSweeper } from "@oh-my-pi/pi-coding-agent/session/broker-reset-sweep";
import {
	createCodexAutoRedeemCoordinator,
	IMMINENT_RESET_EXPIRY_MS,
	SWEEP_MIN_INTERVAL_MS,
} from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";
import { TempDir } from "@oh-my-pi/pi-utils";

const HOUR = 3_600_000;
const CODEX = { credentialId: 1, accountId: "codex-account", email: "codex@example.com" };
const SECOND_CODEX = { credentialId: 3, accountId: "second-codex-account", email: "second@example.com" };
const CLAUDE = {
	credentialId: 2,
	accountId: "claude-account",
	email: "claude@example.com",
	orgId: "11111111-1111-4111-8111-111111111111",
};

type CodexAccount = typeof CODEX;

function codexReport(nowMs: number, account: CodexAccount = CODEX): UsageReport {
	return {
		provider: "openai-codex",
		fetchedAt: nowMs,
		limits: [
			{
				id: "openai-codex:primary",
				label: "5 Hour",
				scope: { provider: "openai-codex", accountId: account.accountId, windowId: "5h" },
				window: { id: "5h", label: "5 Hour", resetsAt: nowMs + 2 * HOUR },
				amount: { usedFraction: 0.1, unit: "percent" },
			},
			{
				id: "openai-codex:secondary",
				label: "Weekly",
				scope: { provider: "openai-codex", accountId: account.accountId },
				window: { id: "7d", label: "Weekly", resetsAt: nowMs + 3 * 24 * HOUR },
				amount: { usedFraction: 0.8, unit: "percent" },
			},
		],
		metadata: { accountId: account.accountId, email: account.email },
	};
}

function codexStatus(expiresAtMs: number, account: CodexAccount = CODEX): ResetCreditAccountStatus {
	return {
		provider: "openai-codex",
		...account,
		active: false,
		availableCount: 1,
		credits: [
			{ id: `${account.accountId}-credit`, expiresAt: new Date(expiresAtMs).toISOString(), status: "available" },
		],
	};
}

/** The account's Cedar grant, as its usage report and its live listing both carry it. */
function claudeOffer(expiresAtMs: number) {
	const credit: UsageResetCredit = {
		id: "cedar-grant-1",
		program: "cedar_ember",
		remainingCount: 1,
		usable: true,
		requiresLimit: false,
		clears: ["anthropic:7d"],
		blocking: [],
		usedFractions: { "anthropic:7d": 0 },
		expiresAt: new Date(expiresAtMs).toISOString(),
		status: "available",
	};
	return { availableCount: 1, redeemableCount: 1, eligible: true, nextCreditId: credit.id, credits: [credit] };
}

/** A Claude usage report carrying the account's Cedar inventory, as the usage fetch discovers it. */
function claudeReport(nowMs: number, expiresAtMs: number): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: nowMs,
		limits: [
			{
				id: "anthropic:7d",
				label: "Claude 7 Day",
				scope: { provider: "anthropic", shared: true, windowId: "7d" },
				window: { id: "7d", label: "7 Day", resetsAt: nowMs + 3 * 24 * HOUR },
				amount: { usedFraction: 0, unit: "percent" },
			},
		],
		resetCredits: claudeOffer(expiresAtMs),
		metadata: { accountId: CLAUDE.accountId, email: CLAUDE.email, orgId: CLAUDE.orgId },
	};
}

/** The live listing of the Claude account, carrying the same offer as its report. */
function claudeStatus(nowMs: number, expiresAtMs: number): ResetCreditAccountStatus {
	const report = claudeReport(nowMs, expiresAtMs);
	return { provider: "anthropic", ...CLAUDE, active: false, report, ...claudeOffer(expiresAtMs) };
}

function autoRedeemPolicy(provider: string, email: string, autoRedeem: boolean): AuthAccountPolicy {
	return { provider, account: { email }, autoRedeem };
}

describe("auth broker saved-reset sweep", () => {
	let authStorage: AuthStorage;
	let tempDir: TempDir;
	let sweepers: BrokerResetSweeper[];

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-broker-reset-");
		sweepers = [];
	});

	afterEach(() => {
		for (const sweeper of sweepers) sweeper.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
		authStorage.setAccountPolicies({ accountPolicies: [], defaultReservePct: DEFAULT_USAGE_RESERVE_PCT });
	});

	afterAll(() => {
		authStorage.close();
	});

	/**
	 * Stub the broker's upstreams: cached usage, the live reset listings and
	 * redeem. Sweep wakes are captured instead of armed so the test moves the
	 * clock to each one and runs it.
	 */
	function startBroker(options: {
		now: { ms: number };
		reports: () => UsageReport[];
		live?: (provider: string) => ResetCreditAccountStatus[];
		settings: Record<string, unknown>;
		policies?: AuthAccountPolicy[];
	}) {
		vi.spyOn(Date, "now").mockImplementation(() => options.now.ms);
		vi.spyOn(authStorage.oauth, "accounts").mockImplementation(provider =>
			provider === "anthropic" ? [{ position: 0, ...CLAUDE, active: false }] : [],
		);
		vi.spyOn(authStorage.usage, "reports").mockImplementation(async () => options.reports());
		const listed: string[] = [];
		vi.spyOn(authStorage.resets, "list").mockImplementation(async request => {
			listed.push(request?.provider ?? "");
			return options.live?.(request?.provider ?? "") ?? [];
		});
		authStorage.setAccountPolicies({
			accountPolicies: options.policies ?? [],
			defaultReservePct: DEFAULT_USAGE_RESERVE_PCT,
		});
		const redeemed: ResetCreditTarget[] = [];
		vi.spyOn(authStorage.resets, "redeem").mockImplementation(async request => {
			redeemed.push(request.target);
			return { ok: true, code: "reset", provider: request.target.provider };
		});
		const wakes: { run: () => void; delayMs: number }[] = [];
		let wakeArmed = Promise.withResolvers<void>();
		const realSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) => {
			if (typeof ms !== "number" || ms < SWEEP_MIN_INTERVAL_MS) return realSetTimeout(handler, ms, ...rest);
			wakes.push({ run: handler, delayMs: ms });
			wakeArmed.resolve();
			return realSetTimeout(() => {}, 0);
		}) as typeof globalThis.setTimeout);

		const coordinator = createCodexAutoRedeemCoordinator();
		coordinator.resetLockPath = `${tempDir.path()}/agent.db`;
		const sweeper = new BrokerResetSweeper(authStorage, Settings.isolated(options.settings), coordinator);
		sweepers.push(sweeper);
		return {
			start: () => sweeper.start(),
			listed,
			redeemed,
			/** The delay of the most recently armed wake. */
			lastDelayMs: () => wakes.at(-1)?.delayMs,
			/** Move the clock to the last armed wake, run it, and wait for the next one to arm. */
			async wake(): Promise<void> {
				const wake = wakes.at(-1)!;
				options.now.ms += wake.delayMs;
				wakeArmed = Promise.withResolvers<void>();
				wake.run();
				await wakeArmed.promise;
			},
		};
	}

	it("wakes as a Codex credit enters its last five minutes and spends it under unset auto-redeem", async () => {
		const now = { ms: Date.parse("2026-10-09T12:00:00Z") };
		const expiresAtMs = now.ms + 3 * HOUR;
		const broker = startBroker({
			now,
			reports: () => [codexReport(now.ms)],
			live: provider => (provider === "openai-codex" ? [codexStatus(expiresAtMs)] : []),
			settings: { "codexResets.autoRedeem": "unset", "claudeResets.autoRedeem": "no" },
		});

		await broker.start();
		// Three hours out, salvage would need consent nobody can give; the broker
		// checks hourly until the credit's last five minutes.
		expect(broker.lastDelayMs()).toBe(HOUR);
		await broker.wake();
		await broker.wake();
		expect(broker.redeemed).toEqual([]);
		expect(broker.lastDelayMs()).toBe(HOUR - IMMINENT_RESET_EXPIRY_MS);

		await broker.wake();
		expect(broker.redeemed).toEqual([{ provider: "openai-codex", ...CODEX, creditId: "codex-account-credit" }]);
	});

	it("retries within a minute when the listing fails at a credit's last-chance wake", async () => {
		const now = { ms: Date.parse("2026-10-09T12:00:00Z") };
		const expiresAtMs = now.ms + 30 * 60_000;
		let listingFails = false;
		const broker = startBroker({
			now,
			reports: () => [codexReport(now.ms)],
			live: provider =>
				provider !== "openai-codex"
					? []
					: listingFails
						? [
								{
									...codexStatus(expiresAtMs),
									availableCount: 0,
									credits: [],
									error: "Failed to load saved resets",
								},
							]
						: [codexStatus(expiresAtMs)],
			settings: { "codexResets.autoRedeem": "unset", "claudeResets.autoRedeem": "no" },
		});

		await broker.start();
		expect(broker.lastDelayMs()).toBe(30 * 60_000 - IMMINENT_RESET_EXPIRY_MS);
		listingFails = true;
		await broker.wake();
		expect(broker.redeemed).toEqual([]);
		expect(broker.lastDelayMs()).toBe(SWEEP_MIN_INTERVAL_MS);

		listingFails = false;
		await broker.wake();
		expect(broker.redeemed).toEqual([{ provider: "openai-codex", ...CODEX, creditId: "codex-account-credit" }]);
	});

	it("spends a Claude credit expiring in four minutes once a live listing confirms the report inventory's candidate", async () => {
		const now = { ms: Date.parse("2026-10-09T12:00:00Z") };
		const expiresAtMs = now.ms + 4 * 60_000;
		const broker = startBroker({
			now,
			reports: () => [claudeReport(now.ms, expiresAtMs)],
			live: provider => (provider === "anthropic" ? [claudeStatus(now.ms, expiresAtMs)] : []),
			settings: { "codexResets.autoRedeem": "no", "claudeResets.autoRedeem": "unset" },
		});

		await broker.start();
		expect(broker.listed).toEqual(["anthropic"]);
		expect(broker.redeemed).toEqual([{ provider: "anthropic", creditId: "cedar-grant-1", ...CLAUDE }]);
	});

	it("never spends an account whose policy turns auto-redeem off, even when the provider says yes", async () => {
		const now = { ms: Date.parse("2026-10-09T12:00:00Z") };
		const expiresAtMs = now.ms + 2 * HOUR;
		const broker = startBroker({
			now,
			reports: () => [codexReport(now.ms), codexReport(now.ms, SECOND_CODEX)],
			live: provider =>
				provider === "openai-codex" ? [codexStatus(expiresAtMs), codexStatus(expiresAtMs, SECOND_CODEX)] : [],
			settings: { "codexResets.autoRedeem": "yes", "claudeResets.autoRedeem": "no" },
			policies: [autoRedeemPolicy("openai-codex", CODEX.email, false)],
		});

		await broker.start();
		expect(broker.redeemed).toEqual([{ provider: "openai-codex", ...SECOND_CODEX }]);
	});

	it("salvages for an account whose policy turns auto-redeem on while the provider says no", async () => {
		const now = { ms: Date.parse("2026-10-09T12:00:00Z") };
		const expiresAtMs = now.ms + 2 * HOUR;
		const broker = startBroker({
			now,
			reports: () => [codexReport(now.ms), codexReport(now.ms, SECOND_CODEX)],
			live: provider =>
				provider === "openai-codex" ? [codexStatus(expiresAtMs), codexStatus(expiresAtMs, SECOND_CODEX)] : [],
			settings: { "codexResets.autoRedeem": "no", "claudeResets.autoRedeem": "no" },
			policies: [autoRedeemPolicy("openai-codex", CODEX.email, true)],
		});

		await broker.start();
		expect(broker.redeemed).toEqual([{ provider: "openai-codex", ...CODEX }]);
	});

	it("leaves every credit alone when both providers' auto-redeem is no", async () => {
		const now = { ms: Date.parse("2026-10-09T12:00:00Z") };
		const broker = startBroker({
			now,
			reports: () => [codexReport(now.ms), claudeReport(now.ms, now.ms + 4 * 60_000)],
			live: provider => (provider === "openai-codex" ? [codexStatus(now.ms + 4 * 60_000)] : []),
			settings: { "codexResets.autoRedeem": "no", "claudeResets.autoRedeem": "no" },
		});

		await broker.start();
		expect(broker.redeemed).toEqual([]);
		expect(broker.listed).toEqual([]);
	});

	it("tells clients it sweeps a provider unless its auto-redeem is no and no account policy turns it on", () => {
		const settings = Settings.isolated({ "codexResets.autoRedeem": "unset", "claudeResets.autoRedeem": "no" });
		const sweeper = new BrokerResetSweeper(authStorage, settings, createCodexAutoRedeemCoordinator());
		expect(sweeper.sweeps()).toEqual(["openai-codex"]);

		authStorage.setAccountPolicies({
			accountPolicies: [autoRedeemPolicy("anthropic", CLAUDE.email, true)],
			defaultReservePct: DEFAULT_USAGE_RESERVE_PCT,
		});
		expect(sweeper.sweeps()).toEqual(["openai-codex", "anthropic"]);
	});
});
