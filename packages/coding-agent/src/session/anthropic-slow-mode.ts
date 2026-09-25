/**
 * Anthropic subscription slow mode — omp's port of Claude Code's `/low-priority`,
 * enabled on Anthropic models by `/slow on` (`providers.anthropic.slowMode: auto`).
 *
 * When a Claude subscription hits its 5-hour session limit and Anthropic offers
 * the slow lane (`anthropic-ratelimit-unified-slow-offer: treatment`), requests
 * may continue on spare capacity by sending `anthropic-usage-limit: slow` until
 * the limit resets. Weekly usage still counts; responses may pause while the
 * server has no spare capacity (429 `slot_busy` / 529), which this controller
 * turns into server-paced waits bounded by the server's max-wait budget.
 *
 * State is per Claude account lane ({@link AnthropicSlowModeLanes}): the main
 * agent, subagents, and advisors on one account share its wall and offer, while
 * requests served by another account never see them. Auto-accept policy and
 * notices stay with the requesting session.
 */
import type {
	AnthropicSlowModeFailure,
	AnthropicSlowModeHooks,
	AnthropicSlowModeRetry,
	AnthropicSlowModeSignal,
	Model,
} from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { AuthStorage } from "./auth-storage";

/** Why an active slow-mode window ended. */
export type AnthropicSlowModeEndReason =
	| "reset"
	| "user"
	| "weekly"
	| "budget"
	| "off"
	| "ineligible"
	| "wall"
	| "max_wait"
	| "extra_usage";

/** Result of asking for the slow lane now (`/slow on` or auto-accept). */
export type AnthropicSlowModeAvailability =
	| { kind: "available"; resetsAtSec: number; resume: boolean }
	| { kind: "unavailable"; reason: string };

type NoticeLevel = "info" | "warning" | "error";

/** Per-session wiring for {@link AnthropicSlowModeLanes.hooks}. */
export interface AnthropicSlowModeHookOptions {
	/**
	 * Final gate before auto-accepting (e.g. prefer rotating to a sibling
	 * account with headroom). Omitted means always accept.
	 */
	canAutoAccept?: () => boolean | Promise<boolean>;
	/** Surface a user-facing notice on the requesting session. */
	notify?: (level: NoticeLevel, message: string) => void;
}

type Phase =
	| { kind: "idle" }
	| { kind: "active"; resetsAtSec: number; acceptedAtMs: number; requestsServed: number; requestsStandard: number };

// Server-directed timing is clamped to the same bounds Claude Code applies.
const DEFAULT_RETRY_AFTER_MS = 20_000;
const MIN_RETRY_AFTER_MS = 5_000;
const MAX_RETRY_AFTER_MS = 600_000;
const DEFAULT_MAX_WAIT_MS = 1_200_000;
const MIN_MAX_WAIT_MS = 60_000;
const MAX_MAX_WAIT_MS = 21_600_000;
/** After giving up on capacity, don't re-offer the lane for this long. */
const MAX_WAIT_COOLOFF_MS = 10 * 60_000;
/** The 5-hour reset must move this far past the accepted window to count as a new window. */
const RESET_GRACE_SEC = 60;
/** ±30% jitter keeps concurrent waiters from retrying in lockstep. */
const RETRY_JITTER = 0.3;
/** Upper bound on a budget-exhausted block (8 days) when the reset header is absurd. */
const MAX_BUDGET_BLOCK_SEC = 691_200;

/** Local wall-clock `HH:MM` for an epoch-seconds reset. */
export function formatSlowModeResetClock(resetsAtSec: number): string {
	return new Date(resetsAtSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const END_NOTICES: Record<AnthropicSlowModeEndReason, { level: NoticeLevel; message: string } | undefined> = {
	reset: { level: "info", message: "Claude session limit reset — lower-priority mode ended." },
	user: undefined,
	weekly: {
		level: "warning",
		message: "Lower-priority mode ended: the weekly Claude limit is reached.",
	},
	budget: {
		level: "warning",
		message: "Lower-priority mode ended: this week's lower-priority allowance is used up.",
	},
	off: { level: "warning", message: "Lower-priority mode ended: Anthropic turned it off for this account." },
	ineligible: { level: "warning", message: "Lower-priority mode ended: this account is no longer eligible." },
	wall: { level: "warning", message: "Lower-priority mode ended: Anthropic stopped serving the slow lane." },
	max_wait: {
		level: "warning",
		message: "Lower-priority mode paused for 10 minutes after waiting too long for spare capacity.",
	},
	extra_usage: { level: "info", message: "Lower-priority mode ended: extra usage is now serving requests." },
};

/** Slow-mode state machine for one Claude account lane; see the module docs. */
export class AnthropicSlowModeController {
	#phase: Phase = { kind: "idle" };
	/** Latest `treatment` offer seen on a session-limit 429, keyed by its reset. */
	#offerResetsAtSec: number | undefined;
	/** Reset of the window the user explicitly stopped; allows `/slow on` to resume it. */
	#stoppedResetsAtSec: number | undefined;
	#coolingOffUntilMs: number | undefined;
	/** Weekly limit or spent allowance: no re-entry until the reported reset. */
	#blocked: { reason: "weekly" | "budget"; untilSec: number } | undefined;
	#budgetUtilization: number | undefined;
	#retryAfterMs = DEFAULT_RETRY_AFTER_MS;
	#maxWaitMs = DEFAULT_MAX_WAIT_MS;

	/** Whether requests currently carry the slow header. Expires the window once its limit resets. */
	isActive(now = Date.now()): boolean {
		const phase = this.#phase;
		if (phase.kind !== "active") return false;
		if (now >= (phase.resetsAtSec + RESET_GRACE_SEC) * 1000) {
			this.stop("reset");
			return false;
		}
		return true;
	}

	/** Reset time (epoch seconds) of the active window, if any. */
	activeResetsAtSec(now = Date.now()): number | undefined {
		return this.isActive(now) && this.#phase.kind === "active" ? this.#phase.resetsAtSec : undefined;
	}

	/** Percent of the weekly slow-lane allowance still available, when the server reported it. */
	allowanceLeftPercent(): number | undefined {
		const used = this.#budgetUtilization;
		return used === undefined ? undefined : Math.min(100, Math.max(0, 100 - Math.round(used * 100)));
	}

	/** Compact status-line label, or `undefined` when inactive. */
	statusLabel(now = Date.now()): string | undefined {
		const resetsAtSec = this.activeResetsAtSec(now);
		if (resetsAtSec === undefined) return undefined;
		const left = this.allowanceLeftPercent();
		return `low priority until ${formatSlowModeResetClock(resetsAtSec)}${left === undefined ? "" : ` · ${left}% left`}`;
	}

	/** Whether the slow lane can be entered now, and on which window. */
	availability(now = Date.now()): AnthropicSlowModeAvailability {
		if (this.isActive(now)) return { kind: "unavailable", reason: "Lower-priority mode is already on." };
		const blocked = this.#blocked;
		if (blocked !== undefined && now < blocked.untilSec * 1000) {
			return {
				kind: "unavailable",
				reason:
					blocked.reason === "budget"
						? "This week's lower-priority allowance is used up. It is offered again after your weekly limit resets."
						: `Your weekly Claude limit is reached; lower-priority mode is unavailable until it resets at ${formatSlowModeResetClock(blocked.untilSec)}.`,
			};
		}
		if (this.#coolingOffUntilMs !== undefined && now < this.#coolingOffUntilMs) {
			return {
				kind: "unavailable",
				reason: `Lower-priority mode is taking a break until ${formatSlowModeResetClock(Math.ceil(this.#coolingOffUntilMs / 1000))} after waiting too long for spare capacity.`,
			};
		}
		const stopped = this.#stoppedResetsAtSec;
		if (stopped !== undefined && stopped * 1000 > now)
			return { kind: "available", resetsAtSec: stopped, resume: true };
		const offer = this.#offerResetsAtSec;
		if (offer !== undefined && offer * 1000 > now) return { kind: "available", resetsAtSec: offer, resume: false };
		return {
			kind: "unavailable",
			reason:
				"Lower-priority mode isn't available right now. Anthropic offers it after a Claude subscription reaches its session limit.",
		};
	}

	/** Enter the slow lane if {@link availability} allows it. */
	accept(now = Date.now()): AnthropicSlowModeAvailability {
		const availability = this.availability(now);
		if (availability.kind === "available") this.#activate(availability.resetsAtSec, now);
		return availability;
	}

	/** End the active window. Returns false when nothing was active. */
	stop(reason: AnthropicSlowModeEndReason, now = Date.now()): boolean {
		const phase = this.#phase;
		if (phase.kind !== "active") {
			if (reason !== "user") this.#stoppedResetsAtSec = undefined;
			return false;
		}
		if (reason === "max_wait") this.#coolingOffUntilMs = now + MAX_WAIT_COOLOFF_MS;
		// Only a user stop or a capacity cool-off keeps the window's offer usable;
		// every server-driven end needs a fresh offer before the lane reopens.
		if (reason !== "user" && reason !== "max_wait") this.#offerResetsAtSec = undefined;
		this.#stoppedResetsAtSec = reason === "user" ? phase.resetsAtSec : undefined;
		this.#phase = { kind: "idle" };
		return true;
	}

	/** Test seam: drop all state. */
	reset(): void {
		this.#phase = { kind: "idle" };
		this.#offerResetsAtSec = undefined;
		this.#stoppedResetsAtSec = undefined;
		this.#coolingOffUntilMs = undefined;
		this.#blocked = undefined;
		this.#budgetUtilization = undefined;
		this.#retryAfterMs = DEFAULT_RETRY_AFTER_MS;
		this.#maxWaitMs = DEFAULT_MAX_WAIT_MS;
	}

	#activate(resetsAtSec: number, now: number): void {
		this.#stoppedResetsAtSec = undefined;
		this.#phase = { kind: "active", resetsAtSec, acceptedAtMs: now, requestsServed: 0, requestsStandard: 0 };
	}

	#end(reason: AnthropicSlowModeEndReason, options: AnthropicSlowModeHookOptions): void {
		if (!this.stop(reason)) return;
		const notice = END_NOTICES[reason];
		if (notice) options.notify?.(notice.level, notice.message);
	}

	/** Adopt server-stated retry pacing and allowance usage. */
	#applyTiming(signal: AnthropicSlowModeSignal | undefined): void {
		if (!signal) return;
		if (signal.retryAfterMs !== undefined) {
			this.#retryAfterMs = Math.min(
				MAX_RETRY_AFTER_MS,
				Math.max(MIN_RETRY_AFTER_MS, Math.round(signal.retryAfterMs)),
			);
		}
		if (signal.maxWaitMs !== undefined) {
			this.#maxWaitMs = Math.min(MAX_MAX_WAIT_MS, Math.max(MIN_MAX_WAIT_MS, Math.round(signal.maxWaitMs)));
		}
		if (signal.budgetUtilization !== undefined) this.#budgetUtilization = signal.budgetUtilization;
	}

	/** Observe a successful response's slow-lane headers on this lane. */
	observe(signal: AnthropicSlowModeSignal, options: AnthropicSlowModeHookOptions): void {
		const phase = this.#phase;
		if (phase.kind !== "active") return;
		if (signal.fiveHourResetAtSec !== undefined && signal.fiveHourResetAtSec >= phase.resetsAtSec + RESET_GRACE_SEC) {
			this.#end("reset", options);
			return;
		}
		if (signal.status === "active") {
			this.#applyTiming(signal);
			phase.requestsServed++;
		} else if (signal.status === "not_needed") {
			this.#applyTiming(signal);
			phase.requestsStandard++;
		} else if (signal.status === "ineligible" && signal.overageInUse) {
			this.#end("extra_usage", options);
		}
	}

	/** Map a 429 slow status to the reason the window must end, or null to keep going. */
	#endReasonFor(signal: AnthropicSlowModeSignal | undefined): AnthropicSlowModeEndReason | null {
		switch (signal?.status) {
			case "weekly_limit":
				return "weekly";
			case "budget_exhausted":
				return "budget";
			case "off":
				return "off";
			case "ineligible":
				return signal.overageInUse ? "extra_usage" : "ineligible";
			case "slot_busy":
				return null;
			default:
				return signal?.unifiedLimitClaim ? "wall" : null;
		}
	}

	/** Decide how to react to a pre-content failure on this lane (see {@link AnthropicSlowModeHooks.onFailure}). */
	async onFailure(
		failure: AnthropicSlowModeFailure,
		options: AnthropicSlowModeHookOptions,
	): Promise<AnthropicSlowModeRetry | undefined> {
		const now = Date.now();
		const signal = failure.signal;
		const rateLimited = failure.httpStatus === 429;

		if (!failure.sentSlow) {
			if (!rateLimited) return undefined;
			// Another request activated the lane while this one was in flight.
			if (this.isActive(now)) return { delayMs: 0, capacityWait: false };
			if (signal?.offer !== "treatment" || signal.unifiedResetAtSec === undefined) return undefined;
			if (signal.unifiedResetAtSec * 1000 <= now) return undefined;
			this.#offerResetsAtSec = signal.unifiedResetAtSec;
			// An explicit `/slow off` stop holds for the rest of that window.
			if (this.#stoppedResetsAtSec === signal.unifiedResetAtSec) return undefined;
			if (this.availability(now).kind !== "available") return undefined;
			if (options.canAutoAccept && !(await options.canAutoAccept())) return undefined;
			// A concurrent request may have taken the lane during the await.
			if (this.isActive()) return { delayMs: 0, capacityWait: false };
			if (this.accept().kind !== "available") return undefined;
			this.#applyTiming(signal);
			options.notify?.(
				"info",
				`Claude session limit reached — continuing at lower priority until ${formatSlowModeResetClock(signal.unifiedResetAtSec)}. Your weekly limit still applies and responses may pause while waiting for spare capacity. Run /slow off to stop.`,
			);
			return { delayMs: 0, capacityWait: false };
		}

		if (!this.isActive(now)) return undefined;
		if (rateLimited) {
			const endReason = this.#endReasonFor(signal);
			if (endReason !== null) {
				if (endReason === "budget" || endReason === "weekly") {
					// Block re-entry until the reported reset; stale offers must not revive the lane.
					const resetSec =
						endReason === "budget"
							? (signal?.budgetResetAtSec ?? signal?.weeklyResetAtSec)
							: (signal?.weeklyResetAtSec ?? signal?.unifiedResetAtSec);
					this.#blocked = {
						reason: endReason,
						untilSec:
							resetSec !== undefined && resetSec > 0
								? Math.round(Math.min(resetSec, now / 1000 + MAX_BUDGET_BLOCK_SEC))
								: Math.round(now / 1000 + MAX_BUDGET_BLOCK_SEC),
					};
				}
				this.#end(endReason, options);
				return undefined;
			}
		}
		this.#applyTiming(signal);
		const slotBusy = rateLimited && signal?.status === "slot_busy";
		const capacityBusy = failure.overloaded && (signal?.status === undefined || signal.status === "active");
		if (!slotBusy && !capacityBusy) return undefined;
		const remainingMs = this.#maxWaitMs - failure.waitedMs;
		if (remainingMs <= 0) {
			this.#end("max_wait", options);
			return undefined;
		}
		// Never sleep past the server's max-wait budget; the next failure after
		// a clamped wait ends the lane instead.
		const jitter = 1 + (Math.random() * 2 - 1) * RETRY_JITTER;
		const delayMs = Math.min(remainingMs, Math.round(this.#retryAfterMs * jitter));
		if (failure.attempts === 0) {
			options.notify?.(
				"info",
				`Working at lower priority — waiting for spare capacity (next try in ${Math.max(1, Math.round(delayMs / 1000))}s).`,
			);
		}
		return { delayMs, capacityWait: true };
	}
}

/**
 * Slow-lane state keyed by Claude account (`cred:<id>` / `key:<hash>`, see
 * {@link AnthropicSlowModeHooks}): one account's wall, offer, and waits never
 * leak into requests served by another. Process-wide so the main agent,
 * subagents, and advisors on the same account share one lane.
 */
export class AnthropicSlowModeLanes {
	#lanes = new Map<string, AnthropicSlowModeController>();

	/** The lane for `key`, created on first use. */
	lane(key: string): AnthropicSlowModeController {
		let lane = this.#lanes.get(key);
		if (!lane) {
			lane = new AnthropicSlowModeController();
			this.#lanes.set(key, lane);
		}
		return lane;
	}

	/**
	 * Build provider hooks for one request. `options` scopes auto-accept gating
	 * and notices to the requesting session; `onLane` reports which account
	 * lane served it so the session's `/slow` and status line follow it.
	 */
	hooks(options: AnthropicSlowModeHookOptions & { onLane?: (lane: string) => void }): AnthropicSlowModeHooks {
		return {
			isActive: lane => this.lane(lane).isActive(),
			observe: (signal, lane) => {
				options.onLane?.(lane);
				this.lane(lane).observe(signal, options);
			},
			onFailure: failure => {
				options.onLane?.(failure.lane);
				return this.lane(failure.lane).onFailure(failure, options);
			},
		};
	}
}

/** The process-wide lane registry shared by every session in this process. */
export const anthropicSlowModeLanes = new AnthropicSlowModeLanes();

/**
 * Auto-accept gate: take the slow lane only when no sibling Claude OAuth
 * account has full-speed headroom. With one account there is nothing to
 * rotate to; with several, turn recovery's credential rotation wins while any
 * other account is still healthy. A failed health probe accepts — the user
 * opted in and the alternative is waiting for the reset.
 */
export async function anthropicSlowModeHasNoSiblingHeadroom(
	authStorage: AuthStorage,
	model: Model,
	sessionId: string | undefined,
): Promise<boolean> {
	const oauthAccounts = authStorage.credentials
		.list(model.provider)
		.filter(entry => entry.credential.type === "oauth").length;
	if (oauthAccounts <= 1) return true;
	try {
		const health = await authStorage.health.model(model.provider, {
			modelId: model.id,
			sessionId,
			baseUrl: model.baseUrl,
			reserveFraction: 0,
			signal: AbortSignal.timeout(5_000),
		});
		return !health.accounts.some(account => account.selected !== true && account.state === "healthy");
	} catch (error) {
		logger.debug("anthropic slow mode: sibling health probe failed", { error: String(error) });
		return true;
	}
}
