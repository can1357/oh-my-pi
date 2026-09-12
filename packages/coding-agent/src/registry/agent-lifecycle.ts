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
 *
 * Park/dispose is gated against concurrent ensureLive/hub-send:
 * - A disposing session is never handed out.
 * - ensureLive during an in-flight park either cancels the park (session still
 *   live) or waits for detach+park and then revives.
 * - Concurrent ensureLive/park operations coalesce per id.
 *
 * Every adoption, park, and revival is bound to the exact {@link AgentRef} it
 * started from, so stale async work (a late finalizer, a cancelled initializer,
 * a superseded revive) can never clobber a newer same-id ref.
 */

import * as fs from "node:fs/promises";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import type { RestartHandoffOutcome } from "../session/agent-session-types";
import { trackLateCleanup } from "../utils/late-cleanup";
import {
	type AgentRef,
	type AgentRefExpectation,
	AgentRegistry,
	getAgentTombstonePath,
	MAIN_AGENT_ID,
	type RegistryEvent,
} from "./agent-registry";

export type AgentReviver = (expected: AgentRef) => Promise<AgentSession>;

const AGENT_RELEASE_GRACE_MS = 5000;

async function persistAgentTombstone(sessionFile: string): Promise<void> {
	try {
		await fs.writeFile(getAgentTombstonePath(sessionFile), "", { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

/**
 * Builds a reviver for a `parked` ref restored from disk (Agent Hub scan,
 * collab mirror, resumed process) that carries a sessionFile but no in-memory
 * adoption. Returns undefined when the ref cannot be faithfully rebuilt (no
 * persisted session contract, or its workspace is gone). Injected from the
 * top-level session so this manager stays free of sdk/SessionManager imports.
 */
export type PersistedSubagentReviverFactory = (ref: AgentRef) => Promise<AgentReviver | undefined>;

/** Releases a parking barrier, reporting how the recycle that raised it ended. */
export type ParkingBarrierRelease = (outcome?: RestartHandoffOutcome) => void;

export interface AdoptOptions {
	/** TTL before an idle agent is parked. <= 0 disables parking. */
	idleTtlMs: number;
	/** Recreates a live AgentSession from the ref's sessionFile. Absent => not resumable after park (e.g. isolated runs). */
	revive?: AgentReviver;
}

interface AdoptedAgent {
	ref: AgentRef;
	idleTtlMs: number;
	revive?: AgentReviver;
	timer?: NodeJS.Timeout;
	/**
	 * True once {@link AgentLifecycleManager.parkAll} carried this adoption
	 * across a parent recycle. {@link revive} was captured by the parent's
	 * spawn and closes over that parent's spawn-time dependencies — its MCP
	 * manager, artifact manager and session — which the parent's own teardown
	 * disconnected, so rebuilding a child through it produces a session bound to
	 * resources that are gone. Revival therefore goes through the
	 * persisted-reviver factory, which the replacement parent installs and which
	 * re-derives those dependencies. {@link revive} is kept only so the record
	 * still names one reviver — the factory OVERWRITES it, clearing this flag —
	 * and is never invoked while the flag is set: with no factory the revival is
	 * refused instead, because a child on the recycled parent's disposed
	 * resources fails at its first tool call with nothing to retry.
	 */
	reviverStale?: boolean;
}

interface ParkInFlight {
	/** The exact ref this park was started for. */
	ref: AgentRef;
	/** Resolves when the park attempt finishes (success, cancel, or dispose error). */
	promise: Promise<void>;
	/** Cancel before the session is detached. Returns true if cancel took effect. */
	cancel: () => boolean;
	/** True once cancel() succeeded (ensureLive kept the live session). */
	cancelled: boolean;
	/** True once the live session has been detached and status is parked. */
	detached: boolean;
}

/**
 * Shared by an in-flight revival and the {@link AgentLifecycleManager.parkAll}
 * pre-pass that may abandon its wait on it. `fenced` is set when the pre-pass
 * gives up at the parking deadline: the revival then runs on past the point
 * where the recycle snapshotted which agents to park, so nothing will ever park
 * the session it is about to build. A fenced revival therefore refuses to
 * attach and fails its waiter instead.
 */
interface RevivalFence {
	fenced: boolean;
}

interface RevivingAgent {
	ref: AgentRef;
	promise: Promise<AgentSession>;
	fence: RevivalFence;
}

/**
 * One live all-agent parking handoff, held from its {@link
 * AgentLifecycleManager.parkAll} entry until its own caller releases it.
 *
 * Carries only the promise its release resolves. The handoff's OUTCOME is
 * deliberately NOT stored here: a release deletes its entry from
 * `#parkingBarriers` before resolving, so an outcome hung off the entry is
 * readable only by a waiter that already holds a reference to that exact
 * object — and a waiter racing several barriers does not hold one for every
 * recycle it overlaps. A failure is latched on the manager instead
 * ({@link AgentLifecycleManager.#handoffFailed}), where it outlives both the
 * entry that produced it and every call that raced it.
 */
interface ParkingBarrier {
	promise: Promise<void>;
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
			current.#revivals.clear();
			current.#parks.clear();
			current.#persistedReviverFactory = undefined;
		}
		AgentLifecycleManager.#global = undefined;
	}

	readonly #registry: AgentRegistry;
	readonly #adopted = new Map<string, AdoptedAgent>();
	/**
	 * In-flight park attempts, each bound to the ref it started from. A park is
	 * cancelable until the live session is detached; after detach, ensureLive
	 * waits for the park and revives.
	 */
	readonly #parks = new Map<string, ParkInFlight>();
	/** In-flight revives, bound to the parked ref that initiated them, so concurrent {@link ensureLive} calls coalesce. */
	readonly #revivals = new Map<string, RevivingAgent>();
	#unsubscribe: (() => void) | undefined;
	#persistedReviverFactory: PersistedSubagentReviverFactory | undefined;
	/** TTL applied when a cold-revived ref is adopted on demand. */
	#persistedReviveTtlMs = 0;
	/** Set once {@link dispose} runs; blocks late revivals from adopting into a torn-down manager. */
	#disposed = false;
	/**
	 * Every live all-agent parking handoff, each held from its {@link parkAll}
	 * entry until its own caller releases it. Unlike {@link park}, that call is
	 * an all-agent BARRIER — the parent session is recycling, and its teardown
	 * disposes the shared resources (kernels, MCP, LSP) every child borrows — so
	 * it has to mean no child session is live AND none can become live.
	 * {@link ensureLive} waits them out instead of cancelling the park it would
	 * otherwise win. Each spans its own parent's whole teardown, not just the
	 * parking, because the shared resources are disposed after `parkAll()`
	 * returns.
	 *
	 * A SET rather than one promise because two callback-enabled top-level
	 * sessions can recycle at once, and the handoffs need not finish in the
	 * order they started. A single field would be overwritten by the second
	 * call, so a second handoff releasing first would reopen revival while the
	 * first parent is still tearing down — and the first release could no longer
	 * restore the protection it was promised. Revival stays blocked until the
	 * LAST entry is gone; each handoff remains bounded by its own deadline,
	 * because the deadline governs `parkAll()`'s internal waits, never this set.
	 */
	readonly #parkingBarriers = new Set<ParkingBarrier>();

	/**
	 * Latched while the most recent recycle released with `"failed"` — a handoff
	 * that disposed its children's shared dependencies and produced no
	 * replacement parent to own the successors.
	 *
	 * Latched on the MANAGER, not on the {@link ParkingBarrier}, because a
	 * release drops its entry from `#parkingBarriers` before resolving. An
	 * outcome kept on the entry is therefore only ever read by a waiter holding
	 * that exact object, and a waiter does not hold one for every recycle it
	 * overlaps: a barrier raised and failed inside one of `ensureLive`'s other
	 * awaits — a park settling, a sibling barrier resolving first — is gone from
	 * the set before anything looks, so its failure would read as a clean
	 * handoff.
	 *
	 * RETAINED state rather than a count compared against a per-call baseline.
	 * What the failure destroyed is not an event a caller can miss but a
	 * condition that persists: the shared MCP, kernels and session every parked
	 * child would be rebuilt on are gone, and stay gone until something rebuilds
	 * them. A delta only refuses the calls that happened to be in flight across
	 * the barrier — a call STARTING after the failure settled samples a baseline
	 * that already includes it, sees no movement, and proceeds through the stale
	 * retained reviver. The flag has no baseline to slip past.
	 *
	 * Cleared by {@link setPersistedSubagentReviverFactory} and by nothing else;
	 * see there for why that event, and only that event, proves the revival
	 * dependencies are live again. A later CLEAN recycle deliberately does not
	 * clear it: parking children with no new factory installed rebuilds nothing
	 * the failure disposed.
	 */
	#handoffFailed = false;

	constructor(registry: AgentRegistry = AgentRegistry.global()) {
		this.#registry = registry;
		this.#unsubscribe = registry.onChange(event => this.#onRegistryEvent(event));
	}

	/**
	 * Install the factory used to cold-revive `parked` refs restored from disk
	 * (Agent Hub scan, collab mirror, resumed process) — they carry a sessionFile
	 * but no adoption. Set by the top-level session, which owns the ambient deps
	 * (auth, models, MCP, artifacts) the factory needs at revive time.
	 *
	 * This is also the one event that clears {@link #handoffFailed}. After a
	 * recycle whose reattachment produced no replacement parent, BOTH routes back
	 * to a live session belong to the parent that went away: the retained reviver
	 * closes over it, and the factory that would supersede that reviver is its
	 * own, because no new parent installed one. Installing a factory IS a live
	 * parent binding the revival dependencies to itself — it is built from that
	 * session's auth, models, MCP and artifact managers, so its existence is the
	 * proof the refusal was waiting for. Nothing weaker qualifies: a barrier
	 * lifting, a later clean recycle, or time passing all leave the disposed
	 * resources disposed.
	 *
	 * Clearing the flag does NOT unmark the stale retained revivers the failed
	 * recycle left behind, so the revival it re-admits still rebuilds through
	 * this factory rather than the closure it supersedes.
	 */
	setPersistedSubagentReviverFactory(factory: PersistedSubagentReviverFactory, idleTtlMs: number): void {
		this.#persistedReviverFactory = factory;
		this.#persistedReviveTtlMs = idleTtlMs;
		this.#handoffFailed = false;
	}

	/**
	 * Take ownership of a finished subagent. Caller has already set registry
	 * status to "idle". Arms the TTL timer (idleTtlMs <= 0 adopts without one).
	 * When `expected` is given, the adoption is refused if the id no longer
	 * resolves to that ref (or that ref's session).
	 */
	adopt(id: string, opts: AdoptOptions, expected?: AgentRefExpectation): void {
		if (id === MAIN_AGENT_ID) return;
		const ref = this.#registry.get(id);
		if (!ref || (expected !== undefined && ref !== expected && ref.session !== expected)) {
			logger.warn("AgentLifecycleManager.adopt: unknown or replaced agent id", { id });
			return;
		}
		const existing = this.#adopted.get(id);
		clearTimeout(existing?.timer);
		const adopted: AdoptedAgent = { ref, idleTtlMs: opts.idleTtlMs, revive: opts.revive };
		this.#adopted.set(id, adopted);
		this.#armTimer(id, adopted);
	}

	/** True if the id is adopted (parked or live) — and, when `expected` is given, still bound to that ref. */
	has(id: string, expected?: AgentRefExpectation): boolean {
		const adopted = this.#adopted.get(id);
		return Boolean(
			adopted && (expected === undefined || adopted.ref === expected || adopted.ref.session === expected),
		);
	}

	/**
	 * Reclaim a provably-dead parked corpse so a fresh spawn can reuse its id.
	 * Refuses live, adopted, in-flight, or cold-revivable refs. For a parked ref
	 * restored from disk, the persisted factory is consulted before removal
	 * because cold revivers are created lazily by {@link ensureLive}.
	 *
	 * Only refs in the registry this manager owns are touched; the transcript
	 * stays readable at `history://<id>`. Returns true when the corpse was
	 * unregistered.
	 */
	async reclaimDeadCorpse(id: string, expected: AgentRef): Promise<boolean> {
		const ref = this.#registry.get(id);
		if (ref !== expected || ref.status !== "parked" || ref.session) return false;
		if (this.#adopted.has(id) || this.#parks.has(id) || this.#revivals.has(id)) return false;

		const persistedFactory = ref.sessionFile ? this.#persistedReviverFactory : undefined;
		if (persistedFactory) {
			try {
				if (await persistedFactory(ref)) return false;
			} catch (error) {
				logger.warn("AgentLifecycleManager.reclaimDeadCorpse: persisted reviver probe failed", {
					id,
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			}
			// The factory awaited I/O; another lifecycle operation may now own or
			// have replaced this ref. Revalidate every reclaim invariant.
			if (this.#registry.get(id) !== ref || ref.status !== "parked" || ref.session) return false;
			if (this.#adopted.has(id) || this.#parks.has(id) || this.#revivals.has(id)) return false;
		}
		return this.#registry.unregister(id, ref);
	}

	/**
	 * True when this manager owns `registry` — i.e. its adopt/park/revive state
	 * describes that registry's refs. Lets a caller holding a specific registry
	 * (e.g. a custom-registry {@link IrcBus} that fell back to the global
	 * manager) skip lifecycle gating that would consult unrelated park state.
	 */
	manages(registry: AgentRegistry): boolean {
		return this.#registry === registry;
	}

	/**
	 * True while {@link park} is disposing this agent's session (lets dispose
	 * hooks distinguish park from teardown). False once the park is cancelled
	 * by ensureLive or after detach+dispose completes. When `expected` is
	 * given, only a park bound to that ref (or its session) counts.
	 */
	isParking(id: string, expected?: AgentRefExpectation): boolean {
		const park = this.#parks.get(id);
		return Boolean(
			park && !park.cancelled && (expected === undefined || park.ref === expected || park.ref.session === expected),
		);
	}

	/**
	 * Dispose the live session, detach it from the registry, and mark the
	 * agent `parked`. No-op unless the id is adopted and live.
	 *
	 * The session is detached (and status flipped to `parked`) *before*
	 * `session.dispose()` so concurrent {@link ensureLive}/hub-send never
	 * observe or inject into a disposing session. A concurrent ensureLive that
	 * arrives before detach cancels the park and keeps the live session.
	 */
	async park(id: string): Promise<void> {
		const existing = this.#parks.get(id);
		if (existing) return existing.promise;

		const adopted = this.#adopted.get(id);
		if (!adopted) return;
		const ref = this.#registry.get(id);
		if (!ref || adopted.ref !== ref) return;
		const session = ref.session;
		if (!session) return;

		if (adopted.timer) {
			clearTimeout(adopted.timer);
			adopted.timer = undefined;
		}

		let cancelled = false;
		const park: ParkInFlight = {
			ref,
			promise: undefined as unknown as Promise<void>,
			cancel: () => {
				// Cancel only before detach — once detached the old session is already
				// leaving the registry and must finish disposing.
				if (park.detached || cancelled) return cancelled;
				cancelled = true;
				park.cancelled = true;
				// Retire the entry synchronously. A cancelled park no longer leads to
				// a detached session, and `park()` hands an EXISTING entry back
				// rather than starting a fresh attempt, so a later caller awaiting it
				// would read completion over a session that is still attached. That
				// is precisely what an all-agent barrier must never do: `parkAll()`
				// snapshots the ids to park in the same turn it is entered, while
				// this entry is still registered, and its resolution is read as "no
				// child session is live". The park body's own cleanup is guarded on
				// still being the registered entry, so retiring early cannot clobber
				// the fresh attempt that replaces us.
				if (this.#parks.get(id) === park) this.#parks.delete(id);
				return true;
			},
			cancelled: false,
			detached: false,
		};

		park.promise = (async () => {
			try {
				// Yield so a same-tick ensureLive/hub-send can cancel before we
				// commit to dispose. Deterministic with Promise microtasks; no timers.
				await Promise.resolve();
				if (cancelled) return;

				// Re-check liveness: release/unregister/replace may have raced us.
				const live = this.#registry.get(id);
				if (live !== ref || !live.session || live.session !== session) return;
				if (this.#adopted.get(id)?.ref !== ref) return;

				// Commit: detach + parked *before* dispose so callers never see a
				// dying session via ref.session / idle status.
				park.detached = true;
				this.#registry.detachSession(id, ref);
				this.#registry.setStatus(id, "parked", ref);

				try {
					await session.dispose();
				} catch (error) {
					logger.warn("AgentLifecycleManager.park: session dispose failed", { id, error: String(error) });
				}
			} finally {
				// Only clear if we are still the in-flight entry (a later park would
				// have replaced us only after we resolved).
				if (this.#parks.get(id) === park) this.#parks.delete(id);
			}
		})();

		this.#parks.set(id, park);
		return park.promise;
	}

	/**
	 * Return the live session, reviving from the sessionFile if parked.
	 * Throws a plain Error if the id is unknown or parked without a reviver.
	 * Concurrent calls share one in-flight revive.
	 *
	 * Never returns a session that is mid-dispose: an in-flight park is either
	 * cancelled (session still live) or awaited to completion before revive.
	 * Every live all-agent {@link parkAll} barrier is waited out first, rather
	 * than cancelling its park the way an ordinary {@link park} may be
	 * cancelled. The caller is not refused — once they have all released this
	 * falls through to the normal revive path, so a hub `send` racing a parent
	 * recycle is delayed, not dropped. Cancelling instead would let `parkAll()`
	 * report completion with this session still attached, and the parent's
	 * teardown would then dispose the shared resources under it.
	 *
	 * That check is a LOOP, not a one-time pre-pass, because awaiting a park is
	 * itself a window a recycle can start in. A caller arriving while a per-agent
	 * park is already committed passes the entry check with no barrier live, then
	 * parks on that park; a `parkAll()` raising its barrier during the await is
	 * invisible to both the fence (this revival is not in `#revivals` yet, so the
	 * pre-pass cannot mark it) and the parking snapshot (which only joins the
	 * park already in flight). Resuming straight into a revive would hand back a
	 * live child while the parent tears down the shared resources it borrows —
	 * the exact state the barrier exists to exclude. So the barriers are
	 * re-consulted after EVERY park await, on the returning path as well as the
	 * reviving one: keeping a cancelled park's still-attached session is the same
	 * violation as building a new one.
	 *
	 * A handoff that ends without a replacement parent FAILS the waiter instead
	 * of releasing it into a revive. Reattachment having thrown means the shared
	 * dependencies of every parked child were disposed and nothing took their
	 * successors over, so both routes back to a live session are stale at once:
	 * the retained reviver closes over the disposed parent, and the factory that
	 * would have replaced it is that same parent's, because no new one installed
	 * its own. Reviving through either produces a child bound to a disconnected
	 * MCP and dead kernels — worse than a clean refusal, which a host can answer
	 * by rebuilding a parent and calling again. An already-attached session is
	 * still handed back: it needs no reviver, and refusing a live child would
	 * lose work the recycle never touched.
	 *
	 * Bounded: each iteration either observes a distinct settled park or waits
	 * out barriers whose own `parkAll()` is already past its deadline-bounded
	 * waits, so this adds no wait that a caller's release does not end.
	 */
	async ensureLive(id: string): Promise<AgentSession> {
		// Each pass: wait out every live barrier, then deal with at most one park.
		// Re-running the barrier wait after the park settles is what closes the
		// window a recycle can open DURING that await. The loop terminates because
		// a settled park is retired from `#parks` — by its own cleanup, or
		// synchronously by `cancel()` — so a pass that awaited one cannot find the
		// same entry again, and a pass that finds none falls straight through.
		for (;;) {
			if (this.#parkingBarriers.size > 0) await this.#awaitParkingBarriers();

			const park = this.#parks.get(id);
			if (!park) break;
			const parked = this.#registry.get(id);
			// Cancel if the live session is still attached — keep it instead of
			// thrashing dispose + revive.
			if (parked?.session && !park.detached && park.cancel()) {
				await park.promise;
				// Only hand the kept session back if no recycle raised a barrier
				// while we waited. If one did, loop: waiting it out and re-reading
				// the ref is the same treatment a revival gets, and returning a
				// still-attached child would violate the same exclusion.
				if (this.#parkingBarriers.size === 0) {
					const kept = this.#registry.get(id)?.session;
					if (kept) {
						// Park cleared the idle timer; re-arm so TTL park still works.
						const adopted = this.#adopted.get(id);
						if (adopted && adopted.ref === parked && parked.status === "idle") this.#armTimer(id, adopted);
						return kept;
					}
					break;
				}
			} else {
				// Already committed to detach (or no live session): wait for park,
				// then re-check the barriers before falling through to revive.
				await park.promise;
			}
		}

		const ref = this.#registry.get(id);
		if (!ref) {
			throw new Error(
				`Unknown agent "${id}" — it was never registered or has been released. If a transcript exists, read history://${id}.`,
			);
		}
		if (ref.session) return ref.session;
		// Past this point a live session is the only thing that can be returned
		// without a reviver, so this is where a failed handoff has to stop. Placed
		// AFTER the attached-session check deliberately: a child that is still
		// live borrows nothing from the parent that failed to come back, and
		// refusing it would throw away work the recycle never touched.
		//
		// Read as RETAINED state, never as a delta against an entry-time sample.
		// Two readings a sample gets wrong, in opposite directions: a call that
		// starts after the failure settled already carries it in its own baseline
		// and sees no movement, and reading an outcome off each barrier this call
		// awaited misses every recycle that starts and finishes inside one of the
		// OTHER awaits above (a park settling, a sibling barrier resolving first),
		// because the release drops its entry before resolving and leaves nothing
		// to read. The flag survives both — set before the entry is dropped, and
		// held until a replacement rebinds the revival dependencies.
		if (this.#handoffFailed) {
			throw new Error(
				`Agent "${id}" cannot be revived: its parent session was recycled but the replacement failed to attach, so the shared resources it would be rebuilt on are gone. Its transcript remains readable at history://${id}.`,
			);
		}
		const inflight = this.#revivals.get(id);
		if (inflight?.ref === ref) return inflight.promise;
		// The fence is a separate object so it exists BEFORE the revive starts:
		// `parkAll()`'s pre-pass sets it through the `#revivals` entry, and
		// `#revive` reads the same object, so the two never race over which
		// revival was abandoned.
		const fence: RevivalFence = { fenced: false };
		const pending: RevivingAgent = { ref, promise: this.#resolveAndRevive(id, ref, fence), fence };
		this.#revivals.set(id, pending);
		try {
			return await pending.promise;
		} finally {
			if (this.#revivals.get(id) === pending) this.#revivals.delete(id);
		}
	}

	/**
	 * Block until no all-agent parking handoff is live.
	 *
	 * Loops rather than awaiting one snapshot: a release removes only its own
	 * entry, and a fresh `parkAll()` can raise another while we are parked on an
	 * earlier one, so the set has to be re-read after every settle. Each await
	 * is on a barrier whose own `parkAll()` is already past its deadline-bounded
	 * waits — the deadline bounds that call's internal work, never how long its
	 * caller holds the handoff — so this wait cannot make a recycle wedge that
	 * would otherwise complete.
	 *
	 * Callers guard on `#parkingBarriers.size` so the common no-barrier case
	 * costs no microtask at all. That is load-bearing for {@link ensureLive}:
	 * `park()` yields exactly once before committing to detach, so an
	 * ensureLive() arriving in the same tick has to reach the cancel inside that
	 * single turn. Awaiting even an immediately-resolved promise here spends the
	 * turn and the park detaches instead of being cancelled.
	 *
	 * Reports nothing. Whether a waited-out handoff ended WITHOUT a replacement
	 * parent is read off {@link #handoffFailed} instead, because the outcome has
	 * to survive both a barrier entry that its own release deletes and every
	 * caller that never held that entry.
	 */
	async #awaitParkingBarriers(): Promise<void> {
		while (this.#parkingBarriers.size > 0) {
			// SNAPSHOT, not the live Set: a release drops its own entry BEFORE
			// resolving, so an iterator over the live Set skips every barrier that
			// releases while we are parked on an earlier one. Awaiting a snapshot
			// makes "every barrier live at this point" the unit, and the outer
			// re-read then covers only one raised after the snapshot was taken.
			for (const barrier of [...this.#parkingBarriers]) await barrier.promise;
		}
	}

	/**
	 * Resolve a reviver and bring the agent back to a live session. A ref
	 * restored from disk is `parked` with a sessionFile but no in-memory
	 * adoption; build a reviver via the injected persisted-subagent factory and
	 * adopt it so the agent rejoins the normal idle↔parked lifecycle. Throws
	 * when the agent is not revivable or no reviver can be produced.
	 *
	 * An adoption carried across a parent recycle ({@link AdoptedAgent.reviverStale})
	 * can ONLY come back through the factory: its retained reviver was captured
	 * by the parent whose teardown drove the recycle and closes over that
	 * parent's spawn-time dependencies, while the factory belongs to the
	 * replacement. The factory's reviver then REPLACES the retained one on the
	 * same adoption record rather than being kept beside it, so one adopted
	 * agent has exactly one reviver and a later park cannot revive through the
	 * stale closure again.
	 *
	 * With no factory installed a stale adoption is REFUSED rather than revived
	 * through the closure. The refusal is the honest answer: a host that follows
	 * the documented reconstruction with `createAgentSession` installs no
	 * factory of its own (the only production caller is the CLI bootstrap, whose
	 * path deliberately does not wire restart), so "no factory" is the ordinary
	 * state on the SDK path rather than a rare one — and reviving there rebuilds
	 * the child on the recycled parent's disposed MCP manager, artifact manager
	 * and session. A refusal leaves the transcript readable and the ref parked
	 * for a later revival once a factory exists; a session on dead resources
	 * fails at its first tool call with nothing to retry.
	 */
	async #resolveAndRevive(id: string, ref: AgentRef, fence: RevivalFence): Promise<AgentSession> {
		let adoption = this.#adopted.get(id);
		if (adoption?.ref !== ref) adoption = undefined;
		let revive = adoption?.reviverStale ? undefined : adoption?.revive;
		let coldAdopted = false;
		if (!revive && ref.status === "parked" && ref.sessionFile && this.#persistedReviverFactory) {
			revive = await this.#persistedReviverFactory(ref);
			// Teardown can complete during the factory await. A late cold revive must
			// not cold-adopt (and later attach a live session + TTL) into a disposed
			// manager — reject deterministically before creating any session.
			if (this.#disposed) {
				throw new Error(
					`Agent "${id}" revival aborted: its lifecycle was disposed while its persisted session was being prepared.`,
				);
			}
			// Rebind in place ONLY for an adoption carried across a recycle: that
			// record is the one whose closure went stale, and replacing it keeps a
			// single reviver per agent. An adoption that never had a reviver at all
			// (an isolated or worktree subagent, which `adopt` stores with
			// `revive: undefined`) is NOT that case — it takes the cold-adopt path
			// below so it picks up the persisted-revive TTL and the poisoned-reviver
			// cleanup that a first-time factory revival needs.
			if (revive && adoption?.reviverStale) {
				adoption.revive = revive;
				adoption.reviverStale = false;
			} else if (revive) {
				adoption = { ref, idleTtlMs: this.#persistedReviveTtlMs, revive };
				this.#adopted.set(id, adoption);
				coldAdopted = true;
			}
		}
		// A stale reviver is never invoked: with no factory (or one that declined
		// this ref) there is no live parent to rebuild against, so the agent stays
		// parked and the caller is told why.
		if (!revive && adoption?.reviverStale) {
			throw new Error(
				`Agent "${id}" cannot be revived: its reviver belongs to a session that has been recycled, and no persisted-subagent reviver factory is installed to rebuild it. Its transcript remains readable at history://${id}.`,
			);
		}
		if (this.#registry.get(id) !== ref) {
			throw new Error(`Agent "${id}" changed while its persisted session was being prepared.`);
		}
		if (ref.status !== "parked" || !revive || !adoption) {
			throw new Error(
				`Agent "${id}" is ${ref.status} and cannot be revived${revive ? "" : " (no reviver registered)"}. Its transcript remains readable at history://${id}.`,
			);
		}
		try {
			return await this.#revive(id, revive, ref, adoption, fence);
		} catch (error) {
			// A failed cold revive (stale ctx, missing cwd, bad MCP) must not leave a
			// poisoned reviver stuck in #adopted — drop it so a later ensureLive
			// rebuilds via the factory (which may have fresher context by then).
			if (coldAdopted && this.#adopted.get(id) === adoption) this.#adopted.delete(id);
			throw error;
		}
	}

	/**
	 * Dispose if live and drop timers. When `expected` is given, only a ref
	 * matching it is released; a stale release can never take down a newer
	 * same-id ref. Returns true when a matching ref was released.
	 *
	 * By default the ref is unregistered (teardown / one-shot removal). Pass
	 * `tombstone: true` for an explicit kill: the ref is kept registered as a
	 * terminal `aborted` row (session detached) instead of being removed, so a
	 * later persisted-subagent scan (e.g. Agent Hub reopen) skips it via its
	 * `if (!registry.get(id))` guard rather than re-adopting the surviving
	 * on-disk transcript as a fresh `parked` row. Mirrors
	 * `finalizeSubagentLifecycle`'s genuine-kill path.
	 */
	async release(id: string, expected?: AgentRefExpectation, options?: { tombstone?: boolean }): Promise<boolean> {
		const adopted = this.#adopted.get(id);
		const current = this.#registry.get(id);
		const currentMatches =
			current && (expected === undefined || current === expected || current.session === expected);
		const adoptedMatches =
			adopted && (expected === undefined || adopted.ref === expected || adopted.ref.session === expected);
		const ref = currentMatches ? current : adoptedMatches ? adopted.ref : undefined;
		if (!ref) return false;
		if (adopted?.ref === ref) {
			clearTimeout(adopted.timer);
			this.#adopted.delete(id);
		}

		const park = this.#parks.get(id);
		if (park && park.ref === ref) {
			// Prefer cancel when the session is still live so release owns dispose.
			if (!park.detached) park.cancel();
			await park.promise;
		}

		const live = this.#registry.get(id) === ref ? ref.session : null;
		if (options?.tombstone) {
			// Apply the terminal transition synchronously, before any await. The
			// dying session's own dispose path calls unregisterUnlessParked
			// (sdk.ts), which spares a ref only when it is already `aborted` AND
			// already detached; awaiting persistAgentTombstone before this
			// transition left a window in which that unregister deleted the ref
			// (issue #10531). Persisting the sidecar afterward is safe: within the
			// process the still-registered `aborted` row already blocks re-adoption
			// via the `if (!registry.get(id))` discovery guard, and the sidecar
			// only needs to exist before a later cross-restart discovery pass —
			// release awaits the write below before returning.
			// Detach before publishing `aborted`: setStatus emits synchronously, so
			// every subscriber must observe a terminal ref with session === null.
			if (!this.#registry.detachSession(id, ref) || !this.#registry.setStatus(id, "aborted", ref)) {
				logger.warn("AgentLifecycleManager.release: terminal transition rejected", { id });
			}
		}
		try {
			if (options?.tombstone && ref.sessionFile) await persistAgentTombstone(ref.sessionFile);
		} finally {
			// Detaching removes the registry's only route to the live session. Always
			// dispose the captured session, even when tombstone persistence fails.
			if (live) {
				try {
					await live.dispose();
				} catch (error) {
					logger.warn("AgentLifecycleManager.release: session dispose failed", { id, error: String(error) });
				}
			}
		}
		if (!options?.tombstone) this.#registry.unregister(id, ref);
		return true;
	}

	/**
	 * Park every adopted agent WITHOUT tearing the manager down — the recycle
	 * counterpart to {@link dispose}.
	 *
	 * A cooperative session restart recycles only the parent session, but the
	 * parent's teardown path runs the process-level {@link dispose}, which
	 * `release()`s and UNREGISTERS every adopted agent: after the replacement
	 * session attaches, those agents can no longer be resumed or addressed even
	 * though restart never claimed to touch them. Parking is the transition the
	 * lifecycle already owns for "idle for a while": the live session is disposed
	 * (so it does not outlive the parent's shared resources) while the AgentRef
	 * and its sessionFile stay registered, so {@link ensureLive} revives the agent
	 * on demand after the recycle.
	 *
	 * `#disposed` stays clear and the global instance is NOT dropped: the
	 * replacement session resolves the same `global()` manager and finds the
	 * parked rows. The persisted-subagent reviver factory is left in place too —
	 * the replacement re-installs its own, and clearing it here would strand a
	 * revive requested between the two.
	 *
	 * EXCLUSIVE with revival from entry until the returned release is called,
	 * which plain per-id {@link park} calls cannot be. `park()` deliberately
	 * yields before detaching so a concurrent {@link ensureLive}/hub-send can
	 * cancel it and keep the live session — correct for a TTL park, wrong for
	 * this barrier, whose resolution the caller reads as "no child session is
	 * live" before disposing the shared resources they all borrow.
	 * `#parkingBarriers` makes `ensureLive()` wait instead of cancel, and the
	 * pre-pass below settles revivals that are already in flight: a cold revival
	 * is adopted only once its reviver resolves, so its id appears in neither
	 * `#adopted` nor `#parks` and `park()` would no-op against a ref with no
	 * attached session yet.
	 *
	 * Overlapping calls COMPOSE rather than replacing one another: two
	 * callback-enabled top-level sessions can recycle at once, so each handoff
	 * holds its own entry and revival stays blocked until the last of them
	 * releases, whichever order they finish in.
	 *
	 * Parking every child is only the FIRST half of the recycle, so the barrier
	 * outlives this call: the caller tears the shared kernels/MCP/LSP down
	 * *after* awaiting it, and a waiter released at that point would revive a
	 * child onto resources that are already being disposed. So the barrier is
	 * released by the caller, through the returned callback, once the parent's
	 * own teardown has finished — `await using` at the call site, or a
	 * `finally`. The callback is idempotent; failing to call it strands every
	 * later `ensureLive()`, which is why the parking phase releases it itself if
	 * it throws (the caller never gets a handle it does not know it holds).
	 *
	 * The release reports HOW the recycle ended. `"failed"` means no replacement
	 * parent was produced, so the children's shared dependencies were disposed
	 * with nothing taking them over: every waiter that blocked on this barrier is
	 * then failed rather than let through, because both routes back to a live
	 * session belong to the parent that just went away. A release that throws its
	 * own way out (the parking phase's own `catch`) is also a failure by the same
	 * reasoning — it never reached a handoff at all.
	 */
	async parkAll(deadlineAt: number = Date.now() + AGENT_RELEASE_GRACE_MS): Promise<ParkingBarrierRelease> {
		const resolvers = Promise.withResolvers<void>();
		const barrier: ParkingBarrier = { promise: resolvers.promise };
		// Added before the first await so an ensureLive() in the same tick — the
		// exact racer park()'s cancel window admits — already observes it.
		this.#parkingBarriers.add(barrier);
		let released = false;
		const release: ParkingBarrierRelease = (outcome = "reattached") => {
			if (released) return;
			released = true;
			// Latched on the MANAGER before the entry is dropped, so the failure
			// outlives this barrier: a waiter that never held a reference to it —
			// one blocked in a park settle, or on a sibling barrier that resolved
			// first — still reads the flag and refuses, and so does a call that
			// arrives only after this release has settled. Recorded before the
			// resolution below so the two can never be observed out of order.
			if (outcome === "failed") this.#handoffFailed = true;
			// Drop OUR entry before resolving, so a waiter waking on the resolution
			// re-reads the set without it rather than looping on a barrier nobody
			// holds. Every other live handoff keeps its own entry, so revival stays
			// blocked until the last one releases — whatever order they finish in.
			this.#parkingBarriers.delete(barrier);
			resolvers.resolve();
		};
		try {
			// Revivals that started BEFORE the barrier are not blocked by it, so
			// let them finish and register their session; parking then sees the id
			// and disposes it like any other. Failures are the revival's own
			// concern — its caller gets the rejection — so only settlement matters.
			//
			// Bounded by the same deadline as the parking phase below, because this
			// wait is on work the barrier cannot influence: a revival wedged in its
			// persisted factory or its session creation would otherwise hold the
			// pre-pass forever. That is not a slow recycle but a permanent wedge —
			// the recycle path calls `session.beginDispose()` BEFORE awaiting this
			// (sdk.ts), so the parent is already refusing new work, and never
			// reaching the parking phase means `onRestartRequested` never runs to
			// build the replacement. Missing the deadline abandons the settlement
			// and parks what IS parkable; `allSettled` keeps a handler on every
			// revival, so the abandoned wait can never surface as an unhandled
			// rejection, and tracking it keeps it reachable until it really settles.
			//
			// Abandoning the WAIT is not abandoning the revival: it is still running
			// and will still try to attach a session, now behind the `ids` snapshot
			// below and during the parent's teardown of the shared kernels/MCP/LSP
			// that session borrows. So each abandoned revival is FENCED — the flag
			// `#revive` consults before attaching — which turns it into a clean
			// failure for its waiter instead of exactly the live child this barrier
			// promises to exclude.
			const pending = [...this.#revivals.values()];
			const inflight = pending.map(revival => revival.promise);
			if (inflight.length > 0) {
				const settled = Promise.allSettled(inflight).then(() => {});
				try {
					await untilAborted(AbortSignal.timeout(Math.max(0, deadlineAt - Date.now())), () => settled);
				} catch (error) {
					if (Date.now() >= deadlineAt) {
						for (const revival of pending) revival.fence.fenced = true;
						trackLateCleanup(settled, { resource: "reviving-agent" });
					}
					logger.warn("Agent revival settlement exceeded the parking deadline", {
						count: inflight.length,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			// `#revivals` is intentionally NOT consulted here: `ensureLive()` deletes
			// each entry in its own `finally`, and the pre-pass above settled every
			// one that met the deadline. A revival that completed registered its
			// session in `#adopted`; one that threw owns its own failure. One still
			// in flight past the deadline was fenced above, so it fails rather than
			// attaching behind this snapshot — blocking here instead is the wedge
			// the deadline exists to prevent.
			const ids = [...new Set([...this.#adopted.keys(), ...this.#parks.keys()])];
			await Promise.all(
				ids.map(async id => {
					const park = this.park(id);
					try {
						await untilAborted(AbortSignal.timeout(Math.max(0, deadlineAt - Date.now())), () => park);
					} catch (error) {
						// Same shape as dispose(): a park that outruns the handoff budget
						// keeps draining in the background rather than blocking the
						// replacement session on it.
						if (Date.now() >= deadlineAt) {
							trackLateCleanup(park, { id, resource: "adopted-agent" });
						}
						logger.warn("Agent park exceeded its deadline", {
							id,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}),
			);
			// Every adoption that survives this recycle keeps a reviver captured by
			// the parent whose teardown is driving it, closed over that parent's
			// spawn-time dependencies (its MCP manager, artifact manager, session)
			// which the teardown below the parking disconnects. Marking them makes
			// the next revival build through the REPLACEMENT parent's
			// persisted-reviver factory instead — one source of truth for the
			// child's dependencies rather than a live parent beside a dead closure.
			//
			// Applied here, after the parking phase, rather than at entry: a cold
			// revival that settled inside the pre-pass above was adopted during this
			// call, through the OLD parent's factory, so an entry-time pass would
			// miss exactly that record. Nothing can adopt after this point — the
			// barrier blocks revival until the caller releases, and an abandoned
			// revival is fenced and refuses to attach.
			this.#markRevivedDependenciesStale();
		} catch (error) {
			release();
			throw error;
		}
		return release;
	}

	/**
	 * Mark every adoption's retained reviver as belonging to a parent that is
	 * being replaced. Covers EVERY adoption this manager holds, not just the ids
	 * {@link parkAll} snapshotted: an adoption whose ref is already `parked`
	 * (its TTL expired earlier) still carries the same recycling parent's
	 * closure, and a live-session record parked by this call carries it too. A
	 * cleared flag is never re-set here — {@link #resolveAndRevive} clears it
	 * only after a factory reviver replaced the closure, and that replacement
	 * belongs to the parent that installed the factory, which a later recycle
	 * marks in its own turn.
	 */
	#markRevivedDependenciesStale(): void {
		for (const adopted of this.#adopted.values()) {
			if (adopted.revive) adopted.reviverStale = true;
		}
	}

	/** Teardown everything; disposing the global manager makes its next owner a fresh instance. */
	async dispose(deadlineAt: number = Date.now() + AGENT_RELEASE_GRACE_MS): Promise<void> {
		this.#unsubscribe?.();
		this.#disposed = true;
		this.#unsubscribe = undefined;
		const ids = [...new Set([...this.#adopted.keys(), ...this.#parks.keys()])];
		await Promise.all(
			ids.map(async id => {
				const release = this.release(id).then(() => {});
				try {
					await untilAborted(AbortSignal.timeout(Math.max(0, deadlineAt - Date.now())), () => release);
				} catch (error) {
					if (Date.now() >= deadlineAt) {
						trackLateCleanup(release, { id, resource: "adopted-agent" });
					}
					logger.warn("Agent cleanup exceeded its deadline", {
						id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		);
		this.#revivals.clear();
		this.#parks.clear();
		this.#persistedReviverFactory = undefined;
		if (AgentLifecycleManager.#global === this) AgentLifecycleManager.#global = undefined;
	}

	async #revive(
		id: string,
		revive: AgentReviver,
		ref: AgentRef,
		adopted: AdoptedAgent,
		fence: RevivalFence,
	): Promise<AgentSession> {
		const session = await revive(ref);
		// `parkAll()` abandons its wait on a revival that outruns the parking
		// deadline — the deadline exists so a wedged reviver cannot wedge the whole
		// recycle — and FENCES it on the way out. So a fenced revival is one
		// resuming HERE, behind `parkAll()`'s `ids` snapshot and during the
		// parent's teardown of the shared kernels/MCP/LSP this session borrows.
		// Attaching now would leave exactly the live child the barrier promises to
		// exclude, and the session is built on resources that are going away
		// regardless. So wait for the teardown the barrier delimits, then dispose
		// it and fail the waiter: an `ensureLive()` retry revives cleanly against
		// the replacement parent's manager. Waiting on every live barrier covers a
		// second recycle raising its own while we wait on the first.
		//
		// The wait is safe against the barrier that fenced us because the fence is
		// set only in the path that has ALREADY given up waiting on this promise,
		// so `parkAll()` can never be blocked on the wait below.
		if (fence.fenced) {
			if (this.#parkingBarriers.size > 0) await this.#awaitParkingBarriers();
			await session.dispose();
			throw new Error(
				`Agent "${id}" revival aborted: its parent session recycled while its persisted session was reviving.`,
			);
		}
		if (this.#disposed) {
			// The owning lifecycle tore down while the reviver was in flight; dispose
			// the freshly built session instead of attaching it, and fail the waiter.
			await session.dispose();
			throw new Error(
				`Agent "${id}" revival aborted: its lifecycle was disposed while its persisted session was reviving.`,
			);
		}
		let liveRef = this.#registry.get(id);
		if (liveRef === ref && ref.status === "parked" && !ref.session) {
			// A simple reviver returned a session without claiming the parked ref;
			// attach it here while the exact ref is still revivable.
			if (!this.#registry.attachSession(id, session, ref.sessionFile, ref)) {
				await session.dispose();
				throw new Error(`Agent "${id}" changed before its persisted session could attach.`);
			}
			liveRef = ref;
		} else if (
			liveRef !== ref ||
			liveRef.status !== "running" ||
			liveRef.session !== session ||
			liveRef.kind !== ref.kind ||
			liveRef.parentId !== ref.parentId ||
			liveRef.sessionFile !== ref.sessionFile
		) {
			// createAgentSession may have already claimed this exact parked ref and
			// attached the returned session. Any other state — especially an
			// `aborted` tombstone set while revive() was in flight — is stale.
			await session.dispose();
			throw new Error(`Agent "${id}" was replaced or became terminal while its persisted session was reviving.`);
		}
		adopted.ref = liveRef;
		// Emits status_changed → "idle", which re-arms the TTL timer below.
		if (!this.#registry.setStatus(id, "idle", liveRef)) {
			await session.dispose();
			throw new Error(`Agent "${id}" changed before its persisted session became idle.`);
		}
		return session;
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
		if (!adopted || adopted.ref !== event.ref) return;
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
			// Don't re-arm while a park is in flight — the park owns the transition.
			if (this.#parks.has(event.ref.id)) return;
			this.#armTimer(event.ref.id, adopted);
		}
	}
}
