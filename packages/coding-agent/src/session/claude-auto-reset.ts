import {
	type ResetCreditAccountStatus,
	type ResetCreditTarget,
	resolveUsedFraction,
	type UsageLimit,
	type UsageReport,
	type UsageResetCredit,
} from "@oh-my-pi/pi-ai";
import { claudeRankingStrategy } from "@oh-my-pi/pi-ai/usage/claude";
import {
	ATTEMPT_COOLDOWN_MS,
	DEBOUNCE_BUCKET_MS,
	REPORT_FRESHNESS_MS,
	SALVAGE_MIN_USED_FRACTION,
	type CodexResetTrigger,
} from "./codex-auto-reset";

const CLAUDE_PROVIDER = "anthropic";
const JUNIPER_PROGRAM = "juniper_tide";
const CEDAR_PROGRAM = "cedar_ember";
const FIVE_HOUR_LIMIT_ID = "anthropic:5h";
const MAX_PLAUSIBLE_FIVE_HOUR_MS = 6 * 3_600_000;
const MAX_PLAUSIBLE_WEEKLY_MS = 8 * 24 * 3_600_000;

/** Why an account or grant is unsafe or unhelpful for automatic redemption. */
export type ClaudeResetSkipReason =
	| "disabled"
	| "wrong-provider"
	| "no-identity"
	| "no-report"
	| "stale-report"
	| "credits-unknown"
	| "ineligible"
	| "no-credits"
	| "no-selected-credit"
	| "credit-unusable"
	| "credit-expired"
	| "provider-cooldown"
	| "reserve"
	| "no-blocked-window"
	| "unsupported-window"
	| "incomplete-coverage"
	| "no-reset-time"
	| "reset-too-soon"
	| "reset-implausible"
	| "no-expiring-credit"
	| "unsupported-program"
	| "window-mostly-free"
	| "already-attempted"
	| "deferred"
	| "cooldown";

/** Live grant eligibility and usage evidence for one deterministic planning pass. */
export interface ClaudeResetPlanInput {
	nowMs: number;
	trigger: CodexResetTrigger;
	provider: string;
	modelId: string;
	settings: {
		enabled: boolean;
		minBlockedMinutes: number;
		keepCredits: number;
		salvageHorizonMs: number;
	};
	/** Fresh usage for every stored Claude account. */
	reports: UsageReport[] | null;
	/** Authoritative live Cedar/Juniper eligibility for every stored account. */
	statuses: readonly ResetCreditAccountStatus[];
	attemptedKeys: ReadonlySet<string>;
	deferredUntilByKey: ReadonlyMap<string, number>;
	lastAttemptAtByAccount: ReadonlyMap<string, number>;
	/** Provider retry hint for the active account, captured at the 429. */
	activeBlockUnblockAtMs?: number;
}

/** One server-selected Claude grant to redeem for an exact stored credential. */
export interface ClaudeResetAction {
	reason: "blocked-account" | "expiring-credit";
	target: ResetCreditTarget;
	accountKey: string;
	attemptKey: string;
	label: string;
	availableCount: number;
	remainingMs?: number;
	blockedWindows?: string[];
	expiresInMs?: number;
	salvageWindow?: string;
	salvageUsedFraction?: number;
	active: boolean;
	program: string;
	title?: string;
	requiresLimit: boolean;
}

/** Account-scoped diagnostic explaining why a planning rule did not spend. */
export interface ClaudeResetSkip {
	accountKey: string;
	rule: "blocked-account" | "expiring-credit" | "account";
	reason: ClaudeResetSkipReason;
}

/** At most one blocked-account restore followed by independent expiry salvages. */
export interface ClaudeResetPlan {
	actions: ClaudeResetAction[];
	skipped: ClaudeResetSkip[];
}

interface ClaudeAccountSnapshot {
	accountKey: string;
	target: ResetCreditTarget;
	label: string;
	active: boolean;
	availableCount: number;
	credit: UsageResetCredit;
	limits: UsageLimit[];
}

function normalized(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function reportMatchesStatus(report: UsageReport, status: ResetCreditAccountStatus): boolean {
	if (report.provider !== CLAUDE_PROVIDER) return false;
	const reportOrgId = normalized(report.metadata?.orgId);
	const statusOrgId = normalized(status.orgId);
	if (reportOrgId !== statusOrgId) return false;
	const reportAccountId = normalized(report.metadata?.accountId) ?? normalized(report.metadata?.account_id);
	const reportEmail = normalized(report.metadata?.email);
	const accountId = normalized(status.accountId);
	const email = normalized(status.email);
	if (accountId && reportAccountId) return accountId === reportAccountId;
	return !!email && email === reportEmail;
}

function creditExpiryMs(credit: UsageResetCredit): number | undefined {
	if (!credit.expiresAt) return undefined;
	const parsed = Date.parse(credit.expiresAt);
	return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function isExhausted(limit: UsageLimit): boolean {
	if (limit.status === "exhausted") return true;
	const used = resolveUsedFraction(limit);
	return used !== undefined && used >= 0.999;
}

function maxPlausibleRemainingMs(limitId: string, limit: UsageLimit | undefined): number {
	const duration = limit?.window?.durationMs;
	if (duration !== undefined && Number.isFinite(duration) && duration > 0) return duration + 3_600_000;
	return limitId === FIVE_HOUR_LIMIT_ID ? MAX_PLAUSIBLE_FIVE_HOUR_MS : MAX_PLAUSIBLE_WEEKLY_MS;
}

function claudeBlockedAttemptKey(
	accountKey: string,
	creditId: string,
	remainingCount: number,
	blockers: readonly string[],
	unblockAtMs: number,
): string {
	return `block|${accountKey}|${creditId}|${remainingCount}|${[...blockers].sort().join(",")}|${Math.round(unblockAtMs / DEBOUNCE_BUCKET_MS)}`;
}

function claudeSalvageAttemptKey(
	accountKey: string,
	creditId: string,
	remainingCount: number,
	expiresAtMs: number,
): string {
	return `salvage|${accountKey}|${creditId}|${remainingCount}|${Math.round(expiresAtMs / DEBOUNCE_BUCKET_MS)}`;
}

function skipForEpisode(
	input: ClaudeResetPlanInput,
	accountKey: string,
	attemptKey: string,
): "already-attempted" | "deferred" | "cooldown" | undefined {
	if (input.attemptedKeys.has(attemptKey)) return "already-attempted";
	const blockedPrefix = `block|${accountKey}|`;
	const salvagePrefix = `salvage|${accountKey}|`;
	for (const [key, until] of input.deferredUntilByKey) {
		if (until > input.nowMs && (key.startsWith(blockedPrefix) || key.startsWith(salvagePrefix))) return "deferred";
	}
	const lastAttemptAt = input.lastAttemptAtByAccount.get(accountKey);
	if (lastAttemptAt !== undefined && input.nowMs - lastAttemptAt < ATTEMPT_COOLDOWN_MS) return "cooldown";
	return undefined;
}

/**
 * Pure Claude Cedar/Juniper auto-spend planner. The live listing is the sole
 * authority for eligibility and grant selection: an absent/failed status never
 * falls back to a cached report or guesses a different grant.
 */
export function planClaudeResetRedemptions(input: ClaudeResetPlanInput): ClaudeResetPlan {
	const skipped: ClaudeResetSkip[] = [];
	if (!input.settings.enabled) {
		return { actions: [], skipped: [{ accountKey: "*", rule: "account", reason: "disabled" }] };
	}
	if (input.trigger === "blocked" && input.provider !== CLAUDE_PROVIDER) {
		return { actions: [], skipped: [{ accountKey: "*", rule: "blocked-account", reason: "wrong-provider" }] };
	}

	const snapshots: ClaudeAccountSnapshot[] = [];
	for (const status of input.statuses) {
		if (status.provider !== CLAUDE_PROVIDER) continue;
		const accountKey = Number.isInteger(status.credentialId)
			? `${CLAUDE_PROVIDER}|${normalized(status.orgId) ?? "-"}|${status.credentialId}`
			: undefined;
		if (!accountKey) {
			skipped.push({ accountKey: "*", rule: "account", reason: "no-identity" });
			continue;
		}
		const skip = (reason: ClaudeResetSkipReason) => skipped.push({ accountKey, rule: "account", reason });
		if (status.error) {
			skip("credits-unknown");
			continue;
		}
		if (status.eligible !== true) {
			skip("ineligible");
			continue;
		}
		if (status.cooldownUntil) {
			const cooldownUntil = Date.parse(status.cooldownUntil);
			if (!Number.isNaN(cooldownUntil) && cooldownUntil > input.nowMs) {
				skip("provider-cooldown");
				continue;
			}
		}
		if (status.availableCount < 1 || (status.redeemableCount !== undefined && status.redeemableCount < 1)) {
			skip("no-credits");
			continue;
		}
		const selectedId = status.nextCreditId;
		const credit = selectedId ? status.credits.find(candidate => candidate.id === selectedId) : undefined;
		if (!selectedId || !credit) {
			skip("no-selected-credit");
			continue;
		}
		if (
			credit.usable !== true ||
			(credit.status !== undefined && credit.status !== "available") ||
			credit.remainingCount === undefined ||
			credit.remainingCount < 1
		) {
			skip("credit-unusable");
			continue;
		}
		if (credit.program !== CEDAR_PROGRAM && credit.program !== JUNIPER_PROGRAM) {
			skip("unsupported-program");
			continue;
		}
		const expiresAtMs = creditExpiryMs(credit);
		if (expiresAtMs !== undefined && (!Number.isFinite(expiresAtMs) || expiresAtMs <= input.nowMs)) {
			skip("credit-expired");
			continue;
		}
		if (status.availableCount - Math.max(0, Math.trunc(input.settings.keepCredits)) < 1) {
			skip("reserve");
			continue;
		}
		const report = input.reports?.find(candidate => reportMatchesStatus(candidate, status));
		if (!report) {
			skip("no-report");
			continue;
		}
		if (input.nowMs - report.fetchedAt > REPORT_FRESHNESS_MS) {
			skip("stale-report");
			continue;
		}
		// A blocked retry has an exact request-model scope. A background salvage
		// has no such request context, so consider every reported scope rather
		// than accidentally treating an unrelated current model as authoritative.
		const limits =
			input.trigger === "blocked"
				? (claudeRankingStrategy.scopeLimitsForReserve?.(report, { modelId: input.modelId }) ?? report.limits)
				: report.limits;
		const baseLabel = status.email ?? status.accountId ?? status.orgId ?? accountKey;
		const organizationLabel = status.orgName ?? status.orgId;
		const label =
			organizationLabel && organizationLabel !== baseLabel ? `${baseLabel} (${organizationLabel})` : baseLabel;
		snapshots.push({
			accountKey,
			target: {
				provider: CLAUDE_PROVIDER,
				creditId: selectedId,
				credentialId: status.credentialId,
				accountId: status.accountId,
				email: status.email,
				orgId: status.orgId,
			},
			label,
			active: status.active,
			availableCount: status.availableCount,
			credit,
			limits,
		});
	}

	let restore: ClaudeResetAction | undefined;
	if (input.trigger === "blocked") {
		interface RestoreCandidate {
			snapshot: ClaudeAccountSnapshot;
			blockers: string[];
			remainingMs: number;
			unblockAtMs: number;
		}
		const candidates: RestoreCandidate[] = [];
		for (const snapshot of snapshots) {
			const skip = (reason: ClaudeResetSkipReason) =>
				skipped.push({ accountKey: snapshot.accountKey, rule: "blocked-account", reason });
			const clears = new Set(snapshot.credit.clears ?? []);
			const reportedBlockers = snapshot.limits
				.filter(limit => isExhausted(limit) || (snapshot.credit.usedFractions?.[limit.id] ?? 0) >= 0.999)
				.map(limit => limit.id);
			const serverBlockers = snapshot.credit.blocking ?? [];
			const blockers = [...new Set([...reportedBlockers, ...serverBlockers])];
			if (blockers.length === 0) {
				skip("no-blocked-window");
				continue;
			}
			if (blockers.some(id => !snapshot.limits.some(limit => limit.id === id))) {
				skip("unsupported-window");
				continue;
			}
			if (blockers.some(id => !clears.has(id))) {
				skip("incomplete-coverage");
				continue;
			}
			if (
				snapshot.credit.program === JUNIPER_PROGRAM &&
				(blockers.length !== 1 || blockers[0] !== FIVE_HOUR_LIMIT_ID)
			) {
				skip("incomplete-coverage");
				continue;
			}

			let unblockAtMs = Number.NEGATIVE_INFINITY;
			let invalid: ClaudeResetSkipReason | undefined;
			for (const blocker of blockers) {
				const limit = snapshot.limits.find(candidate => candidate.id === blocker);
				const resetsAt = limit?.window?.resetsAt;
				if (resetsAt === undefined || !Number.isFinite(resetsAt)) {
					invalid = "no-reset-time";
					break;
				}
				if (resetsAt - input.nowMs > maxPlausibleRemainingMs(blocker, limit)) {
					invalid = "reset-implausible";
					break;
				}
				if (resetsAt > unblockAtMs) unblockAtMs = resetsAt;
			}
			if (invalid === "no-reset-time" && snapshot.active && input.activeBlockUnblockAtMs !== undefined) {
				unblockAtMs = input.activeBlockUnblockAtMs;
				invalid = undefined;
				const onlyFiveHour = blockers.every(id => id === FIVE_HOUR_LIMIT_ID);
				const plausible = onlyFiveHour ? MAX_PLAUSIBLE_FIVE_HOUR_MS : MAX_PLAUSIBLE_WEEKLY_MS;
				if (unblockAtMs - input.nowMs > plausible) invalid = "reset-implausible";
			}
			if (invalid) {
				skip(invalid);
				continue;
			}
			const remainingMs = unblockAtMs - input.nowMs;
			if (remainingMs < input.settings.minBlockedMinutes * 60_000) {
				skip("reset-too-soon");
				continue;
			}
			const attemptKey = claudeBlockedAttemptKey(
				snapshot.accountKey,
				snapshot.credit.id,
				snapshot.credit.remainingCount ?? 0,
				blockers,
				unblockAtMs,
			);
			const episodeSkip = skipForEpisode(input, snapshot.accountKey, attemptKey);
			if (episodeSkip) {
				skip(episodeSkip);
				continue;
			}
			candidates.push({ snapshot, blockers, remainingMs, unblockAtMs });
		}
		candidates.sort((left, right) => {
			if (left.snapshot.active !== right.snapshot.active) return left.snapshot.active ? -1 : 1;
			const leftExpiry = creditExpiryMs(left.snapshot.credit) ?? Number.POSITIVE_INFINITY;
			const rightExpiry = creditExpiryMs(right.snapshot.credit) ?? Number.POSITIVE_INFINITY;
			if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
			return right.remainingMs - left.remainingMs;
		});
		const best = candidates[0];
		if (best) {
			const expiresAtMs = creditExpiryMs(best.snapshot.credit);
			restore = {
				reason: "blocked-account",
				target: best.snapshot.target,
				accountKey: best.snapshot.accountKey,
				attemptKey: claudeBlockedAttemptKey(
					best.snapshot.accountKey,
					best.snapshot.credit.id,
					best.snapshot.credit.remainingCount ?? 0,
					best.blockers,
					best.unblockAtMs,
				),
				label: best.snapshot.label,
				availableCount: best.snapshot.availableCount,
				remainingMs: best.remainingMs,
				blockedWindows: best.blockers,
				expiresInMs: expiresAtMs === undefined ? undefined : expiresAtMs - input.nowMs,
				active: best.snapshot.active,
				program: best.snapshot.credit.program ?? "",
				title: best.snapshot.credit.title,
				requiresLimit: best.snapshot.credit.requiresLimit === true,
			};
		}
	}

	const salvages: ClaudeResetAction[] = [];
	if (input.settings.salvageHorizonMs > 0) {
		for (const snapshot of snapshots) {
			if (snapshot.accountKey === restore?.accountKey) continue;
			const skip = (reason: ClaudeResetSkipReason) =>
				skipped.push({ accountKey: snapshot.accountKey, rule: "expiring-credit", reason });
			if (snapshot.credit.program !== CEDAR_PROGRAM) {
				skip("unsupported-program");
				continue;
			}
			const expiresAtMs = creditExpiryMs(snapshot.credit);
			if (
				expiresAtMs === undefined ||
				!Number.isFinite(expiresAtMs) ||
				expiresAtMs <= input.nowMs ||
				expiresAtMs - input.nowMs > input.settings.salvageHorizonMs
			) {
				skip("no-expiring-credit");
				continue;
			}
			const clears = new Set(snapshot.credit.clears ?? []);
			const serverBlockers = snapshot.credit.blocking ?? [];
			if (serverBlockers.some(id => !snapshot.limits.some(limit => limit.id === id))) {
				skip("unsupported-window");
				continue;
			}
			const exhausted = [
				...new Set([...snapshot.limits.filter(isExhausted).map(limit => limit.id), ...serverBlockers]),
			];
			if (exhausted.some(id => !clears.has(id))) {
				skip("incomplete-coverage");
				continue;
			}
			const covered = snapshot.limits.filter(limit => clears.has(limit.id));
			if (covered.length === 0) {
				skip("unsupported-window");
				continue;
			}
			let fullest: { id: string; used: number } | undefined;
			for (const limit of covered) {
				const resolved = resolveUsedFraction(limit);
				const observed = resolved === undefined || !Number.isFinite(resolved) ? 0 : Math.max(0, resolved);
				const server = snapshot.credit.usedFractions?.[limit.id];
				const used = Math.max(observed, typeof server === "number" && Number.isFinite(server) ? server : 0);
				if (!fullest || used > fullest.used) fullest = { id: limit.id, used };
			}
			if (!fullest || fullest.used < SALVAGE_MIN_USED_FRACTION) {
				skip("window-mostly-free");
				continue;
			}
			if (snapshot.credit.requiresLimit === true && serverBlockers.length === 0 && !covered.some(isExhausted)) {
				skip("no-blocked-window");
				continue;
			}
			const attemptKey = claudeSalvageAttemptKey(
				snapshot.accountKey,
				snapshot.credit.id,
				snapshot.credit.remainingCount ?? 0,
				expiresAtMs,
			);
			const episodeSkip = skipForEpisode(input, snapshot.accountKey, attemptKey);
			if (episodeSkip) {
				skip(episodeSkip);
				continue;
			}
			salvages.push({
				reason: "expiring-credit",
				target: snapshot.target,
				accountKey: snapshot.accountKey,
				attemptKey,
				label: snapshot.label,
				availableCount: snapshot.availableCount,
				expiresInMs: expiresAtMs - input.nowMs,
				salvageWindow: fullest.id,
				salvageUsedFraction: fullest.used,
				active: snapshot.active,
				program: snapshot.credit.program,
				title: snapshot.credit.title,
				requiresLimit: snapshot.credit.requiresLimit === true,
			});
		}
		salvages.sort((left, right) => (left.expiresInMs ?? 0) - (right.expiresInMs ?? 0));
	}

	return { actions: restore ? [restore, ...salvages] : salvages, skipped };
}
