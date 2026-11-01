import * as path from "node:path";

import { logger } from "@oh-my-pi/pi-utils";
import {
	attachSessionOwner,
	type CancelledErrorClass,
	formatKernelReclaimNotice,
	getRemainingTimeoutMs,
	isCancellationError,
	isTimedOutCancellation,
	type SessionOwners,
	waitForPromiseWithCancellation,
} from "./executor-base";
import { SupersededKernelReaper, type SupersededReclaimOutcome } from "./superseded-reclaim";

interface KernelSessionRegistryOptions {
	sessionId?: string;
	kernelOwnerId?: string;
	interpreter?: string;
	reset?: boolean;
	signal?: AbortSignal;
	deadlineMs?: number;
	bridge?: unknown;
	bridgeSessionId?: string;
}

interface RegistryKernelShutdownResult {
	confirmed?: boolean;
}

interface RegistryKernel {
	isAlive(): boolean;
	hasPendingWork(): boolean;
	shutdown(options?: { timeoutMs: number }): Promise<RegistryKernelShutdownResult>;
}

export interface KernelSession<TKernel extends RegistryKernel> extends SessionOwners {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	kernel: TKernel;
	/**
	 * Callers currently holding this session: an executing cell from the moment
	 * it acquires the session, and a borrower such as a subagent that can call
	 * the kernel's tools. Reclaiming a superseded kernel consults it, so a hold
	 * taken before the runner owes a frame still protects it.
	 */
	activeUses: number;
}

interface StartingKernelSession<TSession> extends SessionOwners {
	promise: Promise<TSession>;
}

/** One owner's record of a kernel a reclaim took from it under one key. */
interface ReclaimedKernel<TKernel> {
	/** The kernel that went; a cell running on this same kernel lost nothing. */
	kernel: TKernel;
	/** Where it worked, so the notice can say which namespace is gone. */
	cwd: string;
	/**
	 * Set while a cell that carries the notice is running, so a concurrent cell
	 * does not say it twice; cleared again if that cell throws and its output,
	 * notice included, reaches nobody.
	 */
	announcing: boolean;
}

export interface KernelSessionRegistryContext<
	TKernel extends RegistryKernel,
	TOptions extends KernelSessionRegistryOptions,
	TSession extends KernelSession<TKernel>,
> {
	sessions: Map<string, TSession>;
	startKernel: (cwd: string, options: TOptions) => Promise<TKernel>;
	replaceSessionKernel: (session: TSession, cwd: string, options: TOptions) => Promise<TKernel>;
}

interface KernelSessionRegistryDescriptor<
	TKernel extends RegistryKernel,
	TOptions extends KernelSessionRegistryOptions,
	R,
	TSession extends KernelSession<TKernel>,
> {
	languageLabel: string;
	cancelledErrorClass: CancelledErrorClass;
	buildSessionKey: (sessionId: string, cwd: string, interpreter: string | undefined) => string;
	createSession: (session: KernelSession<TKernel>) => TSession;
	startKernel: (cwd: string, options: TOptions) => Promise<TKernel>;
	executeWithKernel: (kernel: TKernel, code: string, options: TOptions) => Promise<R>;
	replaceSessionKernel?: (
		session: TSession,
		cwd: string,
		options: TOptions,
		context: KernelSessionRegistryContext<TKernel, TOptions, TSession>,
	) => Promise<TKernel>;
	acquireLiveSessionKernel?: (
		session: TSession,
		cwd: string,
		options: TOptions,
		context: KernelSessionRegistryContext<TKernel, TOptions, TSession>,
	) => Promise<TKernel>;
	invalidateSession?: (session: TSession) => void;
	shutdownSession?: (session: TSession, resetting: boolean) => Promise<RegistryKernelShutdownResult>;
	clearResetsOnDisposeAll?: boolean;
	logBeforeReplacement?: boolean;
	isCancellation?: (error: unknown) => boolean;
	isTimedOutCancellation?: (error: unknown, signal?: AbortSignal) => boolean;
	validateKernel?: (session: TSession, kernel: TKernel) => boolean;
}

interface KernelSessionRegistry<
	TKernel extends RegistryKernel,
	TOptions extends KernelSessionRegistryOptions,
	R,
	TSession extends KernelSession<TKernel>,
> {
	borrowSession(cwd: string, options: TOptions): () => void;
	disposeAll(): Promise<void>;
	disposeByOwner(ownerId: string): Promise<void>;
	executeOnSession(code: string, cwd: string, options: TOptions): Promise<R>;
	peekLiveKernel(cwd: string, options: TOptions): TKernel | undefined;
	getPresentSession(cwd: string, options: TOptions): TSession | undefined;
}

export function normalizeKernelSessionCwd(cwd: string): string {
	return path.resolve(cwd);
}

export function requireRemainingKernelTimeoutMs(
	deadlineMs: number | undefined,
	cancelledErrorClass: CancelledErrorClass,
): number | undefined {
	const remainingMs = getRemainingTimeoutMs(deadlineMs);
	if (remainingMs === undefined) return undefined;
	if (remainingMs <= 0) {
		throw new cancelledErrorClass(true);
	}
	return remainingMs;
}

export function formatSessionTimeoutAnnotation(timeoutMs?: number): string {
	if (timeoutMs === undefined) return "Command timed out";
	const secs = Math.max(1, Math.round(timeoutMs / 1000));
	return `Command timed out after ${secs} seconds`;
}

export function formatSessionKernelTimeoutAnnotation(timeoutMs: number | undefined, kernelKilled: boolean): string {
	const secs = timeoutMs === undefined ? undefined : Math.max(1, Math.round(timeoutMs / 1000));
	if (kernelKilled) {
		return "eval cell timed out and the kernel was unresponsive to interrupt; the kernel has been killed and will be recreated on the next call.";
	}
	const duration = secs === undefined ? "the configured timeout" : `${secs}s`;
	return `eval cell timed out after ${duration}; kernel interrupted but remains running. Reset the kernel via { reset: true } if state appears corrupted.`;
}

export function createKernelSessionRegistry<
	TKernel extends RegistryKernel,
	TOptions extends KernelSessionRegistryOptions,
	R extends { cancelled: boolean },
	TSession extends KernelSession<TKernel>,
>(
	descriptor: KernelSessionRegistryDescriptor<TKernel, TOptions, R, TSession>,
): KernelSessionRegistry<TKernel, TOptions, R, TSession> {
	const sessions = new Map<string, TSession>();
	const startingSessions = new Map<string, StartingKernelSession<TSession>>();
	const resettingSessions = new Map<string, Promise<void>>();
	const replacingSessionKernels = new Map<TSession, { kernel: TKernel; promise: Promise<TKernel> }>();
	/**
	 * The session key each explicit owner acquired last. A superseded kernel is
	 * only reclaimed once every owner registered against it has moved on, and
	 * `ownerIds` alone cannot say that: an id attached at one key stays there
	 * for the session's life.
	 */
	const ownerKeys = new Map<string, string>();
	const reaper = new SupersededKernelReaper<TSession>();
	/**
	 * Kernels a reclaim took, by owner and then by key: for every owner
	 * registered against the session, the kernel that went and the directory it
	 * worked in. The next cell on such a key starts a fresh kernel with an empty
	 * namespace, and nothing else here would tell the caller why: a reclaim that
	 * works logs nothing.
	 *
	 * Written in the same synchronous step that takes the session out of
	 * `sessions`, never after the shutdown it then awaits, so a cell, a reset or
	 * a disposal that lands while that shutdown runs already sees it, and
	 * nothing late writes it back. Read only by its own owner's cells, and said
	 * only when the cell runs on a different kernel than the one recorded —
	 * which is what makes it true both for a fresh kernel and for a session
	 * whose unconfirmed kernel was put back and then replaced, and false for
	 * none. Dropped once said, by that owner's reset of the key, and with the
	 * owner when it is disposed.
	 */
	const reclaimedKernels = new Map<string, Map<string, ReclaimedKernel<TKernel>>>();
	/**
	 * Sessions whose reclaim did not confirm the shutdown while another session
	 * held, or was starting at, their key, so they could not be put back. Their
	 * owners are still live, so owner disposal retries its own once;
	 * `disposeAll` retries every one.
	 */
	const unconfirmed = new Set<TSession>();
	/**
	 * Sessions a disposal could not confirm down: cleanup debt and nothing
	 * else. The owner that held one has been disposed and was told what it
	 * lost, so it is neither a live session nor anyone's notice — never put
	 * back where a cell, the arming pass or a reclaim can reach it, which made
	 * the reaper reclaim it again and record the loss once more for the owner
	 * the disposal had just forgotten. Only `disposeAll` retries it.
	 */
	const retained = new Set<TSession>();

	const context: KernelSessionRegistryContext<TKernel, TOptions, TSession> = {
		sessions,
		startKernel: descriptor.startKernel,
		replaceSessionKernel,
	};

	function throwIfCallerCancelled(options: TOptions): void {
		if (!options.signal?.aborted) return;
		const timedOut =
			descriptor.isTimedOutCancellation?.(options.signal.reason, options.signal) ??
			isTimedOutCancellation(options.signal.reason, descriptor.cancelledErrorClass, options.signal);
		throw new descriptor.cancelledErrorClass(timedOut);
	}

	function isCurrent(session: TSession, kernel?: TKernel): boolean {
		return (
			sessions.get(session.sessionKey) === session &&
			(kernel === undefined || descriptor.validateKernel?.(session, kernel) !== false)
		);
	}

	async function acquireSession(
		sessionKey: string,
		sessionId: string,
		cwd: string,
		options: TOptions,
	): Promise<TSession> {
		// Where this owner is working now: every key it is not at is one it has
		// moved away from, which is what arms a reclaim.
		if (options.kernelOwnerId !== undefined) ownerKeys.set(options.kernelOwnerId, sessionKey);
		const existing = sessions.get(sessionKey);
		if (existing) {
			attachSessionOwner(existing, sessionId, options.kernelOwnerId);
			// Reacquired inside its grace: keep the kernel and its namespace.
			reaper.cancel(existing);
			// Held before this function returns, so no reclaim can run between
			// the lookup and the caller taking its hold. The caller releases it.
			existing.activeUses += 1;
			return existing;
		}
		const starting = startingSessions.get(sessionKey);
		if (starting) {
			attachSessionOwner(starting, sessionId, options.kernelOwnerId);
			const started = await starting.promise;
			started.activeUses += 1;
			return started;
		}
		// oxlint-disable-next-line prefer-const -- captured by the startup closure before assignment
		let startingSession!: StartingKernelSession<TSession>;
		// Kernels are shared by every owner of the key, so the readers and timers a
		// kernel starts carry no caller's log context.
		const startup = logger.withoutContext(async () => {
			const kernel = await descriptor.startKernel(cwd, options);
			const session = descriptor.createSession({
				sessionKey,
				sessionId,
				cwd,
				kernel,
				// Born held, for the caller that started it: `sessions.set` below
				// publishes the session to the reclaim scan a tick before that
				// caller can take a hold of its own.
				activeUses: 1,
				ownerIds: new Set(startingSession.ownerIds),
				hasFallbackOwner: startingSession.hasFallbackOwner,
			});
			if (startingSessions.get(sessionKey) === startingSession) {
				sessions.set(sessionKey, session);
			}
			return session;
		});
		startingSession = {
			ownerIds: new Set(),
			hasFallbackOwner: false,
			promise: startup,
		};
		attachSessionOwner(startingSession, sessionId, options.kernelOwnerId);
		startingSessions.set(sessionKey, startingSession);
		// The hold this session was born with is this caller's, released by its
		// `finally`. That is only sound because nothing between here and that
		// `finally` can abandon a startup that goes on to publish: a wait that
		// gave up early would strand the hold and keep the kernel "deferred"
		// for good.
		try {
			return await startup;
		} finally {
			if (startingSessions.get(sessionKey) === startingSession) startingSessions.delete(sessionKey);
		}
	}

	async function replaceSessionKernel(session: TSession, cwd: string, options: TOptions): Promise<TKernel> {
		const replace = descriptor.replaceSessionKernel;
		if (replace) {
			return await logger.withoutContext(() => replace(session, cwd, options, context));
		}
		if (descriptor.logBeforeReplacement) {
			logger.warn(`${descriptor.languageLabel} subprocess died or is unresponsive; spawning fresh process`, {
				sessionKey: session.sessionKey,
			});
		}
		const old = session.kernel;
		const remaining = getRemainingTimeoutMs(options.deadlineMs);
		await old
			.shutdown(remaining !== undefined ? { timeoutMs: Math.max(0, remaining) } : undefined)
			.catch(() => undefined);
		if (sessions.get(session.sessionKey) !== session) {
			throw new descriptor.cancelledErrorClass(false);
		}
		requireRemainingKernelTimeoutMs(options.deadlineMs, descriptor.cancelledErrorClass);
		const next = await logger.withoutContext(() => descriptor.startKernel(cwd, options));
		if (sessions.get(session.sessionKey) !== session) {
			await next.shutdown().catch(() => undefined);
			throw new descriptor.cancelledErrorClass(false);
		}
		session.kernel = next;
		return next;
	}

	async function acquireDefaultReplacementKernel(
		session: TSession,
		kernel: TKernel,
		cwd: string,
		options: TOptions,
	): Promise<TKernel> {
		const existing = replacingSessionKernels.get(session);
		if (existing?.kernel === kernel) {
			return await waitForPromiseWithCancellation(existing.promise, options, descriptor.cancelledErrorClass);
		}
		if (!isCurrent(session)) throw new descriptor.cancelledErrorClass(false);
		if (session.kernel !== kernel) {
			const currentKernel = session.kernel;
			if (currentKernel.isAlive()) return currentKernel;
			return await acquireDefaultReplacementKernel(session, currentKernel, cwd, options);
		}
		const replacement = {
			kernel,
			promise: replaceSessionKernel(session, cwd, {
				...options,
				signal: undefined,
				deadlineMs: undefined,
			}),
		};
		replacingSessionKernels.set(session, replacement);
		const release = (): void => {
			if (replacingSessionKernels.get(session) === replacement) {
				replacingSessionKernels.delete(session);
			}
		};
		void replacement.promise.then(release, release);
		return await waitForPromiseWithCancellation(replacement.promise, options, descriptor.cancelledErrorClass);
	}

	async function acquireLiveSessionKernel(session: TSession, cwd: string, options: TOptions): Promise<TKernel> {
		if (descriptor.acquireLiveSessionKernel) {
			return await descriptor.acquireLiveSessionKernel(session, cwd, options, context);
		}
		if (!isCurrent(session)) throw new descriptor.cancelledErrorClass(false);
		const kernel = session.kernel;
		if (!kernel.isAlive()) await acquireDefaultReplacementKernel(session, kernel, cwd, options);
		if (!isCurrent(session)) throw new descriptor.cancelledErrorClass(false);
		return session.kernel;
	}

	async function shutdownSession(session: TSession, resetting: boolean): Promise<RegistryKernelShutdownResult> {
		const replacement = replacingSessionKernels.get(session)?.promise;
		let shutdown: Promise<RegistryKernelShutdownResult>;
		try {
			shutdown = descriptor.shutdownSession?.(session, resetting) ?? session.kernel.shutdown();
		} catch (error) {
			if (replacement) await replacement.catch(() => undefined);
			throw error;
		}
		if (!replacement) return await shutdown;
		const [result] = await Promise.allSettled([shutdown, replacement]);
		if (result.status === "rejected") throw result.reason;
		return result.value;
	}
	async function settleShutdown(
		session: TSession,
		resetting: boolean,
	): Promise<PromiseSettledResult<RegistryKernelShutdownResult>> {
		return await shutdownSession(session, resetting).then(
			value => ({ status: "fulfilled", value }),
			reason => ({ status: "rejected", reason }),
		);
	}

	async function resetSession(sessionKey: string): Promise<void> {
		const existing =
			sessions.get(sessionKey) ?? (await startingSessions.get(sessionKey)?.promise.catch(() => undefined));
		if (!existing) return;
		descriptor.invalidateSession?.(existing);
		reaper.cancel(existing);
		sessions.delete(sessionKey);
		await shutdownSession(existing, true).catch(() => undefined);
	}

	/**
	 * Arm or disarm the reclaim grace on every retained kernel, in one pass
	 * over the registry. The grace runs from the moment a kernel is found
	 * superseded, not from when it falls idle.
	 *
	 * A retained kernel is keyed by (eval session id, cwd, interpreter), so an
	 * owner that changes directory, switches interpreter, or whose eval session
	 * id gains its on-disk session file acquires a *new* kernel and strands the
	 * previous runner.
	 *
	 * Whether a kernel is stranded is a property of the registry as a whole —
	 * where each of its owners is working now — not of the call that happens to
	 * notice. So the question is asked about every session, from every point
	 * that can change the answer: a cell acquiring or releasing a session, a
	 * borrow ending, an owner departing. Asking it everywhere is what a scan
	 * driven by the acquiring call cannot do: that one cannot see a session
	 * still behind its startup barrier, and skips the very key whose cell has
	 * just finished while its owner has moved on — the kernel left over from
	 * two overlapping cold starts belongs to both of those blind spots.
	 *
	 * A session is armed once every agent registered against it has run its
	 * latest cell under some other key ({@link everyOwnerMovedAway}); arming on
	 * the scanning owner alone would leave a kernel two agents share alive for
	 * the life of the host, since neither rotation ever drops an id from
	 * {@link SessionOwners.ownerIds}.
	 *
	 * Two things make an armed session off limits when the grace expires,
	 * because killing a kernel someone still wants costs more than the memory
	 * this reclaims:
	 *
	 * - a caller holds it ({@link KernelSession.activeUses}): a cell between
	 *   acquiring the session and writing its first frame, or a borrower such as
	 *   a subagent that can call the kernel's tools;
	 * - its runner still owes a frame, which covers a cell already running,
	 *   including a backgrounded one.
	 *
	 * Both hold only for now, so the reclaim they stop is armed again rather
	 * than dropped: the owner that walked away may never run another cell.
	 *
	 * Without an explicit `kernelOwnerId` the registry cannot tell two callers
	 * apart — {@link attachSessionOwner} records the first of them and ignores
	 * the rest — so nothing is reclaimed rather than guessed.
	 *
	 * The shutdown runs in the background: it costs the acquiring cell nothing,
	 * and `disposeAll` awaits whatever is still in flight.
	 */
	function reconcileSupersededSessions(): void {
		for (const [key, session] of Array.from(sessions.entries())) {
			// Armed on ownership alone. A session busy right now is still one its
			// owners have walked away from, and the fire-time guards below are
			// what decide; arming only when it is idle would leave a kernel whose
			// owner never runs another cell unreclaimed for the life of the host.
			if (isSuperseded(key, session)) reaper.schedule(session, () => reclaimSuperseded(key, session));
			else reaper.cancel(session);
		}
	}

	/** Shut the kernel under `key` down, unless a fire-time guard still holds it. */
	async function reclaimSuperseded(key: string, session: TSession): Promise<SupersededReclaimOutcome> {
		// Re-checked at the far end of the grace: a cell, a borrow or another
		// agent may have taken the kernel in the meantime.
		if (!isSuperseded(key, session)) return "settled";
		if (session.activeUses > 0 || session.kernel.hasPendingWork()) return "deferred";
		descriptor.invalidateSession?.(session);
		sessions.delete(key);
		// The namespace this session had here is gone from the moment it leaves
		// the map: a cell arriving now starts a fresh kernel, while the old one
		// may take seconds more to exit. So the loss is recorded in this same
		// step, not after the shutdown, and nothing that settles later writes
		// it again.
		recordReclaimedKernel(key, session);
		const result = await settleShutdown(session, false);
		if (result.status === "fulfilled" && result.value?.confirmed !== false) return "settled";
		logger.warn(`${descriptor.languageLabel} kernel left behind by its session did not confirm exit`, {
			sessionId: session.sessionId,
			sessionKey: key,
			cwd: session.cwd,
			reason: result.status === "rejected" ? result.reason : "not confirmed",
		});
		keepUnconfirmed(session);
		return "settled";
	}

	function recordReclaimedKernel(key: string, session: TSession): void {
		for (const owner of session.ownerIds) {
			let byKey = reclaimedKernels.get(owner);
			if (byKey === undefined) {
				byKey = new Map();
				reclaimedKernels.set(owner, byKey);
			}
			byKey.set(key, { kernel: session.kernel, cwd: session.cwd, announcing: false });
		}
	}

	/** Drop `owner`'s record for `key` — only `record`, when given, so a newer one survives. */
	function forgetReclaimedKernel(owner: string, key: string, record?: ReclaimedKernel<TKernel>): void {
		const byKey = reclaimedKernels.get(owner);
		if (byKey === undefined || (record !== undefined && byKey.get(key) !== record)) return;
		byKey.delete(key);
		if (byKey.size === 0) reclaimedKernels.delete(owner);
	}

	/**
	 * Keep a session whose reclaim did not confirm the shutdown where a later
	 * disposal can retry it: back under its key when nothing else holds or is
	 * starting there — the next cell on that key replaces a dead kernel the
	 * ordinary way — and otherwise in {@link unconfirmed}, since publishing
	 * over a fresh or starting session would strand that one instead. Its
	 * owners are live; a disposal's failures go to {@link retained} instead.
	 */
	function keepUnconfirmed(session: TSession): void {
		const key = session.sessionKey;
		if (!sessions.has(key) && !startingSessions.has(key)) sessions.set(key, session);
		else unconfirmed.add(session);
	}

	/**
	 * Shut `session` down for a disposal. One that does not confirm is logged
	 * and held in {@link retained} for `disposeAll`, never put back under its
	 * key. Each attempt is bounded by the kernel's own shutdown escalation. A
	 * signal cannot immediately end truly uninterruptible kernel I/O, and a
	 * bounded wait cannot guarantee the exit: a runner in it outlasts the
	 * attempt and stays retained until that I/O completes or is aborted.
	 */
	async function shutdownForDisposal(session: TSession): Promise<boolean> {
		const result = await settleShutdown(session, false);
		if (result.status === "fulfilled" && result.value?.confirmed !== false) return true;
		logger.warn(`${descriptor.languageLabel} kernel shutdown not confirmed`, {
			kernelSessionId: session.sessionId,
			sessionKey: session.sessionKey,
			cwd: session.cwd,
			reason: result.status === "rejected" ? result.reason : "not confirmed",
		});
		retained.add(session);
		return false;
	}

	/**
	 * The one further attempt a disposal makes on kernels a reclaim could not
	 * confirm down: `reclaimed` holds the sessions of the reclaims it joined
	 * and those an earlier reclaim set aside. Each still unconfirmed — put back
	 * under its key or set aside — is shut down once more; a put-back session
	 * another owner is still registered on only loses `ownerId`'s
	 * registration. A kernel the disposal's own shutdown could not confirm is
	 * not retried here; it is retained for `disposeAll`.
	 */
	async function retryUnconfirmed(reclaimed: Iterable<TSession>, ownerId?: string): Promise<void> {
		const retries: TSession[] = [];
		for (const session of reclaimed) {
			if (unconfirmed.delete(session)) {
				retries.push(session);
				continue;
			}
			if (sessions.get(session.sessionKey) !== session) continue;
			if (ownerId !== undefined && session.ownerIds.size > 1) {
				session.ownerIds.delete(ownerId);
				continue;
			}
			descriptor.invalidateSession?.(session);
			sessions.delete(session.sessionKey);
			retries.push(session);
		}
		await Promise.all(retries.map(shutdownForDisposal));
	}

	/**
	 * Whether `session` under `key` is one nobody is still working at, and may
	 * therefore be armed or shut down.
	 */
	function isSuperseded(key: string, session: TSession): boolean {
		if (sessions.get(key) !== session) return false;
		return everyOwnerMovedAway(key, session);
	}

	/**
	 * Whether every agent registered against `session` has since run a cell
	 * under another key. A fallback owner is a session id the registry invented
	 * for a caller that gave none, and two such callers are indistinguishable,
	 * so a session carrying one is never reclaimed.
	 */
	function everyOwnerMovedAway(key: string, session: TSession): boolean {
		if (session.hasFallbackOwner || session.ownerIds.size === 0) return false;
		for (const owner of session.ownerIds) {
			if (ownerKeys.get(owner) !== key) continue;
			return false;
		}
		return true;
	}

	/**
	 * Hold the live session for `cwd` so a superseded-kernel reclaim leaves it
	 * alone, and return the release. Borrowers that can call a kernel's tools
	 * between cells — a background subagent given `tools=[…]` — hold one for as
	 * long as they can make that call. Returns a no-op when no session is live:
	 * there is nothing to protect, and the next cell starts a fresh kernel.
	 */
	function borrowSession(cwd: string, options: TOptions): () => void {
		const sessionId = options.sessionId ?? `session:${cwd}`;
		const session = sessions.get(descriptor.buildSessionKey(sessionId, cwd, options.interpreter));
		if (!session) return () => {};
		session.activeUses += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			session.activeUses -= 1;
			// The hold is gone, so this session may now be reclaimable; the
			// borrower's owner may never run another cell to notice.
			reconcileSupersededSessions();
		};
	}

	async function disposeAll(): Promise<void> {
		// A disposal never waits out a grace: the timers go, and the sessions
		// they were holding are shut down below like any other.
		reaper.cancelAll();
		ownerKeys.clear();
		reclaimedKernels.clear();
		if (descriptor.clearResetsOnDisposeAll) resettingSessions.clear();
		// One synchronous step takes everything a kernel can be held by. The
		// reclaims running now each removed their session from the map before
		// awaiting the shutdown, so only the reaper still reaches those runners:
		// they are joined, and a kernel one of them could not confirm gets one
		// more attempt afterwards. The map, the startups, what an earlier
		// reclaim set aside and what an earlier disposal retained are this
		// disposal's own to shut down.
		const reclaiming = new Set<TSession>(reaper.running());
		const reclaims = reaper.settle(reclaiming);
		const pending = [...startingSessions.values()].map(starting => starting.promise);
		startingSessions.clear();
		const all = [...unconfirmed, ...retained];
		unconfirmed.clear();
		retained.clear();
		for (const [key, session] of Array.from(sessions.entries())) {
			descriptor.invalidateSession?.(session);
			sessions.delete(key);
			all.push(session);
		}
		const started = Promise.allSettled(pending).then(results =>
			Promise.all(
				results.flatMap(result => {
					if (result.status !== "fulfilled" || all.includes(result.value)) return [];
					const session = result.value;
					descriptor.invalidateSession?.(session);
					if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
					return [shutdownForDisposal(session)];
				}),
			),
		);
		// The running reclaims are joined alongside the shutdowns, not ahead of
		// them, so the slowest kernel sets the wait rather than the sum.
		await Promise.all([reclaims, started, ...all.map(shutdownForDisposal)]);
		await retryUnconfirmed(reclaiming);
	}

	async function disposeByOwner(ownerId: string): Promise<void> {
		const owns = (session: TSession): boolean => session.ownerIds.has(ownerId);
		// Everything up to the first `await` is one synchronous step, so no
		// grace expires between the reclaims found running and the sweep.
		//
		// A reclaim already running took its session out of the map before it
		// awaited the shutdown, so the sweep below cannot find that runner, and
		// returning while it is still up would make "the session ended" false.
		// This owner's reclaims are joined alongside its own shutdowns; another
		// owner's are not this disposal's to wait for.
		const reclaimed = new Set<TSession>(reaper.running().filter(owns));
		const reclaims = reaper.settle(reclaimed);
		// This owner is gone, so it is at no key: a kernel it shared stops
		// waiting on it, and nobody is left to tell what a reclaim took from it.
		ownerKeys.delete(ownerId);
		reclaimedKernels.delete(ownerId);
		// What an earlier reclaim of this owner's kernels set aside gets its
		// attempt with the ones joined here, after the wait.
		for (const session of unconfirmed) if (owns(session)) reclaimed.add(session);
		const toShutdown: TSession[] = [];
		for (const [key, session] of Array.from(sessions.entries())) {
			if (!owns(session)) continue;
			reaper.cancel(session);
			if (session.ownerIds.size > 1) {
				session.ownerIds.delete(ownerId);
				continue;
			}
			descriptor.invalidateSession?.(session);
			sessions.delete(key);
			toShutdown.push(session);
		}
		const startingToShutdown: StartingKernelSession<TSession>[] = [];
		for (const [sessionKey, starting] of Array.from(startingSessions.entries())) {
			if (sessions.has(sessionKey) || !starting.ownerIds.has(ownerId)) continue;
			if (starting.ownerIds.size === 1) {
				startingSessions.delete(sessionKey);
				startingToShutdown.push(starting);
				continue;
			}
			starting.ownerIds.delete(ownerId);
		}
		const shutDown = async (session: TSession): Promise<void> => {
			if (await shutdownForDisposal(session)) session.ownerIds.delete(ownerId);
		};
		const started = Promise.allSettled(startingToShutdown.map(starting => starting.promise)).then(results =>
			Promise.all(
				results.flatMap(result => {
					if (result.status !== "fulfilled") return [];
					const session = result.value;
					descriptor.invalidateSession?.(session);
					if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
					return [shutDown(session)];
				}),
			),
		);
		await Promise.all([reclaims, started, ...toShutdown.map(shutDown)]);
		// Each kernel of this owner a reclaim could not confirm — one joined
		// above, or one an earlier reclaim set aside — gets one more attempt; one
		// that still does not confirm is logged and kept for `disposeAll`.
		await retryUnconfirmed(reclaimed, ownerId);
		// A kernel this owner shared with another agent kept only its
		// registration dropped above. Nobody is left to notice that, so the
		// arming question is asked again here: the agents it still belongs to
		// may have moved away long ago.
		reconcileSupersededSessions();
	}

	function peekLiveKernel(cwd: string, options: TOptions): TKernel | undefined {
		const sessionId = options.sessionId ?? `session:${cwd}`;
		const sessionKey = descriptor.buildSessionKey(sessionId, cwd, options.interpreter);
		const kernel = sessions.get(sessionKey)?.kernel;
		return kernel?.isAlive() ? kernel : undefined;
	}

	function getPresentSession(cwd: string, options: TOptions): TSession | undefined {
		const sessionId = options.sessionId ?? `session:${cwd}`;
		return sessions.get(descriptor.buildSessionKey(sessionId, cwd, options.interpreter));
	}

	async function executeOnSession(code: string, cwd: string, options: TOptions): Promise<R> {
		const sessionId = options.sessionId ?? `session:${cwd}`;
		const sessionKey = descriptor.buildSessionKey(sessionId, cwd, options.interpreter);
		if (options.bridge && !options.bridgeSessionId) {
			options.bridgeSessionId = sessionId;
		}
		const owner = options.kernelOwnerId;
		if (options.reset) {
			const inFlight = resettingSessions.get(sessionKey);
			if (inFlight) await inFlight.catch(() => undefined);
			else {
				const resetPromise = resetSession(sessionKey);
				resettingSessions.set(
					sessionKey,
					resetPromise.then(() => undefined),
				);
				try {
					await resetPromise;
				} finally {
					resettingSessions.delete(sessionKey);
				}
			}
			// The caller asked for a fresh kernel, so an empty namespace is not
			// news: what a reclaim took from this owner here goes unsaid rather
			// than explaining a restart the caller ordered.
			if (owner !== undefined) forgetReclaimedKernel(owner, sessionKey);
		} else {
			const inFlight = resettingSessions.get(sessionKey);
			if (inFlight) await inFlight.catch(() => undefined);
		}
		// `acquireSession` records this owner at `sessionKey` before it knows
		// whether a kernel can be started there, so the move away from wherever
		// the owner was is already real when a startup rejects — a missing
		// interpreter, a spawn that fails. The boundary therefore opens *before*
		// the acquisition, not after it: both the rejection and the ordinary end
		// of the cell leave through the same `finally`.
		let session: TSession | undefined;
		try {
			// `acquireSession` returns the session already held for this call: a
			// concurrent cell of the same owner at another key must not reclaim it
			// between the kernel being acquired and the runner owing its first
			// frame, which a kernel replacement stretches to seconds.
			session = await acquireSession(sessionKey, sessionId, cwd, options);
			reconcileSupersededSessions();
			throwIfCallerCancelled(options);
			const kernel = await acquireLiveSessionKernel(session, cwd, options);
			if (!isCurrent(session, kernel)) throw new descriptor.cancelledErrorClass(false);
			throwIfCallerCancelled(options);
			// An owner whose kernel here a reclaim took is told so by its first
			// cell that runs on another kernel — whether the cell started a fresh
			// one while the old one was still exiting, or the reclaim could not
			// confirm the old one down, put it back, and it has since been
			// replaced. A cell still running on the recorded kernel lost
			// nothing. Claimed at the start of the cell, inside the executor, so
			// the line lands ahead of that cell's own output.
			// Written by the claim inside the executor, so held in an object:
			// control-flow narrowing does not see a closure's assignment.
			const claim: { announced?: ReclaimedKernel<TKernel> } = {};
			const claimKernelNotice = (): string | undefined => {
				if (owner === undefined) return undefined;
				const record = reclaimedKernels.get(owner)?.get(sessionKey);
				if (record === undefined || record.announcing) return undefined;
				if (record.kernel === kernel) {
					forgetReclaimedKernel(owner, sessionKey, record);
					return undefined;
				}
				record.announcing = true;
				claim.announced = record;
				return formatKernelReclaimNotice(`${descriptor.languageLabel} kernel`, record.cwd, "process-group");
			};
			const runOptions = { ...options, cwd, claimKernelNotice };
			try {
				const result = await descriptor.executeWithKernel(kernel, code, runOptions);
				// Said with this cell's output, so said once.
				if (claim.announced !== undefined && owner !== undefined) {
					forgetReclaimedKernel(owner, sessionKey, claim.announced);
				}
				return result;
			} catch (err) {
				// A cell that threw returns no output, so the notice it carried
				// reached nobody. The record stays, and the next cell carries it.
				if (claim.announced !== undefined) claim.announced.announcing = false;
				if (
					descriptor.isCancellation?.(err) ||
					isCancellationError(err, descriptor.cancelledErrorClass) ||
					options.signal?.aborted
				)
					throw err;
				if (kernel.isAlive()) throw err;
				throw new Error(
					`${descriptor.languageLabel} kernel died during execution; completion is uncertain and the cell was not replayed. The next call will start a fresh kernel.`,
					{ cause: err },
				);
			}
		} finally {
			// This cell is done holding the session, and the owner it ran for may
			// have moved on while it ran — an older key whose cold start finished
			// last is superseded the moment its only cell ends.
			if (session) session.activeUses -= 1;
			reconcileSupersededSessions();
		}
	}

	return { borrowSession, disposeAll, disposeByOwner, executeOnSession, peekLiveKernel, getPresentSession };
}
