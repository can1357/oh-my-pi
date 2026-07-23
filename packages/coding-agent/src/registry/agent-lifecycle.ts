/**
 * AgentLifecycleManager - Owns the idle → parked → revived lifecycle of
 * adopted subagents.
 *
 * The task executor hands a finished agent over via {@link AgentLifecycleManager.adopt};
 * from then on the manager arms a TTL timer whenever the agent goes `idle`,
 * parks it on expiry (disposes the live session, keeps the AgentRef +
 * sessionFile), and revives it on demand through
 * {@link AgentLifecycleManager.ensureLive}. Only this manager flips
 * `parked` ↔ `idle`.
 */

import { logger } from "@pk-nerdsaver-ai/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID, type RegistryEvent } from "./agent-registry";

export type AgentReviver = () => Promise<AgentSession>;

/**
 * Builds a reviver for a `parked` ref restored from disk (Agent Hub scan,
 * collab mirror, resumed process) that carries a sessionFile but no in-memory
 * adoption. Returns undefined when the ref cannot be faithfully rebuilt (no
 * persisted session contract, or its workspace is gone). Injected from the
 * top-level session so this manager stays free of sdk/SessionManager imports.
 */
export type PersistedSubagentReviverFactory = (ref: AgentRef) => Promise<AgentReviver | undefined>;

export interface AdoptOptions {
	/** TTL before an idle agent is parked. <= 0 disables parking. */
	idleTtlMs: number;
	/** Recreates a live AgentSession from the ref's sessionFile. Absent => not resumable after park (e.g. isolated runs). */
	revive?: AgentReviver;
}

export interface EnsureLiveOptions {
	/** Runs after persisted policy hydration but before the reviver creates or exposes a live session. */
	beforeRevive?: (ref: AgentRef) => void;
}

interface AdoptedAgent {
	idleTtlMs: number;
	revive?: AgentReviver;
	timer?: NodeJS.Timeout;
}

export class AgentLifecycleManager {
	static #global: AgentLifecycleManager | undefined;

	static global(): AgentLifecycleManager {
		if (!AgentLifecycleManager.#global) {
			AgentLifecycleManager.#global = new AgentLifecycleManager();
		}
		return AgentLifecycleManager.#global;
	}

	/** Reset the global manager. Test-only. */
	static resetGlobalForTests(): void {
		const current = AgentLifecycleManager.#global;
		if (current) {
			current.#unsubscribe?.();
			current.#unsubscribe = undefined;
			for (const adopted of current.#adopted.values()) {
				clearTimeout(adopted.timer);
			}
			current.#adopted.clear();
			current.#transitions.clear();
			current.#parking.clear();
			current.#persistedReviverFactory = undefined;
		}
		AgentLifecycleManager.#global = undefined;
	}

	readonly #registry: AgentRegistry;
	readonly #adopted = new Map<string, AdoptedAgent>();
	/** Ids whose session is being disposed by {@link park} right now. */
	readonly #parking = new Set<string>();
	/** Per-agent transition tails; unrelated agents never wait on one another. */
	readonly #transitions = new Map<string, Promise<void>>();
	#unsubscribe: (() => void) | undefined;
	#persistedReviverFactory: PersistedSubagentReviverFactory | undefined;
	/** TTL applied when a cold-revived ref is adopted on demand. */
	#persistedReviveTtlMs = 0;

	constructor(registry: AgentRegistry = AgentRegistry.global()) {
		this.#registry = registry;
		this.#unsubscribe = registry.onChange(event => this.#onRegistryEvent(event));
	}

	/**
	 * Install the factory used to cold-revive `parked` refs restored from disk
	 * (Agent Hub scan, collab mirror, resumed process) — they carry a sessionFile
	 * but no adoption. Set by the top-level session, which owns the ambient deps
	 * (auth, models, MCP, artifacts) the factory needs at revive time.
	 */
	setPersistedSubagentReviverFactory(factory: PersistedSubagentReviverFactory, idleTtlMs: number): void {
		this.#persistedReviverFactory = factory;
		this.#persistedReviveTtlMs = idleTtlMs;
	}

	/**
	 * Take ownership of a finished subagent. Caller has already set registry
	 * status to "idle". Arms the TTL timer (idleTtlMs <= 0 adopts without one).
	 */
	adopt(id: string, opts: AdoptOptions): void {
		if (id === MAIN_AGENT_ID) return;
		if (!this.#registry.get(id)) {
			logger.warn("AgentLifecycleManager.adopt: unknown agent id", { id });
			return;
		}
		const existing = this.#adopted.get(id);
		clearTimeout(existing?.timer);
		const adopted: AdoptedAgent = { idleTtlMs: opts.idleTtlMs, revive: opts.revive };
		this.#adopted.set(id, adopted);
		this.#armTimer(id, adopted);
	}

	/** True if the id is adopted (parked or live). */
	has(id: string): boolean {
		return this.#adopted.has(id);
	}

	/** True while {@link park} is disposing this agent's session (lets dispose hooks distinguish park from teardown). */
	isParking(id: string): boolean {
		return this.#parking.has(id);
	}

	/**
	 * Dispose the live session, detach it from the registry, and mark the
	 * agent `parked`. No-op unless the id is adopted and live.
	 */
	park(id: string): Promise<void> {
		return this.#withTransition(id, async () => {
			const adopted = this.#adopted.get(id);
			if (!adopted) return;
			const ref = this.#registry.get(id);
			if (!ref?.session) return;
			if (adopted.timer) {
				clearTimeout(adopted.timer);
				adopted.timer = undefined;
			}
			this.#parking.add(id);
			try {
				try {
					await ref.session.dispose();
				} catch (error) {
					logger.warn("AgentLifecycleManager.park: session dispose failed", { id, error: String(error) });
				}
				this.#registry.detachSession(id);
				this.#registry.setStatus(id, "parked");
			} finally {
				this.#parking.delete(id);
			}
		});
	}

	/**
	 * Return the live session, reviving from the sessionFile if parked.
	 * Throws a plain Error if the id is unknown or parked without a reviver.
	 * Concurrent calls share one in-flight revive.
	 */
	ensureLive(id: string, options?: EnsureLiveOptions): Promise<AgentSession> {
		return this.#withTransition(id, async () => {
			const ref = this.#registry.get(id);
			if (!ref) {
				throw new Error(
					`Unknown agent "${id}" — it was never registered or has been released. If a transcript exists, read history://${id}.`,
				);
			}
			if (ref.session) return ref.session;
			return this.#resolveAndRevive(id, ref, options);
		});
	}

	/**
	 * Resolve a reviver and bring the agent back to a live session. A ref
	 * restored from disk is `parked` with a sessionFile but no in-memory
	 * adoption; build a reviver via the injected persisted-subagent factory and
	 * adopt it so the agent rejoins the normal idle↔parked lifecycle. Throws
	 * when the agent is not revivable or no reviver can be produced.
	 */
	async #resolveAndRevive(id: string, ref: AgentRef, options?: EnsureLiveOptions): Promise<AgentSession> {
		let revive = this.#adopted.get(id)?.revive;
		let coldAdopted = false;
		if (!revive && ref.status === "parked" && ref.sessionFile && this.#persistedReviverFactory) {
			revive = await this.#persistedReviverFactory(ref);
			if (revive) {
				this.#adopted.set(id, { idleTtlMs: this.#persistedReviveTtlMs, revive });
				coldAdopted = true;
			}
		}
		if (ref.status !== "parked" || !revive) {
			throw new Error(
				`Agent "${id}" is ${ref.status} and cannot be revived${revive ? "" : " (no reviver registered)"}. Its transcript remains readable at history://${id}.`,
			);
		}
		// A persisted factory hydrates ref.collaborationPolicy before returning its
		// reviver. Run delivery authorization now, before session construction can
		// re-register the ref as running or the lifecycle marks it idle.
		options?.beforeRevive?.(ref);
		try {
			return await this.#revive(id, revive, ref.sessionFile);
		} catch (error) {
			// A failed cold revive (stale ctx, missing cwd, bad MCP) must not leave a
			// poisoned reviver stuck in #adopted — drop it so a later ensureLive
			// rebuilds via the factory (which may have fresher context by then).
			if (coldAdopted) this.#adopted.delete(id);
			throw error;
		}
	}

	/** Hard removal: dispose if live, unregister from registry, drop timers. */
	release(id: string): Promise<void> {
		return this.#withTransition(id, async () => {
			const adopted = this.#adopted.get(id);
			clearTimeout(adopted?.timer);
			this.#adopted.delete(id);
			const ref = this.#registry.get(id);
			if (ref?.session) {
				try {
					await ref.session.dispose();
				} catch (error) {
					logger.warn("AgentLifecycleManager.release: session dispose failed", { id, error: String(error) });
				}
			}
			this.#registry.unregister(id);
		});
	}

	/** Teardown everything (process exit / main session dispose). */
	async dispose(): Promise<void> {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		const ids = [...this.#adopted.keys()];
		await Promise.all(ids.map(id => this.release(id)));
		this.#parking.clear();
		this.#persistedReviverFactory = undefined;
	}

	async #revive(id: string, revive: AgentReviver, sessionFile: string | null): Promise<AgentSession> {
		const session = await revive();
		// attachSession copies the hydrated session policy onto the ref before the
		// following idle transition makes it visible to live-peer roster APIs.
		this.#registry.attachSession(id, session, sessionFile);
		// Emits status_changed → "idle", which re-arms the TTL timer below.
		this.#registry.setStatus(id, "idle");
		return session;
	}

	/**
	 * Serialize state-changing work for one registry id. A transition observes
	 * the state left by its predecessor, while other ids proceed independently.
	 */
	#withTransition<T>(id: string, transition: () => Promise<T>): Promise<T> {
		const previous = this.#transitions.get(id);
		const { promise: current, resolve: finish } = Promise.withResolvers<void>();
		this.#transitions.set(id, current);

		const { promise: result, resolve: resolveResult, reject: rejectResult } = Promise.withResolvers<T>();
		const run = async (): Promise<void> => {
			try {
				resolveResult(await transition());
			} catch (error) {
				rejectResult(error);
			} finally {
				// Resolve the caller before admitting the next transition. In
				// particular, park must not start disposing a session before the
				// ensureLive caller can observe the session it just revived.
				finish();
				if (this.#transitions.get(id) === current) this.#transitions.delete(id);
			}
		};
		if (previous) void previous.then(run);
		else void run();
		return result;
	}

	#armTimer(id: string, adopted: AdoptedAgent): void {
		if (adopted.idleTtlMs <= 0) return;
		clearTimeout(adopted.timer);
		const timer = setTimeout(() => {
			adopted.timer = undefined;
			void this.park(id);
		}, adopted.idleTtlMs);
		timer.unref?.();
		adopted.timer = timer;
	}

	#onRegistryEvent(event: RegistryEvent): void {
		const adopted = this.#adopted.get(event.ref.id);
		if (!adopted) return;
		if (event.type === "removed") {
			clearTimeout(adopted.timer);
			this.#adopted.delete(event.ref.id);
			return;
		}
		if (event.type !== "status_changed") return;
		if (event.ref.status === "running") {
			if (adopted.timer) {
				clearTimeout(adopted.timer);
				adopted.timer = undefined;
			}
		} else if (event.ref.status === "idle") {
			this.#armTimer(event.ref.id, adopted);
		}
	}
}
