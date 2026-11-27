/**
 * Client half of text prediction, served by the daemon's `predict` module.
 *
 * The composer's word-completion provider (`modes/view-model/prompt/word-completion`)
 * reaches the module through {@link textPredictionBackend}. The first request
 * opens (find-or-start) the global `predict` unit of this agent directory and
 * holds a lease on it; every request is then a `call`. Failures never surface
 * to the editor: a query that cannot be answered shows no ghost text.
 */
import type { PredictedWord } from "@oh-my-pi/pi-natives";
import type { WordCompletionEngine, WordPredictionBackend } from "../modes/view-model/prompt/word-completion";
import { getAgentDir, getHistoryDbPath, getPredictStateDir, logger } from "@oh-my-pi/pi-utils";
import { daemonClient } from "../daemon/client";
import { type DaemonClient, GLOBAL_SCOPE } from "../daemon/protocol";
import {
	TEXT_PREDICT_KIND,
	TEXT_PREDICT_METHODS,
	type TextPredictCallMethod,
	type TextPredictCalls,
	type TextPredictMethod,
	type TextPredictOpenParams,
	type TextPredictReply,
	textPredictKey,
} from "./protocol";
import { getSmolLmModelDir, prefetchSmolLmWeights } from "./smollm-weights";

/** A first `complete` may wait for its engine to open and ingest history. */
const COMPLETE_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** After the unit could not be opened, stay quiet this long before trying again. */
const RETRY_AFTER_MS = 30_000;

/**
 * Engine serving a configured method. `auto` is ngram, so it never downloads
 * SmolLM's weights; `apple` falls back to ngram off macOS.
 */
export function resolveTextPredictMethod(method: WordCompletionEngine): TextPredictMethod {
	if (method === "auto" || (method === "apple" && process.platform !== "darwin")) return "ngram";
	return method;
}

/** One answer: the suggestion and the engine that produced it. */
export interface TextPrediction {
	engine: TextPredictMethod;
	suggestion: PredictedWord | null;
}

/** An open `predict` unit and the lease this process holds on it. */
interface PredictSession {
	daemon: DaemonClient;
	unitId: string;
	lease?: string;
}

/** Process-wide access shared by every editor and the submit hook. */
class TextPredictionClient {
	#session: PredictSession | undefined;
	#opening: Promise<PredictSession> | undefined;
	#retryAt = 0;
	#backends = new Map<TextPredictMethod, WordPredictionBackend>();
	#offReconnect: (() => void) | undefined;

	backend(method: WordCompletionEngine): WordPredictionBackend {
		const resolved = resolveTextPredictMethod(method);
		let backend = this.#backends.get(resolved);
		if (!backend) {
			backend = {
				complete: async (before, prefix) => {
					try {
						return (await this.complete(resolved, before, prefix)).suggestion?.suffix ?? null;
					} catch (error) {
						logger.debug("text-predict: completion unavailable", { error: String(error) });
						return null;
					}
				},
				feedback: (before, prefix, suggestion, accepted) => {
					this.#call(
						"feedback",
						{ method: resolved, before, prefix, suggestion, accepted },
						REQUEST_TIMEOUT_MS,
					).catch(error => logger.debug("text-predict: feedback dropped", { error: String(error) }));
				},
			};
			this.#backends.set(resolved, backend);
		}
		return backend;
	}

	/** Release this process's lease (the unit lingers for its idle window). */
	close(): void {
		this.#offReconnect?.();
		this.#offReconnect = undefined;
		const session = this.#session;
		this.#session = undefined;
		const opening = this.#opening;
		this.#opening = undefined;
		const release = (dropped: PredictSession): void => {
			if (this.#session === dropped) {
				this.#session = undefined;
				this.#offReconnect?.();
				this.#offReconnect = undefined;
			}
			if (!dropped.lease) return;
			dropped.daemon.release(dropped.lease).catch(error =>
				logger.debug("text-predict: lease release failed", {
					error: String(error),
				}),
			);
		};
		if (session) release(session);
		// An open still in flight would otherwise leave its lease behind.
		opening?.then(release, () => {});
	}

	/**
	 * Ask `engine` for the ghost text after `prefix`, with its confidence.
	 *
	 * @throws when the daemon is unreachable or the engine reports an error
	 * (e.g. it failed to load).
	 */
	async complete(engine: TextPredictMethod, before: string, prefix: string): Promise<TextPrediction> {
		// SmolLM's weights download here, in the interactive process (shown in the
		// download HUD), only once the user has chosen SmolLM.
		if (engine === "smollm") prefetchSmolLmWeights();
		const suggestion = await this.#call("complete", { method: engine, before, prefix }, COMPLETE_TIMEOUT_MS);
		return { engine, suggestion };
	}

	/**
	 * Tell an open unit new history rows exist. Without one nothing needs
	 * telling: a unit ingests everything new when its engines open.
	 */
	sync(): void {
		if (!this.#session) return;
		this.#call("sync", {}, REQUEST_TIMEOUT_MS).catch(error =>
			logger.debug("text-predict: sync dropped", { error: String(error) }),
		);
	}

	async #call<M extends TextPredictCallMethod>(
		method: M,
		params: TextPredictCalls[M]["params"],
		timeoutMs: number,
	): Promise<TextPredictCalls[M]["result"]> {
		const session = await this.#open();
		const signal = AbortSignal.timeout(timeoutMs);
		let reply: TextPredictReply<TextPredictCalls[M]["result"]>;
		try {
			reply = await session.daemon.call<TextPredictReply<TextPredictCalls[M]["result"]>>(
				TEXT_PREDICT_KIND,
				method,
				params,
				{ unit: session.unitId, signal },
			);
		} catch (error) {
			// Engine errors arrive as `{ ok: false }` replies, so a rejection means the
			// unit or connection is gone (idle stop, daemon replaced): reopen on the
			// next call. Our own timeout says nothing about the unit; keep it.
			if (!signal.aborted && this.#session === session) {
				this.#session = undefined;
				if (session.lease) session.daemon.release(session.lease).catch(() => {});
			}
			throw error;
		}
		if (!reply.ok) throw new Error(`text-predict ${method}: ${reply.error}`);
		return reply.value;
	}

	#open(): Promise<PredictSession> {
		if (this.#session) return Promise.resolve(this.#session);
		if (this.#opening) return this.#opening;
		if (Date.now() < this.#retryAt) return Promise.reject(new Error("text-predict unavailable"));
		const opening = openPredictUnit(getAgentDir()).then(
			session => {
				this.#session = session;
				this.#opening = undefined;
				this.#offReconnect?.();
				this.#offReconnect = session.daemon.onReconnect(() => {
					// Leases died with the old connection; the next call reopens.
					if (this.#session === session) this.#session = undefined;
				});
				return session;
			},
			(error: unknown) => {
				this.#opening = undefined;
				this.#retryAt = Date.now() + RETRY_AFTER_MS;
				logger.warn("text-predict: daemon unavailable; word completion paused", { error: String(error) });
				throw error;
			},
		);
		this.#opening = opening;
		return opening;
	}
}

/** Find or start the `predict` unit serving `agentDir`, leased to this process. */
async function openPredictUnit(agentDir: string): Promise<PredictSession> {
	const daemon = await daemonClient();
	const stateDirs = Object.fromEntries(
		TEXT_PREDICT_METHODS.map(method => [method, getPredictStateDir(agentDir, method)]),
	) as Record<TextPredictMethod, string>;
	const params: TextPredictOpenParams = {
		agentDir,
		historyDbPath: getHistoryDbPath(agentDir),
		modelDir: getSmolLmModelDir(),
		stateDirs,
	};
	const { unit, lease } = await daemon.open({
		kind: TEXT_PREDICT_KIND,
		scope: GLOBAL_SCOPE,
		key: textPredictKey(agentDir),
		params,
	});
	return { daemon, unitId: unit.id, lease };
}

let sharedClient: TextPredictionClient | undefined;

/** Word-prediction backend for a configured engine, served by the daemon. */
export function textPredictionBackend(method: WordCompletionEngine): WordPredictionBackend {
	sharedClient ??= new TextPredictionClient();
	return sharedClient.backend(method);
}

/**
 * One completion with its confidence, for diagnostics such as `omp predict`.
 * Unlike the editor backend, failures reject instead of degrading to no ghost text.
 */
export function requestTextPrediction(
	method: WordCompletionEngine,
	before: string,
	prefix: string,
): Promise<TextPrediction> {
	sharedClient ??= new TextPredictionClient();
	return sharedClient.complete(resolveTextPredictMethod(method), before, prefix);
}

/**
 * Release this process's lease on the unit (it keeps running for its idle
 * window). For short-lived commands such as `omp predict`; the composer keeps
 * its lease for the process lifetime.
 */
export function closeTextPrediction(): void {
	sharedClient?.close();
	sharedClient = undefined;
}

/** Ask an open unit to ingest newly written history rows. */
export function syncTextPrediction(): void {
	sharedClient?.sync();
}
