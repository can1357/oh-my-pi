/**
 * Saved-reset salvage run by `omp auth-broker serve`, which holds every
 * credential and outlives any session. It plans and spends through the same
 * executor as a session sweep, under the broker host's `codexResets.*` and
 * `claudeResets.*` settings and account policies; with no one to ask, each
 * action spends only what {@link headlessConsentedActions} allows.
 */
import type { AuthStorage, BrokerResetSweep, ResetCreditAccountStatus } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { type AutoResetHost, headlessConsentedActions, sweepResets } from "./auto-reset";
import {
	type CodexAutoRedeemCoordinator,
	createCodexAutoRedeemCoordinator,
	IMMINENT_RESET_EXPIRY_MS,
	SWEEP_MIN_INTERVAL_MS,
} from "./codex-auto-reset";
import { cfgClaudeResetsAutoRedeem, cfgCodexResetsAutoRedeem } from "./settings";

/**
 * Longest wait between broker sweeps. Each sweep reads the broker's cached
 * usage, so an idle broker refreshes usage at most this often for it.
 */
const BROKER_RESET_SWEEP_INTERVAL_MS = 60 * 60_000;

/**
 * Delay until the next broker sweep: {@link BROKER_RESET_SWEEP_INTERVAL_MS}, or
 * the moment the soonest known credit enters its last-chance window, then
 * every {@link SWEEP_MIN_INTERVAL_MS} while it is inside it.
 */
function nextBrokerResetSweepDelayMs(inventory: readonly ResetCreditAccountStatus[], nowMs: number): number {
	let delayMs = BROKER_RESET_SWEEP_INTERVAL_MS;
	for (const status of inventory) {
		for (const credit of status.credits) {
			if ((credit.status ?? "available") !== "available" || !credit.expiresAt) continue;
			const expiresAtMs = Date.parse(credit.expiresAt);
			if (!(expiresAtMs > nowMs)) continue;
			const lastChanceInMs = expiresAtMs - IMMINENT_RESET_EXPIRY_MS - nowMs;
			delayMs = Math.min(delayMs, lastChanceInMs > 0 ? lastChanceInMs : SWEEP_MIN_INTERVAL_MS);
		}
	}
	return delayMs;
}

/** Background salvage loop of one auth broker. */
export class BrokerResetSweeper {
	readonly #host: AutoResetHost;
	readonly #coordinator: CodexAutoRedeemCoordinator;
	/** Credits each account was last seen with; a failed listing keeps the account's last good entry. */
	#inventory: ResetCreditAccountStatus[] = [];
	#timer: NodeJS.Timeout | undefined;
	#closed = false;

	/** `coordinator` isolates tests; the broker process uses a fresh one fenced by the agent database's lock files. */
	constructor(storage: AuthStorage, settings: Settings, coordinator = createCodexAutoRedeemCoordinator()) {
		this.#coordinator = coordinator;
		this.#host = {
			authStorage: storage,
			settings,
			notice: (level, message, source) =>
				level === "info" ? logger.info(message, { source }) : logger.warn(message, { source }),
			adoptedResetMarkers: new Map(),
			confirm: async (_provider, actions) => headlessConsentedActions(actions),
		};
	}

	/** Settles after the first sweep; later sweeps follow on their own timer. */
	start(): Promise<void> {
		return this.#sweep();
	}

	/** Providers this sweep covers, with the broker host's auto-redeem mode for each. */
	sweeps(): BrokerResetSweep[] {
		return (["openai-codex", "anthropic"] as const).flatMap(provider => {
			const autoRedeem = (provider === "anthropic" ? cfgClaudeResetsAutoRedeem : cfgCodexResetsAutoRedeem).get(
				this.#host.settings,
			);
			return autoRedeem === "no" ? [] : [{ provider, autoRedeem }];
		});
	}

	close(): void {
		this.#closed = true;
		clearTimeout(this.#timer);
	}

	async #sweep(): Promise<void> {
		try {
			const reports = (await this.#host.authStorage.usage.reports?.()) ?? [];
			const swept = await sweepResets(this.#host, reports, this.#coordinator);
			const previous = new Map(this.#inventory.map(status => [`${status.provider}|${status.credentialId}`, status]));
			this.#inventory = swept.map(status =>
				status.error ? (previous.get(`${status.provider}|${status.credentialId}`) ?? status) : status,
			);
		} catch (error) {
			logger.warn("auth-broker reset sweep failed", { error: String(error) });
		}
		if (this.#closed) return;
		this.#timer = setTimeout(() => void this.#sweep(), nextBrokerResetSweepDelayMs(this.#inventory, Date.now()));
		this.#timer.unref();
	}
}
