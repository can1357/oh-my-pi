import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { SessionManager } from "../session/session-manager";

/** Wakeups have their own small quota; sleeping timers never occupy execution slots. */
export const MAX_WAKEUPS = 8;
/** Conditional commands run for at most ten seconds and retain no output, only a SHA-256 digest. */
export const WAKEUP_CHECK_TIMEOUT_MS = 10_000;
export const WAKEUP_CHECK_MAX_BYTES = 8_192;
export const WAKEUP_ENTRY_TYPE = "wakeup-state";

/** A one-shot checkback, optionally polling against an explicitly captured baseline. */
export interface WakeupInput {
	delaySeconds: number;
	prompt: string;
	check?: { command: string; maxWaitSeconds: number };
}

/** Hash-only execution result; command output and exception messages must never enter the journal. */
export interface WakeupCheckResult {
	hash: string;
	exitCode?: number;
	timedOut?: boolean;
	overflow?: boolean;
}

export type WakeupReason = "delay" | "changed" | "deadline" | "check_error" | "check_timeout" | "check_output_limit";

/** Persisted owner identity prevents copied/forked transcripts from inheriting a timer. */
export interface WakeupRecord extends WakeupInput {
	version: 1;
	id: string;
	owner: string;
	cwd: string;
	createdAt: number;
	dueAt: number;
	deadline?: number;
	baseline?: string;
	state: "scheduled" | "cancelled" | "claimed";
	reason?: WakeupReason;
}

/** Delivery is claimed durably before enqueue: at most one attempt, not exactly-once across crashes. */
export interface WakeupDelivery {
	record: WakeupRecord;
	reason: WakeupReason;
	epoch: number;
}

/** Injectable clock and journal support non-provider lifecycle tests and embeddings. */
export interface WakeupHost {
	journal: Pick<SessionManager, "getSessionId" | "getEntries" | "appendCustomEntry" | "ensureOnDisk" | "flush">;
	cwd(): string;
	enabled(): boolean;
	/** Production hosts must hold a strict cross-process lease; omitted only for injected test journals. */
	claimOwnership?(): () => void;
	/** Reconcile the latest durable journal while the strict lease is held, preserving the selected branch. */
	refreshJournal?(): Promise<void>;
	check(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<WakeupCheckResult>;
	deliver(delivery: WakeupDelivery): Promise<void>;
	now?(): number;
	setTimer?(callback: () => void, delayMs: number): unknown;
	clearTimer?(timer: unknown): void;
}

interface LiveWakeup {
	record: WakeupRecord;
	epoch: number;
	controller: AbortController;
	timer?: unknown;
	accepted: boolean;
}

/** Validate even direct SDK invocations; schema validation is not a security boundary. */
export function validateWakeupInput(input: WakeupInput): void {
	if (!Number.isInteger(input.delaySeconds) || input.delaySeconds < 1 || input.delaySeconds > 86_400)
		throw new Error("delaySeconds must be an integer from 1 through 86400");
	if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 8_000)
		throw new Error("prompt must be self-contained, nonblank, and at most 8000 characters");
	if (input.check !== undefined) {
		if (typeof input.check.command !== "string" || !input.check.command.trim() || input.check.command.length > 4_000)
			throw new Error("check.command must be nonblank and at most 4000 characters");
		if (
			!Number.isInteger(input.check.maxWaitSeconds) ||
			input.check.maxWaitSeconds < input.delaySeconds ||
			input.check.maxWaitSeconds > 86_400
		)
			throw new Error("check.maxWaitSeconds must be an integer from delaySeconds through 86400");
	}
}

function readRecord(value: unknown): WakeupRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as WakeupRecord;
	try {
		validateWakeupInput(record);
	} catch {
		return undefined;
	}
	if (
		record.version !== 1 ||
		typeof record.id !== "string" ||
		!/^wake_[a-f0-9]{1,64}$/.test(record.id) ||
		typeof record.owner !== "string" ||
		!record.owner ||
		typeof record.cwd !== "string" ||
		!record.cwd ||
		!Number.isSafeInteger(record.createdAt) ||
		record.createdAt < 0 ||
		!Number.isSafeInteger(record.dueAt) ||
		record.dueAt < record.createdAt ||
		record.dueAt > 8_640_000_000_000_000 ||
		!["scheduled", "cancelled", "claimed"].includes(record.state) ||
		(record.reason !== undefined &&
			!["delay", "changed", "deadline", "check_error", "check_timeout", "check_output_limit"].includes(
				record.reason,
			)) ||
		(record.check &&
			(typeof record.deadline !== "number" ||
				record.deadline !== record.createdAt + record.check.maxWaitSeconds * 1000 ||
				record.dueAt > record.deadline ||
				typeof record.baseline !== "string" ||
				record.baseline.length > 128))
	)
		return undefined;
	return record;
}

/**
 * Cancel every pending wakeup a journal carries for its own session id. A journal that arrives from
 * elsewhere (`omp session unpack`) is data, not local intent: its saved timers, and above all their
 * check commands, must never run without the local user having scheduled them. Returns the count.
 */
export function cancelPendingWakeups(
	journal: Pick<SessionManager, "getSessionId" | "getEntries" | "appendCustomEntry">,
): number {
	const owner = journal.getSessionId();
	const latest = new Map<string, WakeupRecord>();
	for (const entry of journal.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== WAKEUP_ENTRY_TYPE) continue;
		const record = readRecord(entry.data);
		if (record?.owner === owner) latest.set(record.id, record);
	}
	let cancelled = 0;
	for (const record of latest.values()) {
		if (record.state !== "scheduled") continue;
		journal.appendCustomEntry(WAKEUP_ENTRY_TYPE, { ...record, state: "cancelled" } satisfies WakeupRecord);
		cancelled++;
	}
	return cancelled;
}

function checkFailure(result: WakeupCheckResult): WakeupReason | undefined {
	if (result.overflow) return "check_output_limit";
	if (result.timedOut) return "check_timeout";
	if (result.exitCode !== 0) return "check_error";
	return undefined;
}

const activeOwners = new Map<string, WakeupManager>();

/** Session-owned durable timers. Leaving a session suspends rather than cancels its journal. */
export class WakeupManager {
	readonly #host: WakeupHost;
	readonly #live = new Map<string, LiveWakeup>();
	readonly #records = new Map<string, WakeupRecord>();
	#epoch = 0;
	#owner: string | undefined;
	#retryOwner: string | undefined;
	#ready = false;
	#activation: Promise<void> | undefined;
	#lease: Promise<void> | undefined;
	#releaseLease: (() => void) | undefined;
	// Only one conditional shell check may run in this session at a time.
	#checkTail: Promise<void> = Promise.resolve();

	constructor(host: WakeupHost) {
		this.#host = host;
	}

	/** Resume only this exact persistent session, after acquiring its writer lease. */
	activate(): Promise<void> {
		const activation = this.#activate();
		this.#activation = activation;
		return activation;
	}

	async #activate(): Promise<void> {
		this.suspend();
		this.#records.clear();
		if (!this.#host.enabled()) return;
		const epoch = this.#epoch;
		const owner = this.#host.journal.getSessionId();
		if (activeOwners.has(owner)) {
			this.#retryOwner = owner;
			return;
		}
		activeOwners.set(owner, this);
		this.#owner = owner;
		try {
			await this.#claimLease(owner, epoch);
			if (!this.#activationCurrent(owner, epoch)) return;
			// Whole journal, not selected branch: rewinding cannot resurrect cancellation.
			for (const entry of this.#host.journal.getEntries()) {
				if (entry.type !== "custom" || entry.customType !== WAKEUP_ENTRY_TYPE) continue;
				const record = readRecord(entry.data);
				if (record?.owner === owner) this.#records.set(record.id, record);
			}
			if (!this.#activationCurrent(owner, epoch)) return;
			this.#ready = true;
			for (const record of this.#records.values()) {
				if (record.state !== "scheduled") continue;
				if (this.#live.size >= MAX_WAKEUPS) {
					await this.#persist({ ...record, state: "cancelled" });
					continue;
				}
				const live = this.#makeLive(record);
				live.accepted = true;
				this.#arm(live);
			}
		} catch (error) {
			if (epoch !== this.#epoch) return;
			this.suspend();
			if (this.#host.enabled() && this.#host.journal.getSessionId() === owner) this.#retryOwner = owner;
			throw error;
		} finally {
			if (epoch === this.#epoch && !this.#isOwner(owner)) this.suspend();
		}
	}

	/** Invalidate callbacks synchronously; saved schedules survive session transitions. */
	suspend(): void {
		this.#retryOwner = undefined;
		if (this.#owner && activeOwners.get(this.#owner) === this) activeOwners.delete(this.#owner);
		// A tool call not yet accepted must not become a surprise timer after restart.
		for (const live of this.#live.values()) {
			if (
				!live.accepted &&
				this.#records.get(live.record.id)?.state === "scheduled" &&
				this.#host.journal.getSessionId() === live.record.owner
			) {
				const cancelled: WakeupRecord = { ...live.record, state: "cancelled" };
				this.#records.set(cancelled.id, cancelled);
				this.#host.journal.appendCustomEntry(WAKEUP_ENTRY_TYPE, cancelled);
			}
		}
		this.#ready = false;
		this.#epoch++;
		this.#owner = undefined;
		for (const live of this.#live.values()) {
			this.#clearTimer(live);
			live.controller.abort();
		}
		this.#live.clear();
		this.#lease = undefined;
		this.#releaseLease?.();
		this.#releaseLease = undefined;
	}

	/** Snapshots exposed through proc:// cannot mutate the scheduler. */
	list(state?: WakeupRecord["state"]): WakeupRecord[] {
		if (!this.#owner || !this.#isOwner(this.#owner)) return [];
		const records: WakeupRecord[] = [];
		for (const record of this.#records.values()) {
			if (state === undefined || record.state === state) records.push(structuredClone(record));
		}
		return records;
	}

	/** Drop enqueued delivery after an owner/activation change. Claimed attempts cannot be cancelled. */
	isCurrent(delivery: WakeupDelivery): boolean {
		return (
			delivery.epoch === this.#epoch &&
			this.#isOwner(delivery.record.owner) &&
			this.#records.get(delivery.record.id)?.state === "claimed"
		);
	}

	/** Reserve capacity before baseline execution; acceptance follows durable scheduling. */
	async schedule(input: WakeupInput, signal?: AbortSignal): Promise<WakeupRecord> {
		let epoch = this.#epoch;
		let owner = this.#owner;
		const sessionId = this.#host.journal.getSessionId();
		try {
			await this.#activation;
		} catch (error) {
			// A completed startup attempt may have failed transiently (for example
			// while another process held the lease). Retry only for the same idle,
			// enabled owner; never cross a concurrent session transition.
			if (owner || epoch !== this.#epoch || this.#retryOwner !== sessionId || !this.#host.enabled()) throw error;
		}
		if (epoch !== this.#epoch || owner !== this.#owner || sessionId !== this.#host.journal.getSessionId())
			throw new Error("Wakeup owner changed while restoring schedules");
		validateWakeupInput(input);
		signal?.throwIfAborted();
		if (!owner && this.#retryOwner === sessionId && this.#host.enabled()) {
			const activation = this.activate();
			epoch = this.#epoch;
			owner = this.#owner;
			await activation;
			if (epoch !== this.#epoch || owner !== this.#owner || sessionId !== this.#host.journal.getSessionId())
				throw new Error("Wakeup owner changed while retrying activation");
		}
		if (!this.#owner || !this.#isOwner(this.#owner))
			throw new Error("Wakeups require the owning persistent interactive session");
		if (this.#live.size >= MAX_WAKEUPS)
			throw new Error(`Wakeup quota reached (${MAX_WAKEUPS}); cancel an existing timer first`);
		signal?.throwIfAborted();
		const admittedOwner = this.#owner;
		const now = this.#now();
		const record: WakeupRecord = {
			delaySeconds: input.delaySeconds,
			prompt: input.prompt,
			...(input.check
				? { check: { command: input.check.command, maxWaitSeconds: input.check.maxWaitSeconds } }
				: {}),
			version: 1,
			id: `wake_${Bun.randomUUIDv7().replaceAll("-", "")}`,
			owner: admittedOwner,
			cwd: this.#host.cwd(),
			createdAt: now,
			dueAt: now + input.delaySeconds * 1000,
			state: "scheduled",
			...(input.check ? { deadline: now + input.check.maxWaitSeconds * 1000, baseline: "" } : {}),
		};
		await this.#claimLease(admittedOwner, epoch);
		if (epoch !== this.#epoch || !this.#isOwner(admittedOwner))
			throw new Error("Wakeup owner changed before acquiring its writer lease");
		if (this.#live.size >= MAX_WAKEUPS)
			throw new Error(`Wakeup quota reached (${MAX_WAKEUPS}); cancel an existing timer first`);
		signal?.throwIfAborted();
		const live = this.#makeLive(record);
		const abort = () => live.controller.abort(signal?.reason);
		signal?.addEventListener("abort", abort, { once: true });
		try {
			if (record.check) {
				const result = await this.#runCheck(live);
				this.#assertLive(live);
				record.baseline = `${result.exitCode}:${result.hash}`;
				record.reason =
					record.deadline !== undefined && this.#now() >= record.deadline ? "deadline" : checkFailure(result);
				if (record.reason) record.dueAt = Math.min(this.#now(), record.deadline!);
			}
			this.#assertLive(live);
			await this.#persist(record);
			this.#assertLive(live);
			live.accepted = true;
			this.#arm(live);
			return structuredClone(record);
		} catch (error) {
			this.#clearTimer(live);
			live.controller.abort();
			if (this.#live.get(record.id) === live) this.#live.delete(record.id);
			// A scheduling write may have reached disk before an abort or switch. Tombstone it before failing.
			if (this.#isOwner(record.owner) && this.#records.has(record.id)) {
				try {
					await this.#persist({ ...record, state: "cancelled" });
				} catch (cancellationError) {
					throw new AggregateError(
						[error, cancellationError],
						"Scheduling failed and wakeup cancellation could not be confirmed",
					);
				}
			}
			throw error;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	#claimLease(owner: string, epoch: number): Promise<void> {
		if (!this.#lease) {
			this.#lease = this.#takeLease(owner, epoch).catch(error => {
				if (epoch === this.#epoch) {
					this.#lease = undefined;
					this.#releaseLease?.();
					this.#releaseLease = undefined;
				}
				throw error;
			});
		}
		return this.#lease;
	}

	async #takeLease(owner: string, epoch: number): Promise<void> {
		// Acquire before reading the journal: a manager loaded while another owner
		// was alive may otherwise replay a timer it subsequently cancelled or claimed.
		this.#releaseLease = this.#host.claimOwnership?.();
		await this.#host.refreshJournal?.();
		if (
			epoch !== this.#epoch ||
			this.#owner !== owner ||
			!this.#host.enabled() ||
			this.#host.journal.getSessionId() !== owner
		)
			throw new Error("Could not acquire exclusive wakeup session ownership");
	}

	#activationCurrent(owner: string, epoch: number): boolean {
		return (
			epoch === this.#epoch &&
			this.#owner === owner &&
			this.#host.enabled() &&
			this.#host.journal.getSessionId() === owner
		);
	}

	/** Persist cancellation before reporting success. A claimed delivery attempt is irrevocable. */
	async cancel(id: string): Promise<boolean> {
		const record = this.#records.get(id);
		if (!record || !this.#isOwner(record.owner)) return false;
		if (record.state === "claimed")
			throw new Error(
				`Wakeup ${id} is already claimed for delivery (or already delivered) and cannot be cancelled.`,
			);
		const live = this.#live.get(id);
		if (live) {
			this.#clearTimer(live);
			live.controller.abort();
			this.#live.delete(id);
		}
		await this.#persist({ ...record, state: "cancelled" });
		return record.state !== "cancelled";
	}

	#now(): number {
		return this.#host.now?.() ?? Date.now();
	}
	#isOwner(owner: string): boolean {
		return (
			this.#ready && this.#owner === owner && this.#host.enabled() && this.#host.journal.getSessionId() === owner
		);
	}
	#current(live: LiveWakeup): boolean {
		return (
			live.epoch === this.#epoch &&
			!live.controller.signal.aborted &&
			this.#live.get(live.record.id) === live &&
			this.#isOwner(live.record.owner)
		);
	}
	#assertLive(live: LiveWakeup): void {
		if (!this.#current(live)) throw new Error("Wakeup scheduling was cancelled or the owning session changed");
	}
	#makeLive(record: WakeupRecord): LiveWakeup {
		const live = { record, epoch: this.#epoch, controller: new AbortController(), accepted: false };
		this.#live.set(record.id, live);
		return live;
	}
	#clearTimer(live: LiveWakeup): void {
		if (live.timer === undefined) return;
		if (this.#host.clearTimer) this.#host.clearTimer(live.timer);
		else clearTimeout(live.timer as NodeJS.Timeout);
		live.timer = undefined;
	}
	#arm(live: LiveWakeup): void {
		if (!this.#current(live)) return;
		this.#clearTimer(live);
		const callback = () => {
			live.timer = undefined;
			void this.#tick(live).catch(() => {
				// Never leak command output or exception text through logs. Do not retry uncertain durable claims.
				logger.warn("Wakeup stopped after a persistence or delivery failure", { id: live.record.id });
				if (this.#live.get(live.record.id) === live) this.#live.delete(live.record.id);
			});
		};
		const delay = Math.max(0, live.record.dueAt - this.#now());
		if (this.#host.setTimer) live.timer = this.#host.setTimer(callback, delay);
		else {
			const timer = setTimeout(callback, delay);
			timer.unref();
			live.timer = timer;
		}
	}
	async #persist(record: WakeupRecord): Promise<void> {
		if (!this.#isOwner(record.owner)) throw new Error("Wakeup owner changed before persistence");
		this.#records.set(record.id, record);
		this.#host.journal.appendCustomEntry(WAKEUP_ENTRY_TYPE, record);
		await this.#host.journal.ensureOnDisk();
		await this.#host.journal.flush();
	}
	async #runCheck(live: LiveWakeup): Promise<WakeupCheckResult> {
		const remaining = (live.record.deadline ?? this.#now()) - this.#now();
		if (remaining <= 0) return { hash: "", timedOut: true };
		const timeout = new AbortController();
		const signal = AbortSignal.any([live.controller.signal, timeout.signal]);
		// The wakeup deadline bounds the whole wait; the per-check budget below only starts once
		// earlier serialized checks and approval dialogs have released the tail.
		const deadlineTimer = setTimeout(() => timeout.abort(), remaining);
		deadlineTimer.unref();
		let checkTimer: NodeJS.Timeout | undefined;
		// Keep the serial tail attached to the actual execution, even when the
		// deadline wins while an approval dialog or preflight is still settling.
		const run = this.#checkTail.then(() => {
			signal.throwIfAborted();
			this.#assertLive(live);
			const check = live.record.check;
			if (!check) throw new Error("Missing conditional check");
			const timeoutMs = Math.min(WAKEUP_CHECK_TIMEOUT_MS, (live.record.deadline ?? this.#now()) - this.#now());
			if (timeoutMs <= 0) timeout.abort();
			signal.throwIfAborted();
			checkTimer = setTimeout(() => timeout.abort(), timeoutMs);
			checkTimer.unref();
			return this.#host.check(check.command, live.record.cwd, timeoutMs, signal);
		});
		this.#checkTail = run.then(
			() => {},
			() => {},
		);
		try {
			return await untilAborted(signal, run);
		} catch (error) {
			if (timeout.signal.aborted && this.#current(live)) return { hash: "", timedOut: true };
			throw error;
		} finally {
			clearTimeout(deadlineTimer);
			clearTimeout(checkTimer);
		}
	}
	async #tick(live: LiveWakeup): Promise<void> {
		if (!this.#current(live)) return;
		let reason = live.record.reason;
		const deadline = live.record.deadline;
		if (!reason && deadline !== undefined && this.#now() >= deadline) reason = "deadline";
		if (!reason && live.record.check) {
			try {
				const result = await this.#runCheck(live);
				if (!this.#current(live)) return;
				reason = deadline !== undefined && this.#now() >= deadline ? "deadline" : checkFailure(result);
				if (!reason && `${result.exitCode}:${result.hash}` !== live.record.baseline) reason = "changed";
			} catch {
				if (!this.#current(live)) return;
				reason = "check_error";
			}
			if (!reason) {
				live.record = { ...live.record, dueAt: Math.min(this.#now() + live.record.delaySeconds * 1000, deadline!) };
				// Unchanged checks need no journal write. Restore may recheck immediately,
				// but never replays an already claimed/cancelled timer or calls a model here.
				this.#records.set(live.record.id, live.record);
				this.#arm(live);
				return;
			}
		}
		if (!this.#current(live)) return;
		const record: WakeupRecord = { ...live.record, state: "claimed", reason: reason ?? "delay" };
		await this.#persist(record);
		if (!this.#current(live) || this.#records.get(record.id)?.state !== "claimed") return;
		this.#live.delete(record.id);
		await this.#host.deliver({ record, reason: record.reason!, epoch: live.epoch });
	}
}
