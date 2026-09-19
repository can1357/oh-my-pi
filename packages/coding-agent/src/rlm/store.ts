import type { RlmFlowHooks } from "../context-flow/rlm-flow";

import { createHash } from "node:crypto";

/** Default spill threshold — matches nano-rlm's 20KB tool-result cap. */
export const RLM_DEFAULT_SPILL_BYTES = 20_480;

const PREVIEW_CHARS = 240;

export interface RlmRecord {
	id: string;
	bytes: number;
	sha256: string;
	source?: string;
	text: string;
}

export interface RlmStub {
	handle: string;
	bytes: number;
	sha256: string;
	preview: string;
	stub: string;
}


export interface RlmPeek {
	handle: string;
	start: number;
	end: number;
	text: string;
	citation: string;
}

export interface RlmHit {
	index: number;
	text: string;
	citation: string;
}

export interface RlmTrajectoryEntry {
	ts: number;
	op: string;
	detail: string;
	failOpen?: boolean;
}

/** Personal-use / experiment counters (session-local, inspect via status). */
export interface RlmMetrics {
	spills: number;
	bytesSpilled: number;
	/** Bytes returned into model/tool context via peek, view grants, or rlm:// read. */
	bytesReintroduced: number;
	peeks: number;
	searches: number;
	queries: number;
	subcalls: number;
	failOpen: number;
	/** Ordinary read/grep resolves of rlm://. */
	resourceResolves: number;
	/** Grant ranges selected via search/select (cumulative). */
	grantsSelected: number;
	/** Query/subcall abstentions that skipped worker inference (empty search). */
	workerCallsAvoided: number;
}


export interface RlmBudget {
	maxDepth: number;
	maxCalls: number;
	maxTotalTokens: number;
	/** Hard USD-style cost cap; 0 = unlimited. */
	maxCost: number;
	/** Wall-clock budget from store creation; 0 = unlimited. */
	wallClockMs: number;
	calls: number;
	tokens: number;
	cost: number;
	startedAt: number;
	cancelled: boolean;
	cancelReason?: string;
	/** True when provider usage exceeded a prior reservation (hard budget breached post-hoc). */
	overBudget?: boolean;
}

export interface RlmUsageReconcile {
	/** Tokens reserved at beginCall. */
	estimatedTokens: number;
	/** Provider-reported tokens when available. */
	actualTokens?: number;
	actualCost?: number;
}

export interface RlmReconcileResult {
	tokens: number;
	cost: number;
	/** Reservation was raised to actual and breached a hard cap. */
	overBudget: boolean;
}

/**
 * Session-scoped original-byte store. Corpus never belongs in the root prompt.
 * Owned by one AgentSession runtime id — never keyed by cwd alone.
 */
export class RlmStore {
	#next = 1;
	readonly records = new Map<string, RlmRecord>();
	readonly budget: RlmBudget;
	/** Honest partial trajectory for cancel / budget stops (RFC v1). */
	readonly trajectory: RlmTrajectoryEntry[] = [];
	readonly metrics: RlmMetrics = {
		spills: 0,
		bytesSpilled: 0,
		bytesReintroduced: 0,
		peeks: 0,
		searches: 0,
		queries: 0,
		subcalls: 0,
		failOpen: 0,
		resourceResolves: 0,
		grantsSelected: 0,
		workerCallsAvoided: 0,
	};
	/** Session owner for live context-flow emission. */
	flowOwner?: object;
	flowHooks?: RlmFlowHooks;

	#disposed = false;
	/** In-flight provider calls aborted by cancel / wall-clock / dispose. */
	readonly #inflight = new Set<AbortController>();

	constructor(budget?: Partial<RlmBudget>) {
		this.budget = {
			maxDepth: budget?.maxDepth ?? 0,
			maxCalls: budget?.maxCalls ?? 32,
			maxTotalTokens: budget?.maxTotalTokens ?? 1_000_000,
			maxCost: budget?.maxCost ?? 0,
			wallClockMs: budget?.wallClockMs ?? 0,
			calls: 0,
			tokens: 0,
			cost: 0,
			startedAt: budget?.startedAt ?? Date.now(),
			cancelled: false,
			cancelReason: undefined,
			overBudget: false,
		};
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	put(text: string, source?: string): RlmRecord {
		this.#assertLive("put");
		const id = String(this.#next++);
		const record: RlmRecord = {
			id,
			bytes: Buffer.byteLength(text, "utf8"),
			sha256: createHash("sha256").update(text).digest("hex"),
			source,
			text,
		};
		this.records.set(id, record);
		this.metrics.spills += 1;
		this.metrics.bytesSpilled += record.bytes;
		this.flowHooks?.onSpill?.(record);
		return record;

	}

	get(handle: string): RlmRecord | undefined {
		return this.records.get(normalizeHandle(handle));
	}

	peek(handle: string, start = 0, end?: number): RlmPeek {
		const record = this.require(handle);
		const from = Math.max(0, start);
		const to = Math.min(record.text.length, end ?? record.text.length);
		const text = record.text.slice(from, to);
		this.metrics.peeks += 1;
		this.metrics.bytesReintroduced += Buffer.byteLength(text, "utf8");
		return {
			handle: formatHandle(record.id),
			start: from,
			end: to,
			text,
			citation: `${formatHandle(record.id)}[${from}:${to}]`,
		};
	}


	/**
	 * Search spilled text. Default mode is **literal** (safe on large corpora).
	 * `mode: "regex"` uses JS RegExp and remains opt-in / experimental.
	 */
	search(handle: string, pattern: string, limit = 8, mode: "literal" | "regex" = "literal"): RlmHit[] {
		const record = this.require(handle);
		const hits: RlmHit[] = [];
		this.flowHooks?.onSearchBegin?.(handle);
		const started = Date.now();
		this.metrics.searches += 1;
		if (mode === "literal") {
			let from = 0;
			while (hits.length < limit) {
				const index = record.text.indexOf(pattern, from);
				if (index < 0) break;
				const text = record.text.slice(index, Math.min(record.text.length, index + pattern.length + 80));
				hits.push({
					index,
					text,
					citation: `${formatHandle(record.id)}[${index}:${index + pattern.length}]`,
				});
				from = index + Math.max(1, pattern.length);
			}
			this.flowHooks?.onSearch?.({ handle, hits: hits.length, durationMs: Date.now() - started });
			return hits;
		}
		const regex = new RegExp(pattern, "g");
		let match: RegExpExecArray | null;
		while ((match = regex.exec(record.text)) !== null && hits.length < limit) {
			const index = match.index;
			const text = record.text.slice(index, Math.min(record.text.length, index + match[0].length + 80));
			hits.push({
				index,
				text,
				citation: `${formatHandle(record.id)}[${index}:${index + match[0].length}]`,
			});
			if (match[0].length === 0) regex.lastIndex += 1;
		}
		this.flowHooks?.onSearch?.({ handle, hits: hits.length, durationMs: Date.now() - started });
		return hits;
	}


	/** Operator / abort path: stop further subcalls and abort in-flight completers. */
	cancel(reason = "cancelled"): void {
		if (this.budget.cancelled) {
			this.#abortInflight();
			return;
		}
		this.budget.cancelled = true;
		this.budget.cancelReason = reason;
		this.note("cancel", reason, true);
		this.#abortInflight();
	}

	/** Drop corpus bodies and abort in-flight work. Idempotent. */
	dispose(reason = "dispose"): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.cancel(reason);
		this.records.clear();
		this.note("dispose", reason, true);
	}

	note(op: string, detail: string, failOpen?: boolean): void {
		if (failOpen) this.metrics.failOpen += 1;
		this.trajectory.push({ ts: Date.now(), op, detail, failOpen });
	}


	/**
	 * @deprecated Prefer {@link beginCall} + {@link reconcileUsage}.
	 * Still increments calls once and reserves tokens (legacy tests).
	 */
	charge(tokens: number, cost = 0): void {
		this.beginCall(tokens);
		if (cost > 0) {
			const r = this.reconcileUsage({ estimatedTokens: tokens, actualTokens: tokens, actualCost: cost });
			if (r.overBudget) throw new RlmBudgetError(`rlm maxCost ${this.budget.maxCost} exhausted`);
		}
	}

	/**
	 * Reserve one model call. Increments `calls` exactly once.
	 * Throws {@link RlmBudgetError} when cancelled, disposed, wall-clock, calls, or token cap blocks.
	 */
	beginCall(estimatedTokens: number): void {
		this.#assertLive("beginCall");
		this.#assertCallable();
		const tokens = Math.max(0, Math.floor(estimatedTokens));
		if (this.budget.tokens + tokens > this.budget.maxTotalTokens) {
			throw new RlmBudgetError(`rlm maxTotalTokens ${this.budget.maxTotalTokens} exhausted`);
		}
		if (this.budget.maxCost > 0 && this.budget.cost >= this.budget.maxCost) {
			throw new RlmBudgetError(`rlm maxCost ${this.budget.maxCost} exhausted`);
		}
		this.budget.calls += 1;
		this.budget.tokens += tokens;
	}

	/**
	 * Reconcile provider usage against the reservation from {@link beginCall}.
	 * Does **not** increment `calls`. Records over-budget honestly when actual exceeds caps.
	 */
	reconcileUsage(usage: RlmUsageReconcile): RlmReconcileResult {
		const estimated = Math.max(0, Math.floor(usage.estimatedTokens));
		const actualTokens =
			usage.actualTokens === undefined ? estimated : Math.max(0, Math.floor(usage.actualTokens));
		const actualCost = usage.actualCost === undefined ? 0 : Math.max(0, usage.actualCost);
		const delta = actualTokens - estimated;
		if (delta !== 0) this.budget.tokens += delta;
		this.budget.cost += actualCost;

		let overBudget = false;
		if (this.budget.tokens > this.budget.maxTotalTokens) overBudget = true;
		if (this.budget.maxCost > 0 && this.budget.cost > this.budget.maxCost) overBudget = true;
		if (overBudget) {
			this.budget.overBudget = true;
			this.note(
				"budget",
				`overBudget tokens=${this.budget.tokens}/${this.budget.maxTotalTokens} cost=${this.budget.cost}/${this.budget.maxCost}`,
				true,
			);
		}
		return { tokens: actualTokens, cost: actualCost, overBudget };
	}

	/**
	 * AbortSignal for one completer invocation: cancelled with store cancel/dispose
	 * and when wallClockMs remaining elapses.
	 */
	createCallSignal(): AbortSignal {
		const ctrl = new AbortController();
		if (this.#disposed || this.budget.cancelled) {
			ctrl.abort(new DOMException(this.budget.cancelReason ?? "rlm cancelled", "AbortError"));
			return ctrl.signal;
		}
		this.#inflight.add(ctrl);
		const clear = () => this.#inflight.delete(ctrl);
		ctrl.signal.addEventListener("abort", clear, { once: true });

		if (this.budget.wallClockMs > 0) {
			const remaining = this.budget.wallClockMs - (Date.now() - this.budget.startedAt);
			if (remaining <= 0) {
				ctrl.abort(new DOMException("rlm wallClockMs exhausted", "AbortError"));
			} else {
				const t = setTimeout(() => {
					this.note("wallclock", `deadline after ${this.budget.wallClockMs}ms`, true);
					ctrl.abort(new DOMException("rlm wallClockMs exhausted", "AbortError"));
				}, remaining);
				ctrl.signal.addEventListener("abort", () => clearTimeout(t), { once: true });
			}
		}
		return ctrl.signal;
	}

	status(): string {
		const m = this.metrics;
		const parts = [
			`handles=${this.records.size}`,
			`calls=${this.budget.calls}/${this.budget.maxCalls}`,
			`tokens=${this.budget.tokens}/${this.budget.maxTotalTokens}`,
			`maxDepth=${this.budget.maxDepth}`,
			`spills=${m.spills}`,
			`bytes_spilled=${m.bytesSpilled}`,
			`bytes_reintro=${m.bytesReintroduced}`,
			`peeks=${m.peeks}`,
			`searches=${m.searches}`,
			`queries=${m.queries}`,
			`subcalls=${m.subcalls}`,
			`fail_open=${m.failOpen}`,
			`rlm_reads=${m.resourceResolves}`,
			`grants_selected=${m.grantsSelected}`,
			`worker_avoided=${m.workerCallsAvoided}`,
		];
		if (this.budget.maxCost > 0) parts.push(`cost=${this.budget.cost.toFixed(4)}/${this.budget.maxCost}`);
		if (this.budget.wallClockMs > 0) {
			parts.push(`wallMs=${Date.now() - this.budget.startedAt}/${this.budget.wallClockMs}`);
		}
		if (this.budget.cancelled) parts.push(`cancelled=${this.budget.cancelReason ?? "yes"}`);
		if (this.budget.overBudget) parts.push("overBudget");
		if (this.#disposed) parts.push("disposed");
		parts.push(`trajectory=${this.trajectory.length}`);
		return parts.join(" ");
	}


	/** Compact-safe: never clears records. Compaction of root chat must call nothing here. */
	assertSurvivesCompaction(): void {
		// Marker for tests / reviewers — store is independent of message branch.
	}

	#assertLive(op: string): void {
		if (this.#disposed) throw new RlmBudgetError(`rlm store disposed (${op})`);
	}

	#assertCallable(): void {
		if (this.budget.cancelled) {
			throw new RlmBudgetError(`rlm cancelled: ${this.budget.cancelReason ?? "cancelled"}`);
		}
		if (this.budget.wallClockMs > 0) {
			const elapsed = Date.now() - this.budget.startedAt;
			if (elapsed > this.budget.wallClockMs) {
				throw new RlmBudgetError(`rlm wallClockMs ${this.budget.wallClockMs} exhausted (${elapsed}ms elapsed)`);
			}
		}
		if (this.budget.calls >= this.budget.maxCalls) {
			throw new RlmBudgetError(`rlm maxCalls ${this.budget.maxCalls} exhausted`);
		}
	}

	#abortInflight(): void {
		for (const ctrl of this.#inflight) {
			ctrl.abort(new DOMException(this.budget.cancelReason ?? "rlm cancelled", "AbortError"));
		}
		this.#inflight.clear();
	}

	private require(handle: string): RlmRecord {
		const record = this.get(handle);
		if (!record) throw new Error(`unknown rlm handle: ${handle}`);
		return record;
	}
}

export class RlmBudgetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RlmBudgetError";
	}
}

export function formatHandle(id: string): string {
	return `rlm://h/${id}`;
}

export function normalizeHandle(handle: string): string {
	return handle.trim().replace(/^rlm:\/\/h\//, "");
}

export function stubFor(record: RlmRecord): RlmStub {
	const handle = formatHandle(record.id);
	const head = record.text.slice(0, PREVIEW_CHARS);
	const tail = record.text.length > PREVIEW_CHARS ? record.text.slice(-PREVIEW_CHARS) : "";
	const preview = tail && record.text.length > PREVIEW_CHARS * 2 ? `${head}\n…\n${tail}` : head;
	const stub = [
		`[rlm spilled handle=${handle} bytes=${record.bytes} sha256=${record.sha256}${record.source ? ` source=${record.source}` : ""}]`,
		"Full payload is NOT in this message. Use read/grep on the handle, or rlm peek/search/select/query.",
		preview,
	].join("\n");
	return { handle, bytes: record.bytes, sha256: record.sha256, preview, stub };
}


/** Spill text larger than `spillBytes`; otherwise return the original. */
export function maybeSpill(store: RlmStore, text: string, spillBytes: number, source?: string): string {
	if (Buffer.byteLength(text, "utf8") <= spillBytes) return text;
	return stubFor(store.put(text, source)).stub;
}

export function stubContainsFullPayload(stub: string, original: string): boolean {
	if (original.length <= PREVIEW_CHARS * 2) return stub.includes(original);
	const mid = original.slice(Math.floor(original.length / 2) - 40, Math.floor(original.length / 2) + 40);
	return stub.includes(mid);
}
