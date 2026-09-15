import { logger } from "@oh-my-pi/pi-utils";
import { rebindSharpshooterSession, sharpshooterBackend } from "../sharpshooter/backend";
import type {
	MemoryBackend,
	MemoryBackendId,
	MemoryBackendOperationContext,
	MemoryBackendSearchOptions,
	MemoryBackendStartOptions,
} from "./types";

/**
 * Start sharpshooter's own session resources, and never let that failure take the
 * store down with it.
 *
 * Registering is only safe while the session is alive. `resolve` awaits a cold
 * backend import and the SDK discards the promise `start` returns, so disposal can
 * run its unconditional release before start is ever called. Registering then would
 * attach a subscription and a scheduler to a dead session with nothing left to
 * release them, and the scheduler ticks immediately, so it could consolidate and
 * spend a model call after shutdown.
 *
 * Both entry points release the session's previous resources before acquiring new
 * ones, so either is safe to call on a session that already has them. They differ
 * in one thing: `"start"` catches up on a transcript that already ends in a user
 * prompt, and `"rebind"` does not, because after `/move` that prompt belongs to the
 * project the session left.
 */
export function startSharpshooterLeg(
	options: MemoryBackendStartOptions,
	primaryId: MemoryBackendId,
	reason: "start" | "rebind" = "start",
): void {
	if (options.session.isDisposed) return;
	try {
		if (reason === "rebind") rebindSharpshooterSession(options);
		else sharpshooterBackend.start(options);
	} catch (error) {
		logger.warn(`Sharpshooter ${reason} failed while paired`, { backend: primaryId, error: String(error) });
	}
}

/**
 * Run sharpshooter alongside a store backend.
 *
 * Sharpshooter is not a store. It distills friction-gated project decisions into
 * three markdown files and injects them; it never holds arbitrary memories, and
 * its `status` reports `writable: false`. So it competes with mnemopi, hindsight
 * and local for the single backend slot without needing what that slot provides,
 * and pairing gives a session both searchable recall and always-on project rules.
 *
 * The wrapper keeps the primary's `id`. Tool gating across the agent reads
 * `memory.backend` directly rather than the resolved backend, and sharpshooter
 * appears in none of those checks, so the primary's tools stay exactly as they
 * were.
 *
 * Nothing that rewrites or removes the decision files fans out. Sharpshooter
 * replaces all three whole on every consolidation and keeps no history, so a
 * bad rewrite is unrecoverable: #10200 fixed a consolidation that returned
 * all-empty content, truncated every file, consumed the queued deltas and
 * recorded success, and that guard still admits a replacement that empties one
 * file out of three. An action aimed at the selected backend must not be able
 * to trigger either. `clear` and `enqueue` therefore reach the primary alone.
 */
export function withSharpshooter(primary: MemoryBackend): MemoryBackend {
	/**
	 * Run something on sharpshooter, swallowing its failure.
	 *
	 * Only the paired backend is shielded. The selected backend's errors propagate
	 * exactly as they did before pairing: a caller that would have seen a failed
	 * retain must still see it, or pairing turns real failures into silent ones.
	 */
	const paired = async <T>(label: string, run: () => Promise<T> | T): Promise<T | undefined> => {
		try {
			return await run();
		} catch (error) {
			logger.warn(`Sharpshooter ${label} failed while paired`, { backend: primary.id, error: String(error) });
			return undefined;
		}
	};
	/**
	 * Run both legs, then report the primary's outcome.
	 *
	 * Sharpshooter runs whether or not the primary threw, so one backend failing
	 * cannot quietly skip the other; the primary's error still reaches the caller.
	 *
	 * Both are started before either is awaited. The two backends share nothing, and
	 * awaiting the primary first would make every paired call cost the sum of the two
	 * latencies instead of the larger one, which a slow Mnemopi search or a Hindsight
	 * request over the network makes obvious. The primary's rejection is still raised
	 * after the sharpshooter leg settles, so neither promise is left unhandled.
	 */
	const legs = async <T>(
		label: string,
		runPrimary: () => Promise<T>,
		runPaired: () => Promise<T | undefined>,
	): Promise<[T | undefined, T | undefined]> => {
		const primaryRun = Promise.allSettled([runPrimary()]);
		const pairedRun = paired(label, runPaired);
		const settled = await primaryRun;
		const extra = await pairedRun;
		const [result] = settled;
		if (result?.status === "rejected") throw result.reason;
		return [result?.value, extra];
	};
	const joined = async (
		label: string,
		run: (backend: MemoryBackend) => Promise<string | undefined>,
	): Promise<string | undefined> => {
		const parts = (
			await legs(
				label,
				() => run(primary),
				() => run(sharpshooterBackend),
			)
		)
			.map(part => part?.trim())
			.filter((part): part is string => Boolean(part));
		return parts.length > 0 ? parts.join("\n\n") : undefined;
	};

	return {
		id: primary.id,

		/**
		 * Registers sharpshooter before yielding, then awaits the primary.
		 *
		 * `sharpshooterBackend.start` is synchronous, and calling it before the
		 * first await means its subscription and scheduler exist by the time this
		 * returns a promise at all. That matters because the SDK discards the
		 * returned promise (`sdk.ts`, the non-autolearn branch) while disposal
		 * releases sharpshooter unconditionally: a registration that happened after
		 * an awaited hop could land past the release and strand the per-bank
		 * scheduler refcount for the life of the process.
		 */
		start(options: MemoryBackendStartOptions): Promise<void> {
			// Registering first is only safe while the session is alive. `resolve` awaits
			// a cold backend import, and the SDK discards this promise, so disposal can
			// run its unconditional release before start is ever called. Registering
			// then would attach a subscription and a scheduler to a dead session with
			// nothing left to release them, and the scheduler ticks immediately, so it
			// could consolidate and spend a model call after shutdown.
			startSharpshooterLeg(options, primary.id);
			return Promise.resolve(primary.start(options));
		},

		buildDeveloperInstructions(agentDir, settings, session) {
			return joined("instructions", backend => backend.buildDeveloperInstructions(agentDir, settings, session));
		},

		/**
		 * Clears the selected backend only; see the note on the wrapper. Select
		 * sharpshooter as the backend to clear its decision files deliberately.
		 */
		async clear(agentDir, cwd, session): Promise<void> {
			await primary.clear(agentDir, cwd, session);
		},

		/**
		 * Consolidates the selected backend only.
		 *
		 * Sharpshooter's `enqueue` forces a consolidation, which asks a model to
		 * rewrite all three decision files and then consumes the queued deltas. A
		 * reply that empties one file passes the all-empty guard and is written, so
		 * `/memory sync` aimed at the store would be able to erode rules it was
		 * never pointed at. Sharpshooter's own scheduler still consolidates on its
		 * interval, so nothing is stranded.
		 */
		async enqueue(agentDir, cwd, session): Promise<void> {
			await primary.enqueue(agentDir, cwd, session);
		},

		async status(context: MemoryBackendOperationContext) {
			// Through `legs`, so a primary that throws still lets sharpshooter report.
			const [primaryStatus, extra] = await legs(
				"status",
				async () =>
					primary.status
						? await primary.status(context)
						: { backend: primary.id, active: primary.id !== "off", writable: false, searchable: false },
				async () => sharpshooterBackend.status?.(context),
			);
			const status = primaryStatus ?? {
				backend: primary.id,
				active: primary.id !== "off",
				writable: false,
				searchable: false,
			};
			const message = [status.message, extra?.message ? `sharpshooter — ${extra.message}` : undefined]
				.filter(Boolean)
				.join("; ");
			return {
				...status,
				// With `off` selected, sharpshooter's scheduler, prompt injection and
				// search are all running. Reporting the pair as inactive or unsearchable
				// would describe a session that is not the one running.
				active: status.active || Boolean(extra?.active),
				searchable: status.searchable || Boolean(extra?.searchable),
				...(message ? { message } : {}),
			};
		},

		async search(context: MemoryBackendOperationContext, query: string, options?: MemoryBackendSearchOptions) {
			const [primaryResult, extra] = await legs(
				"search",
				async () =>
					primary.search
						? await primary.search(context, query, options)
						: { backend: primary.id, query, count: 0, items: [] },
				async () => sharpshooterBackend.search?.(context, query, options),
			);
			const result = primaryResult ?? { backend: primary.id, query, count: 0, items: [] };
			// Both legs are in flight at once, so an abort can land between them: the
			// sharpshooter leg reads three local files and can be done before mnemopi
			// notices the signal and returns its empty "Search aborted." result.
			// Merging then answers a cancelled search with memories in it. The
			// primary's outcome is the honest one to return.
			if (options?.signal?.aborted) return result;
			if (!extra || extra.items.length === 0) return result;
			if (options?.limit === undefined) {
				const items = [...result.items, ...extra.items];
				return { ...result, items, count: items.length };
			}
			// Both backends already applied the caller's limit to their own results, so
			// the merged set needs trimming again. Taking the primary's items first and
			// slicing would drop sharpshooter entirely whenever the primary filled the
			// limit on its own, which is exactly when a decision-file hit is worth
			// seeing. Split the limit instead, and let either side use the room the
			// other did not.
			const limit = Math.max(0, options.limit);
			// A backend reads a non-positive limit its own way, and that reading is the
			// caller's to see: mnemopi clamps it to one item. Splitting a zero limit
			// would return nothing whenever sharpshooter happened to match, so the pair
			// would answer one query two ways depending on the decision files. Pass the
			// primary through untouched, which is what an unwrapped backend returns.
			if (limit === 0) return result;
			const share = Math.min(extra.items.length, Math.ceil(limit / 2));
			const fromPrimary = result.items.slice(0, Math.max(0, limit - share));
			const items = [...fromPrimary, ...extra.items.slice(0, limit - fromPrimary.length)];
			return { ...result, items, count: items.length };
		},

		stats(agentDir, cwd, session) {
			return joined("stats", backend => Promise.resolve(backend.stats?.(agentDir, cwd, session)));
		},

		diagnose(agentDir, cwd, session) {
			return joined("diagnose", backend => Promise.resolve(backend.diagnose?.(agentDir, cwd, session)));
		},

		queuePreview(context: MemoryBackendOperationContext) {
			return joined("queue", backend => Promise.resolve(backend.queuePreview?.(context)));
		},

		...(primary.save ? { save: primary.save.bind(primary) } : {}),
		...(primary.beforeAgentStartPrompt
			? { beforeAgentStartPrompt: primary.beforeAgentStartPrompt.bind(primary) }
			: {}),
		...(primary.preCompactionContext ? { preCompactionContext: primary.preCompactionContext.bind(primary) } : {}),
	};
}
