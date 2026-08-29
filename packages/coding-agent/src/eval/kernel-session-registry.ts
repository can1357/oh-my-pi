import * as path from "node:path";

import { logger } from "@oh-my-pi/pi-utils";
import {
	attachSessionOwner,
	type CancelledErrorClass,
	getRemainingTimeoutMs,
	isCancellationError,
	isTimedOutCancellation,
	resolveOwnerScopedSessionKey,
	type SessionOwners,
	waitForPromiseWithCancellation,
} from "./executor-base";

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
	shutdown(options?: { timeoutMs: number }): Promise<RegistryKernelShutdownResult>;
}

export interface KernelSession<TKernel extends RegistryKernel> extends SessionOwners {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	kernel: TKernel;
}

interface StartingKernelSession<TSession> extends SessionOwners {
	promise: Promise<TSession>;
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
	TResult,
	TSession extends KernelSession<TKernel>,
> {
	languageLabel: string;
	cancelledErrorClass: CancelledErrorClass;
	buildSessionKey: (sessionId: string, cwd: string, interpreter: string | undefined) => string;
	createSession: (session: KernelSession<TKernel>) => TSession;
	startKernel: (cwd: string, options: TOptions) => Promise<TKernel>;
	executeWithKernel: (kernel: TKernel, code: string, options: TOptions) => Promise<TResult>;
	waitForStartup?: (promise: Promise<TSession>, options: TOptions) => Promise<TSession>;
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

interface KernelSessionRegistry<TOptions extends KernelSessionRegistryOptions, TResult> {
	disposeAll(): Promise<void>;
	disposeByOwner(ownerId: string): Promise<void>;
	executeOnSession(code: string, cwd: string, options: TOptions): Promise<TResult>;
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
	TResult extends { cancelled: boolean },
	TSession extends KernelSession<TKernel>,
>(
	descriptor: KernelSessionRegistryDescriptor<TKernel, TOptions, TResult, TSession>,
): KernelSessionRegistry<TOptions, TResult> {
	const sessions = new Map<string, TSession>();
	const startingSessions = new Map<string, StartingKernelSession<TSession>>();
	const resettingSessions = new Map<string, Promise<void>>();
	const replacingSessionKernels = new Map<TSession, { kernel: TKernel; promise: Promise<TKernel> }>();

	const context: KernelSessionRegistryContext<TKernel, TOptions, TSession> = {
		sessions,
		startKernel: descriptor.startKernel,
		replaceSessionKernel,
	};

	function waitForStartup(promise: Promise<TSession>, options: TOptions): Promise<TSession> {
		return descriptor.waitForStartup?.(promise, options) ?? promise;
	}

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
		const existing = sessions.get(sessionKey);
		if (existing) {
			attachSessionOwner(existing, sessionId, options.kernelOwnerId);
			return existing;
		}
		const starting = startingSessions.get(sessionKey);
		if (starting) {
			attachSessionOwner(starting, sessionId, options.kernelOwnerId);
			return await waitForStartup(starting.promise, options);
		}
		let startingSession!: StartingKernelSession<TSession>;
		const startup = (async () => {
			const kernel = await descriptor.startKernel(cwd, options);
			const session = descriptor.createSession({
				sessionKey,
				sessionId,
				cwd,
				kernel,
				ownerIds: new Set(startingSession.ownerIds),
				hasFallbackOwner: startingSession.hasFallbackOwner,
			});
			if (startingSessions.get(sessionKey) === startingSession) {
				sessions.set(sessionKey, session);
			}
			return session;
		})();
		startingSession = {
			ownerIds: new Set(),
			hasFallbackOwner: false,
			promise: startup,
		};
		attachSessionOwner(startingSession, sessionId, options.kernelOwnerId);
		startingSessions.set(sessionKey, startingSession);
		try {
			return await waitForStartup(startup, options);
		} finally {
			if (startingSessions.get(sessionKey) === startingSession) startingSessions.delete(sessionKey);
		}
	}

	async function replaceSessionKernel(session: TSession, cwd: string, options: TOptions): Promise<TKernel> {
		if (descriptor.replaceSessionKernel) {
			return await descriptor.replaceSessionKernel(session, cwd, options, context);
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
		const next = await descriptor.startKernel(cwd, options);
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
		sessions.delete(sessionKey);
		await shutdownSession(existing, true).catch(() => undefined);
	}

	async function disposeAll(): Promise<void> {
		const pending = [...startingSessions.values()].map(starting => starting.promise);
		startingSessions.clear();
		if (descriptor.clearResetsOnDisposeAll) resettingSessions.clear();
		const all = [...sessions.entries()];
		for (const [id, session] of all) {
			descriptor.invalidateSession?.(session);
			if (sessions.get(id) === session) sessions.delete(id);
		}
		const shutdowns = all.map(([, session]) => settleShutdown(session, false));
		const started = await Promise.allSettled(pending);
		for (const result of started) {
			if (result.status !== "fulfilled") continue;
			if (all.some(([, session]) => session === result.value)) continue;
			const session = result.value;
			all.push([session.sessionKey, session]);
			descriptor.invalidateSession?.(session);
			if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
			shutdowns.push(settleShutdown(session, false));
		}
		const results = await Promise.all(shutdowns);
		for (let i = 0; i < all.length; i += 1) {
			const [id, session] = all[i];
			const result = results[i];
			if (result.status === "fulfilled" && result.value?.confirmed !== false) continue;
			const reason = result.status === "rejected" ? result.reason : "not confirmed";
			logger.warn(`${descriptor.languageLabel} kernel shutdown not confirmed`, {
				sessionId: session.sessionId,
				sessionKey: id,
				cwd: session.cwd,
				reason,
			});
			if (!sessions.has(id)) sessions.set(id, session);
		}
	}

	async function disposeByOwner(ownerId: string): Promise<void> {
		const toShutdown: TSession[] = [];
		const startingToShutdown: StartingKernelSession<TSession>[] = [];
		for (const session of [...sessions.values()]) {
			if (!session.ownerIds.has(ownerId)) continue;
			if (session.ownerIds.size === 1) {
				toShutdown.push(session);
				continue;
			}
			session.ownerIds.delete(ownerId);
		}
		for (const [sessionKey, starting] of [...startingSessions.entries()]) {
			if (sessions.has(sessionKey) || !starting.ownerIds.has(ownerId)) continue;
			if (starting.ownerIds.size === 1) {
				startingSessions.delete(sessionKey);
				startingToShutdown.push(starting);
				continue;
			}
			starting.ownerIds.delete(ownerId);
		}
		for (const session of toShutdown) {
			descriptor.invalidateSession?.(session);
			if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
		}
		const shutdowns = toShutdown.map(session => settleShutdown(session, false));
		const started = await Promise.allSettled(startingToShutdown.map(starting => starting.promise));
		for (const result of started) {
			if (result.status !== "fulfilled") continue;
			const session = result.value;
			descriptor.invalidateSession?.(session);
			if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
			toShutdown.push(session);
			shutdowns.push(settleShutdown(session, false));
		}
		const results = await Promise.all(shutdowns);
		for (let i = 0; i < toShutdown.length; i += 1) {
			const session = toShutdown[i];
			const result = results[i];
			if (result.status === "fulfilled" && result.value?.confirmed !== false) {
				session.ownerIds.delete(ownerId);
				continue;
			}
			const reason = result.status === "rejected" ? result.reason : "not confirmed";
			logger.warn(`${descriptor.languageLabel} kernel shutdown not confirmed`, {
				sessionId: session.sessionId,
				sessionKey: session.sessionKey,
				cwd: session.cwd,
				reason,
			});
			if (!sessions.has(session.sessionKey)) sessions.set(session.sessionKey, session);
		}
	}

	async function acquireRetryKernel(
		session: TSession,
		kernel: TKernel,
		cwd: string,
		options: TOptions,
	): Promise<TKernel> {
		if (descriptor.acquireLiveSessionKernel) {
			const retryKernel = await acquireLiveSessionKernel(session, cwd, options);
			if (!isCurrent(session, retryKernel)) throw new descriptor.cancelledErrorClass(false);
			return retryKernel;
		}
		const retryKernel = await acquireDefaultReplacementKernel(session, kernel, cwd, options);
		if (!isCurrent(session) || session.kernel !== retryKernel) {
			throw new descriptor.cancelledErrorClass(false);
		}
		return retryKernel;
	}

	async function executeOnSession(code: string, cwd: string, options: TOptions): Promise<TResult> {
		const sessionId = options.sessionId ?? `session:${cwd}`;
		const sessionKey = resolveOwnerScopedSessionKey({
			baseKey: descriptor.buildSessionKey(sessionId, cwd, options.interpreter),
			ownerId: options.kernelOwnerId,
			reset: options.reset === true,
			hasSession: key => sessions.has(key) || startingSessions.has(key),
			getOwners: key => sessions.get(key) ?? startingSessions.get(key),
		});
		if (options.bridge && !options.bridgeSessionId) {
			options.bridgeSessionId = sessionId;
		}
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
		} else {
			const inFlight = resettingSessions.get(sessionKey);
			if (inFlight) await inFlight.catch(() => undefined);
		}
		const session = await acquireSession(sessionKey, sessionId, cwd, options);
		throwIfCallerCancelled(options);
		const kernel = await acquireLiveSessionKernel(session, cwd, options);
		if (!isCurrent(session, kernel)) throw new descriptor.cancelledErrorClass(false);
		throwIfCallerCancelled(options);
		const runOptions = { ...options, cwd };
		let result: TResult;
		try {
			result = await descriptor.executeWithKernel(kernel, code, runOptions);
		} catch (err) {
			if (
				descriptor.isCancellation?.(err) ||
				isCancellationError(err, descriptor.cancelledErrorClass) ||
				options.signal?.aborted
			)
				throw err;
			if (kernel.isAlive()) throw err;
			const retryKernel = await acquireRetryKernel(session, kernel, cwd, options);
			throwIfCallerCancelled(options);
			return await descriptor.executeWithKernel(retryKernel, code, runOptions);
		}
		if (
			!result.cancelled ||
			options.signal?.aborted ||
			(options.deadlineMs !== undefined && options.deadlineMs <= Date.now()) ||
			kernel.isAlive()
		) {
			return result;
		}
		let retryKernel: TKernel;
		try {
			retryKernel = await acquireRetryKernel(session, kernel, cwd, options);
		} catch (err) {
			const deadlineExpired = options.deadlineMs !== undefined && options.deadlineMs <= Date.now();
			const cancelled = descriptor.isCancellation?.(err) || isCancellationError(err, descriptor.cancelledErrorClass);
			if (deadlineExpired && cancelled) return result;
			throw err;
		}
		throwIfCallerCancelled(options);
		const retryResult = await descriptor.executeWithKernel(retryKernel, code, runOptions);
		if (retryResult.cancelled && options.deadlineMs !== undefined && options.deadlineMs <= Date.now()) {
			return result;
		}
		return retryResult;
	}

	return { disposeAll, disposeByOwner, executeOnSession };
}
