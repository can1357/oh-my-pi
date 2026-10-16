import { ASIDE_MESSAGE_COMMIT, ASIDE_MESSAGE_DISCARD, type CommittableAsideMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { StallReminderSettings } from "./settings";
import type { StallReport, StallReportCollector } from "./stall-report";

export interface StallReminderHost {
	createCollector(): Pick<StallReportCollector, "collect" | "dispose">;
	/** Schedule an idle delivery if this host can own an autonomous turn. */
	requestDelivery(): void;
	/** Retry only temporary idle gates; protocol deferral and deliberate user stops stay parked. */
	shouldRetryDelivery?(): boolean;
}

export interface StallReminderClock {
	now(): number;
	/** Return cancellation; scheduling MUST NOT keep an otherwise idle process alive. */
	schedule(callback: () => void, delayMs: number): () => void;
}

const clock: StallReminderClock = {
	now: Date.now,
	schedule(callback, delayMs) {
		const timer = setTimeout(callback, delayMs);
		timer.unref();
		return () => clearTimeout(timer);
	},
};
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DELIVERY_RETRY_DELAY_MS = 1_000;

interface PendingReport {
	report: StallReport;
	generation: number;
	claimed: boolean;
}

/** Main-session-only timer and one-slot, receipt-confirmed reminder delivery. */
export class StallReminderController {
	readonly #host: StallReminderHost;
	readonly #clock: StallReminderClock;
	#settings: StallReminderSettings | undefined;
	#collector: Pick<StallReportCollector, "collect" | "dispose"> | undefined;
	#cancelTimer: (() => void) | undefined;
	#cancelDeliveryRetry: (() => void) | undefined;
	#pending: PendingReport | undefined;
	#generation = 0;
	#collecting = false;
	#suspended = false;
	#disposed = false;

	constructor(host: StallReminderHost, timerClock: StallReminderClock = clock) {
		this.#host = host;
		this.#clock = timerClock;
	}

	configure(settings: StallReminderSettings): void {
		if (this.#disposed) return;
		const previous = this.#settings;
		if (
			previous?.enabled === settings.enabled &&
			previous.intervalMinutes === settings.intervalMinutes &&
			previous.policy === settings.policy
		)
			return;
		this.#settings = settings;
		this.#invalidate();
		if (!settings.enabled) this.#disposeCollector();
		this.#start();
	}

	/** Stop before a transcript transition starts, including same-ID resets and rollback. */
	suspend(): void {
		if (this.#disposed) return;
		this.#suspended = true;
		this.#invalidate();
		this.#disposeCollector();
	}

	/** A settled transition starts a fresh observation baseline and full interval. */
	resume(): void {
		if (this.#disposed) return;
		this.#suspended = false;
		this.#start();
	}

	get hasPending(): boolean {
		return this.#pending !== undefined && !this.#pending.claimed;
	}

	/** Re-arm one bounded retry when a parked report becomes temporarily blocked after collection. */
	retryBlockedDelivery(): void {
		this.#armDeliveryRetry();
	}

	/** Claim once; validate again when the existing agent-core boundary evaluates the thunk. */
	takeAside(): (() => CommittableAsideMessage | null) | undefined {
		const pending = this.#pending;
		if (!pending || pending.claimed || !this.#active(pending.generation)) return undefined;
		return () => {
			if (this.#pending !== pending || pending.claimed || !this.#active(pending.generation)) return null;
			pending.claimed = true;
			this.#cancelDeliveryRetry?.();
			this.#cancelDeliveryRetry = undefined;
			let settled = false;
			const settle = (delivered: boolean) => {
				if (settled) return;
				settled = true;
				if (this.#pending !== pending || !this.#active(pending.generation)) return;
				this.#pending = undefined;
				try {
					if (delivered) pending.report.commit();
				} catch (error) {
					logger.warn("Stall reminder baseline commit failed", { error: String(error) });
				} finally {
					this.#arm();
				}
			};
			return {
				role: "developer",
				content: [{ type: "text", text: pending.report.text }],
				attribution: "agent",
				timestamp: this.#clock.now(),
				synthetic: true,
				userInitiated: false,
				[ASIDE_MESSAGE_COMMIT]: () => settle(true),
				[ASIDE_MESSAGE_DISCARD]: () => settle(false),
			};
		};
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#invalidate();
		this.#disposeCollector();
	}

	#active(generation: number): boolean {
		return !this.#disposed && !this.#suspended && this.#settings?.enabled === true && this.#generation === generation;
	}

	#invalidate(): void {
		this.#generation++;
		this.#cancelTimer?.();
		this.#cancelTimer = undefined;
		this.#cancelDeliveryRetry?.();
		this.#cancelDeliveryRetry = undefined;
		this.#pending = undefined;
	}

	#disposeCollector(): void {
		this.#collector?.dispose();
		this.#collector = undefined;
	}

	#start(): void {
		if (!this.#active(this.#generation)) return;
		this.#collector ??= this.#host.createCollector();
		this.#arm();
	}

	#arm(): void {
		if (!this.#active(this.#generation) || this.#collecting || this.#pending || this.#cancelTimer) return;
		const generation = this.#generation;
		const intervalMs = Math.max(1, Math.min(Number.MAX_VALUE, this.#settings!.intervalMinutes * 60_000));
		const deadline = Math.min(Number.MAX_VALUE, this.#clock.now() + intervalMs);
		const schedule = () => {
			if (!this.#active(generation)) return;
			const remaining = deadline - this.#clock.now();
			if (remaining <= 0) {
				void this.#collect(generation);
				return;
			}
			this.#cancelTimer = this.#clock.schedule(
				() => {
					this.#cancelTimer = undefined;
					schedule();
				},
				Math.min(MAX_TIMER_DELAY_MS, Math.max(1, remaining)),
			);
		};
		schedule();
	}

	#armDeliveryRetry(): void {
		const pending = this.#pending;
		if (
			!pending ||
			pending.claimed ||
			!this.#active(pending.generation) ||
			this.#cancelDeliveryRetry ||
			!this.#host.shouldRetryDelivery?.()
		)
			return;
		this.#cancelDeliveryRetry = this.#clock.schedule(() => {
			this.#cancelDeliveryRetry = undefined;
			if (this.#pending !== pending || pending.claimed || !this.#active(pending.generation)) return;
			if (!this.#host.shouldRetryDelivery?.()) return;
			try {
				this.#host.requestDelivery();
			} catch (error) {
				logger.warn("Stall reminder delivery retry failed", { error: String(error) });
			} finally {
				this.#armDeliveryRetry();
			}
		}, DELIVERY_RETRY_DELAY_MS);
	}

	async #collect(generation: number): Promise<void> {
		if (!this.#active(generation) || this.#collecting || this.#pending) return;
		const collector = this.#collector;
		if (!collector) return;
		this.#collecting = true;
		try {
			const report = await collector.collect();
			if (!this.#active(generation) || collector !== this.#collector) return;
			if (this.#settings?.policy === "unfinished-only" && !report.hasUnfinishedWork) return;
			this.#pending = { report, generation, claimed: false };
			this.#host.requestDelivery();
		} catch (error) {
			if (this.#active(generation)) {
				this.#pending = undefined;
				logger.warn("Stall reminder assessment failed", { error: String(error) });
			}
		} finally {
			this.#collecting = false;
			this.#armDeliveryRetry();
			this.#arm();
		}
	}
}
