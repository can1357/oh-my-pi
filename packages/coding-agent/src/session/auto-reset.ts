/**
 * Plans and spends saved Codex and Claude resets for one host: an interactive
 * session (salvage sweep and blocked-turn restore) or the auth broker (salvage
 * sweep only). The planners stay pure; this module owns the IO around them.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	AuthStorage,
	OAuthAccountIdentity,
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
	ResetCreditTarget,
	UsageReport,
} from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { formatDuration, getAgentDbPath, isEnoent, logger, withFileLock } from "@oh-my-pi/pi-utils";
import { formatUsageResetWindow } from "@oh-my-pi/pi-tui/overlays/usage-display";
import type { Settings } from "../config/settings";
import {
	type ClaudeResetAction,
	type ClaudeResetPlan,
	claudeResetStatusesFromReports,
	planClaudeResetRedemptions,
} from "./claude-auto-reset";
import {
	ATTEMPT_COOLDOWN_MS,
	type CodexAutoRedeemCoordinator,
	type CodexResetAction,
	type CodexResetPlan,
	type CodexResetTrigger,
	effectiveAutoRedeemMode,
	headlessApprovedResetActions,
	isTerminalRedeemOutcome,
	overlayLiveResetCredits,
	planCodexResetRedemptions,
	REDEEM_RETRY_DEFER_MS,
	resetAccountLockKey,
	shouldEvaluateCodexAutoRedeem,
} from "./codex-auto-reset";
import { cfgClaudeResets, cfgClaudeResetsAutoRedeem, cfgCodexResets, cfgCodexResetsAutoRedeem } from "./settings";

export type ResetProvider = "openai-codex" | "anthropic";
export type ResetAction = CodexResetAction | ClaudeResetAction;

/** What a session or the auth broker supplies to plan and spend saved resets. */
export interface AutoResetHost {
	authStorage: AuthStorage;
	settings: Settings;
	/** Marks the session's active account; the broker has none. */
	sessionId?: string;
	/** Model of the turn a blocked pass restores; background sweeps ignore it. */
	model?: Model;
	baseUrlResolver?: (provider: string) => string | undefined;
	notice: (level: "info" | "warning", message: string, source: string) => void;
	/** Reset markers this host already adopted, so a peer's confirmed reset counts once. */
	adoptedResetMarkers: Map<string, number>;
	/**
	 * Consent: resolves with the planned actions that may be spent. Each action
	 * carries its account's effective mode; `yes` needs no question.
	 */
	confirm: (
		provider: ResetProvider,
		actions: ResetAction[],
		coordinator: CodexAutoRedeemCoordinator,
	) => Promise<readonly ResetAction[]>;
	/** Runs after at least one reset was spent. */
	onRedeemed?: () => void;
}

export function planCodexResets(
	host: AutoResetHost,
	trigger: CodexResetTrigger,
	reports: UsageReport[] | null,
	identity: OAuthAccountIdentity | undefined,
	coordinator: CodexAutoRedeemCoordinator,
	activeBlockUnblockAtMs?: number,
): CodexResetPlan {
	const cfg = cfgCodexResets.get(host.settings);
	const model = host.model;
	const plan = planCodexResetRedemptions({
		nowMs: Date.now(),
		trigger,
		provider: model?.provider ?? "",
		modelId: model?.id ?? "",
		settings: {
			autoRedeem: cfg.autoRedeem,
			minBlockedMinutes: Math.max(0, cfg.minBlockedMinutes),
			keepCredits: Math.max(0, Math.trunc(cfg.keepCredits)),
			salvageHorizonMs: Math.max(0, cfg.salvageHorizonHours) * 3_600_000,
		},
		identity,
		accountPolicy: account => host.authStorage.oauth.policy("openai-codex", account),
		reports,
		attemptedKeys: coordinator.attemptedKeys,
		deferredUntilByKey: coordinator.deferredUntilByKey,
		lastAttemptAtByAccount: coordinator.lastAttemptAtByAccount,
		activeBlockUnblockAtMs,
	});
	if (plan.skipped.length > 0) {
		logger.debug("codex-auto-reset: plan", { trigger, actions: plan.actions.length, skipped: plan.skipped });
	}
	return plan;
}

export function planClaudeResets(
	host: AutoResetHost,
	trigger: CodexResetTrigger,
	reports: UsageReport[] | null,
	statuses: readonly ResetCreditAccountStatus[],
	coordinator: CodexAutoRedeemCoordinator,
	activeBlockUnblockAtMs?: number,
): ClaudeResetPlan {
	const cfg = cfgClaudeResets.get(host.settings);
	const model = host.model;
	const plan = planClaudeResetRedemptions({
		nowMs: Date.now(),
		trigger,
		provider: model?.provider ?? "",
		modelId: model?.provider === "anthropic" ? model.id : "",
		settings: {
			autoRedeem: cfg.autoRedeem,
			minBlockedMinutes: Math.max(0, cfg.minBlockedMinutes),
			keepCredits: Math.max(0, Math.trunc(cfg.keepCredits)),
			salvageHorizonMs: Math.max(0, cfg.salvageHorizonHours) * 3_600_000,
		},
		accountPolicy: account => host.authStorage.oauth.policy("anthropic", account),
		reports,
		statuses,
		attemptedKeys: coordinator.attemptedKeys,
		deferredUntilByKey: coordinator.deferredUntilByKey,
		lastAttemptAtByAccount: coordinator.lastAttemptAtByAccount,
		activeBlockUnblockAtMs,
	});
	if (plan.skipped.length > 0) {
		logger.debug("claude-auto-reset: plan", { trigger, actions: plan.actions.length, skipped: plan.skipped });
	}
	return plan;
}

function resetLockPath(lockKey: string, coordinator: CodexAutoRedeemCoordinator): string {
	return `${coordinator.resetLockPath ?? getAgentDbPath()}.reset-${Bun.hash(lockKey).toString(16)}`;
}

async function readResetMarker(lockPath: string): Promise<{ state: string; atMs: number }> {
	let text: string;
	try {
		text = await Bun.file(lockPath).text();
	} catch (error) {
		if (!isEnoent(error)) throw error;
		text = "";
	}
	const [state, timestamp] = text.split(":");
	return { state, atMs: Number(timestamp) };
}

function adoptResetMarker(host: AutoResetHost, lockKey: string, marker: { state: string; atMs: number }): boolean {
	if (
		marker.state !== "reset" ||
		!Number.isFinite(marker.atMs) ||
		Date.now() - marker.atMs >= ATTEMPT_COOLDOWN_MS ||
		marker.atMs <= (host.adoptedResetMarkers.get(lockKey) ?? 0)
	) {
		return false;
	}
	host.adoptedResetMarkers.set(lockKey, marker.atMs);
	return true;
}

/** Adopt a reset another process confirmed for one of the host model's accounts within the cooldown. */
export async function adoptRecentReset(
	host: AutoResetHost,
	statuses: readonly ResetCreditAccountStatus[],
	coordinator: CodexAutoRedeemCoordinator,
): Promise<boolean> {
	for (const status of statuses) {
		if (status.provider !== host.model?.provider) continue;
		const lockKey = resetAccountLockKey(status);
		if (!lockKey) continue;
		const lockPath = resetLockPath(lockKey, coordinator);
		await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
		const adopted = await withFileLock(
			lockPath,
			async () => adoptResetMarker(host, lockKey, await readResetMarker(lockPath)),
			{ retries: 300, retryDelayMs: 100 },
		);
		if (adopted) {
			await host.authStorage.credentials.revalidate();
			return true;
		}
	}
	return false;
}

/**
 * Shared consume executor for Codex and Claude plans. Attempt keys enter the
 * process-wide set before mutation, while nonterminal outcomes release and
 * defer the episode so a still-banked grant is not buried permanently.
 */
export async function executeResetActions(
	host: AutoResetHost,
	provider: ResetProvider,
	actions: readonly ResetAction[],
	coordinator: CodexAutoRedeemCoordinator,
): Promise<number> {
	const authStorage = host.authStorage;
	const providerLabel = provider === "anthropic" ? "Claude" : "Codex";
	const source = provider === "anthropic" ? "claude-auto-reset" : "codex-auto-reset";
	const autoRedeemSetting = provider === "anthropic" ? cfgClaudeResetsAutoRedeem : cfgCodexResetsAutoRedeem;
	// Consent, earlier actions, the fence and the live listing all wait after
	// planning: a policy or setting that has since turned the account off wins.
	const autoRedeemOff = (target: ResetCreditTarget): boolean => {
		const policy = authStorage.oauth.policy(provider, target);
		return effectiveAutoRedeemMode(autoRedeemSetting.get(host.settings), policy) === "no";
	};
	let redeemed = 0;
	for (const action of actions) {
		if (coordinator.attemptedKeys.has(action.attemptKey)) continue;
		const previousAttemptAt = coordinator.lastAttemptAtByAccount.get(action.accountKey);
		coordinator.attemptedKeys.add(action.attemptKey);
		coordinator.lastAttemptAtByAccount.set(action.accountKey, Date.now());
		let outcome: ResetCreditRedeemOutcome | undefined;
		let sharedReset = false;
		let turnedOff = false;
		try {
			const redeemOptions = {
				target: action.target,
				baseUrlResolver: host.baseUrlResolver,
				// Caller cancellation must not leave an ambiguous consume in flight.
				signal: AbortSignal.timeout(15_000),
			};
			const lockKey = resetAccountLockKey(action.target);
			if (!lockKey) {
				// An account without an upstream identity cannot share a cross-process fence.
				turnedOff = autoRedeemOff(action.target);
				if (!turnedOff) outcome = await authStorage.resets.redeem(redeemOptions);
			} else {
				// The coordinator is process-local. Fence concurrent processes and
				// remember a recent attempt so a late 429 cannot spend again.
				const lockPath = resetLockPath(lockKey, coordinator);
				await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
				outcome = await withFileLock(
					lockPath,
					async () => {
						const marker = await readResetMarker(lockPath);
						if (Date.now() - marker.atMs < ATTEMPT_COOLDOWN_MS) {
							sharedReset = adoptResetMarker(host, lockKey, marker);
							if (sharedReset) await authStorage.credentials.revalidate();
							return undefined;
						}
						// Claude's redeem revalidates its exact offer. Codex needs its
						// balance rechecked after acquiring the cross-process fence.
						if (provider === "openai-codex") {
							const statuses = await authStorage.resets.list({
								provider,
								sessionId: host.sessionId,
								baseUrlResolver: host.baseUrlResolver,
								signal: AbortSignal.timeout(10_000),
							});
							const live = statuses.find(
								status => status.credentialId === action.target.credentialId && !status.error,
							);
							if (!live) {
								return {
									ok: false,
									code: "credit_list_failed",
									provider,
								} satisfies ResetCreditRedeemOutcome;
							}
							if (action.availableCount !== undefined && live.availableCount < action.availableCount) {
								return undefined;
							}
							if (live.availableCount < 1) {
								return { ok: false, code: "no_credit", provider } satisfies ResetCreditRedeemOutcome;
							}
						}
						turnedOff = autoRedeemOff(action.target);
						if (turnedOff) return undefined;
						const attemptedAt = Date.now();
						await Bun.write(lockPath, `pending:${attemptedAt}`);
						const result = await authStorage.resets.redeem(redeemOptions);
						if (result.code === "reset") {
							await Bun.write(lockPath, `reset:${attemptedAt}`);
							host.adoptedResetMarkers.set(lockKey, attemptedAt);
						} else if (result.code === "no_credit" || result.code === "nothing_to_reset") {
							await Bun.write(lockPath, "");
						}
						return result;
					},
					{ retries: 300, retryDelayMs: 100 },
				);
			}
		} catch (error) {
			coordinator.attemptedKeys.delete(action.attemptKey);
			coordinator.deferredUntilByKey.set(action.attemptKey, Date.now() + REDEEM_RETRY_DEFER_MS);
			logger.warn(`${source}: redeem threw, deferred`, {
				account: action.accountKey,
				error: String(error),
			});
			continue;
		}
		if (!outcome) {
			if (sharedReset) redeemed++;
			if (turnedOff) {
				// Never attempted: the episode and cooldown stay free for when it is turned back on.
				coordinator.attemptedKeys.delete(action.attemptKey);
				if (previousAttemptAt === undefined) coordinator.lastAttemptAtByAccount.delete(action.accountKey);
				else coordinator.lastAttemptAtByAccount.set(action.accountKey, previousAttemptAt);
				logger.debug(`${source}: auto-redeem turned off before spending`, { account: action.accountKey });
			}
			continue;
		}
		if (!isTerminalRedeemOutcome(outcome.code)) {
			coordinator.attemptedKeys.delete(action.attemptKey);
			coordinator.deferredUntilByKey.set(action.attemptKey, Date.now() + REDEEM_RETRY_DEFER_MS);
		}
		switch (outcome.code) {
			case "reset": {
				redeemed++;
				const left =
					action.availableCount === undefined ? undefined : ` (${Math.max(0, action.availableCount - 1)} left)`;
				const detail =
					action.reason === "expiring-credit"
						? `it was set to expire in ${formatDuration(action.expiresInMs ?? 0)}`
						: outcome.cleared?.length
							? `cleared ${outcome.cleared.map(formatUsageResetWindow).join(" + ")}; retrying now`
							: "retrying now";
				host.notice(
					"info",
					`Auto-redeemed a saved ${providerLabel} rate-limit reset for ${action.label}${left ?? ""}; ${detail}.`,
					source,
				);
				break;
			}
			case "already_redeemed":
				host.notice(
					"warning",
					`A saved ${providerLabel} reset for ${action.label} was already redeemed elsewhere.`,
					source,
				);
				break;
			case "no_credit":
				logger.debug(`${source}: no_credit (snapshot/live mismatch)`, { account: action.accountKey });
				break;
			case "nothing_to_reset":
				if (action.reason === "blocked-account") {
					host.notice(
						"warning",
						`${providerLabel} reset for ${action.label} reported nothing to reset; will retry later.`,
						source,
					);
				} else {
					logger.debug(`${source}: nothing_to_reset deferred`, { account: action.accountKey });
				}
				break;
			default:
				if (action.reason === "blocked-account") {
					host.notice(
						"warning",
						`${providerLabel} auto-redeem for ${action.label} failed (${outcome.code}); will retry later.`,
						source,
					);
				} else {
					logger.warn(`${source}: consume failed, deferred`, {
						account: action.accountKey,
						code: outcome.code,
					});
				}
				break;
		}
	}
	if (redeemed > 0) host.onRedeemed?.();
	return redeemed;
}

/** Spend the planned actions the host consents to. */
export async function redeemConsentedResets(
	host: AutoResetHost,
	provider: ResetProvider,
	actions: ResetAction[],
	coordinator: CodexAutoRedeemCoordinator,
): Promise<number> {
	return executeResetActions(host, provider, await host.confirm(provider, actions, coordinator), coordinator);
}

/**
 * What a host with no prompt UI may spend: each action under its account's
 * effective mode, so `yes` spends and `unset` spends only a credit about to expire.
 */
export function headlessConsentedActions(actions: readonly ResetAction[]): ResetAction[] {
	return actions.flatMap(action => headlessApprovedResetActions(action.autoRedeem, [action]));
}

/**
 * Whether this host's background sweep covers `provider`'s saved resets: its
 * auto-redeem is not `no` (or an account policy turns it on), and no auth
 * broker it uses sweeps them instead.
 */
export function sweepsResets(host: AutoResetHost, provider: ResetProvider): boolean {
	const mode = (provider === "anthropic" ? cfgClaudeResetsAutoRedeem : cfgCodexResetsAutoRedeem).get(host.settings);
	// A provider-wide `no` still leaves accounts whose policy sets `autoRedeem: true`.
	const enabled = shouldEvaluateCodexAutoRedeem(mode) || host.authStorage.oauth.enablesAutoRedeem(provider);
	return enabled && !host.authStorage.resets.brokerSweeps(provider);
}

/**
 * One salvage sweep over both providers, planned and consented independently.
 * Last-chance expiry checks remain active even with the broader salvage
 * horizon disabled. Every candidate is refreshed through its live listing
 * before spend; a failed listing cannot fall back to stale usage. Claude finds
 * its candidates in the usage reports' reset inventory first, so a sweep with
 * nothing to salvage lists no Claude account. Resolves with the saved-reset
 * inventory the sweep screened.
 */
export async function sweepResets(
	host: AutoResetHost,
	reports: UsageReport[],
	coordinator: CodexAutoRedeemCoordinator,
): Promise<ResetCreditAccountStatus[]> {
	const inventory: ResetCreditAccountStatus[] = [];
	if (sweepsResets(host, "openai-codex") && reports.some(report => report.provider === "openai-codex")) {
		try {
			const statuses = await host.authStorage.resets.list({
				provider: "openai-codex",
				sessionId: host.sessionId,
				baseUrlResolver: host.baseUrlResolver,
				signal: AbortSignal.timeout(10_000),
			});
			inventory.push(...statuses);
			const effectiveReports = overlayLiveResetCredits(reports, statuses);
			const identity = host.authStorage.oauth.identity("openai-codex", host.sessionId);
			const plan = planCodexResets(host, "sweep", effectiveReports, identity, coordinator);
			await redeemConsentedResets(host, "openai-codex", plan.actions, coordinator);
		} catch (error) {
			logger.warn("codex-auto-reset: salvage listing failed", { error: String(error) });
		}
	}
	if (sweepsResets(host, "anthropic") && reports.some(report => report.provider === "anthropic")) {
		try {
			const accounts = host.authStorage.oauth.accounts("anthropic", host.sessionId);
			const reported = claudeResetStatusesFromReports(accounts, reports);
			inventory.push(...reported);
			const candidates = planClaudeResets(host, "sweep", reports, reported, coordinator);
			const plan =
				candidates.actions.length > 0
					? planClaudeResets(
							host,
							"sweep",
							reports,
							await host.authStorage.resets.list({
								provider: "anthropic",
								sessionId: host.sessionId,
								baseUrlResolver: host.baseUrlResolver,
								signal: AbortSignal.timeout(10_000),
							}),
							coordinator,
						)
					: candidates;
			await redeemConsentedResets(host, "anthropic", plan.actions, coordinator);
		} catch (error) {
			logger.warn("claude-auto-reset: salvage listing failed", { error: String(error) });
		}
	}
	return inventory;
}
