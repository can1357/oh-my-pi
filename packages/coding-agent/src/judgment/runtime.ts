/**
 * Host-owned judgment runtime behind `ctx.judge` and `ctx.judgeBatch`.
 *
 * One runtime per session serves both methods: every call resolves the live
 * `judge` role chain — so role, credential, and session-model changes apply to
 * the next call — journals its usage on the session ledger, and inherits the
 * runtime's disposal signal so session teardown stops in-flight judgments. A
 * batch resolves that chain once and settles per item, so one unanswerable item
 * never costs the rest of the batch.
 */
import type { JudgeOptions, JudgmentRequest, JudgmentResult, JudgmentState, Model, Questions } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { SessionManager } from "../session/session-manager";
import { type ChainJudge, journalJudgmentUsage, resolveJudge } from "./index";

/** Judgments in flight per batch when the caller names no width. */
const DEFAULT_BATCH_CONCURRENCY = 4;

export interface JudgmentRuntimeHost {
	settings: Settings;
	modelRegistry: ModelRegistry;
	sessionManager: SessionManager;
	getSessionModel(): Model | undefined;
	metadataResolver?(provider: string): Record<string, unknown> | undefined;
}

/**
 * Host-side judgment failure: the runtime is disposed, a batch item exhausted
 * its attempts with a non-`Error` throw, or cancellation carried no reason.
 * Backend failures keep their own error — this never wraps one.
 */
export class JudgmentError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "JudgmentError";
	}
}

/** Caller-chosen item id; list callers pass the index. */
export type JudgmentBatchKey = string | number;

/** One state in a batch, answered against the batch's shared questions. */
export interface JudgmentBatchInput {
	key: JudgmentBatchKey;
	state: JudgmentState;
}

/** Many states judged against one shared question set. */
export interface JudgmentBatchRequest<Q extends Questions = Questions> {
	items: readonly JudgmentBatchInput[];
	questions: Q;
}

export interface JudgeBatchOptions extends JudgeOptions {
	/** Judgments in flight at once, clamped to the item count. An integer of at least 1; defaults to 4. */
	concurrency?: number;
	/**
	 * Extra attempts per item; each retry re-walks the whole judge chain. A
	 * non-negative integer; defaults to none.
	 */
	retries?: number;
}

/** A judged item. */
export interface JudgmentBatchAnswer<Q extends Questions = Questions> {
	key: JudgmentBatchKey;
	result: JudgmentResult<Q>;
	error?: undefined;
}

/** An item whose every attempt failed. The batch still resolves; the caller owns the threshold. */
export interface JudgmentBatchFailure {
	key: JudgmentBatchKey;
	result?: undefined;
	error: Error;
}

export type JudgmentBatchEntry<Q extends Questions = Questions> = JudgmentBatchAnswer<Q> | JudgmentBatchFailure;

export interface JudgmentRuntime {
	judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>>;
	/** Judge every item against one question set, one entry per input item in request order. */
	judgeBatch<Q extends Questions>(
		request: JudgmentBatchRequest<Q>,
		options?: JudgeBatchOptions,
	): Promise<JudgmentBatchEntry<Q>[]>;
	dispose(reason?: unknown): void;
}

/**
 * Bound one numeric batch option before any judgment is scheduled. A fractional
 * or `NaN` width silently schedules no worker at all — the batch would resolve
 * with holes where entries belong — and a non-finite retry budget never stops
 * re-walking the chain, so both are caller errors rather than values to clamp.
 */
function boundedOption(value: number | undefined, fallback: number, minimum: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < minimum) {
		throw new JudgmentError(`judgeBatch ${name} must be an integer of at least ${minimum}, received ${value}`);
	}
	return value;
}

class Runtime implements JudgmentRuntime {
	readonly #host: JudgmentRuntimeHost;
	readonly #disposeController = new AbortController();
	#disposed = false;

	constructor(host: JudgmentRuntimeHost) {
		this.#host = host;
	}

	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options: JudgeOptions = {},
	): Promise<JudgmentResult<Q>> {
		const signal = this.#scope(options.signal);
		return this.#chain("extension-judge").judge(request, { ...options, signal });
	}

	async judgeBatch<Q extends Questions>(
		request: JudgmentBatchRequest<Q>,
		options: JudgeBatchOptions = {},
	): Promise<JudgmentBatchEntry<Q>[]> {
		const { items, questions } = request;
		const retries = boundedOption(options.retries, 0, 0, "retries");
		const concurrency = boundedOption(options.concurrency, DEFAULT_BATCH_CONCURRENCY, 1, "concurrency");
		if (items.length === 0) return [];
		const signal = this.#scope(options.signal);
		const judge = this.#chain("extension-judge-batch");
		const width = Math.min(concurrency, items.length);
		const entries: JudgmentBatchEntry<Q>[] = Array.from({ length: items.length });
		// Workers pull from one shared cursor so a slow item never idles the
		// rest, and each entry lands at its request index so the caller reads
		// results in input order regardless of completion order.
		let next = 0;
		const worker = async (): Promise<void> => {
			while (next < items.length) {
				const index = next++;
				entries[index] = await this.#judgeItem(judge, items[index], questions, signal, retries);
			}
		};
		await Promise.all(Array.from({ length: width }, worker));
		return entries;
	}

	dispose(reason?: unknown): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#disposeController.abort(reason ?? new JudgmentError("judgment runtime disposed"));
	}

	/**
	 * One item, retried through the whole chain. Cancellation belongs to the
	 * batch — it stops every worker — while a backend failure belongs to the
	 * item and is reported in its entry.
	 */
	async #judgeItem<Q extends Questions>(
		judge: ChainJudge,
		input: JudgmentBatchInput,
		questions: Q,
		signal: AbortSignal,
		retries: number,
	): Promise<JudgmentBatchEntry<Q>> {
		let lastError: unknown;
		for (let attempt = 0; attempt <= retries && !signal.aborted; attempt++) {
			try {
				return { key: input.key, result: await judge.judge({ state: input.state, questions }, { signal }) };
			} catch (error) {
				lastError = error;
			}
		}
		// Cancellation surfaces the reason the aborter gave; only a bare abort needs one of ours.
		if (signal.aborted) throw signal.reason ?? new JudgmentError("judgment aborted");
		return {
			key: input.key,
			error: lastError instanceof Error ? lastError : new JudgmentError(String(lastError), { cause: lastError }),
		};
	}

	/** The live judge chain, resolved per call and journaled under `purpose`. */
	#chain(purpose: string): ChainJudge {
		if (this.#disposed) throw new JudgmentError("judgment runtime disposed");
		const { settings, modelRegistry, sessionManager, metadataResolver } = this.#host;
		return resolveJudge({
			settings,
			registry: modelRegistry,
			sessionModel: this.#host.getSessionModel(),
			sessionId: sessionManager.getSessionId(),
			metadataResolver,
			onUsage: journalJudgmentUsage(sessionManager, purpose),
		});
	}

	/** Caller cancellation joined with the runtime's own disposal. */
	#scope(caller: AbortSignal | undefined): AbortSignal {
		return caller ? AbortSignal.any([caller, this.#disposeController.signal]) : this.#disposeController.signal;
	}
}

export function createJudgmentRuntime(host: JudgmentRuntimeHost): JudgmentRuntime {
	return new Runtime(host);
}
