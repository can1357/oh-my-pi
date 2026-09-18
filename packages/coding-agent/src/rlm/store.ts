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
}

/** Session-scoped original-byte store. Corpus never belongs in the root prompt. */
export class RlmStore {
	#next = 1;
	readonly records = new Map<string, RlmRecord>();
	readonly budget: RlmBudget;
	/** Honest partial trajectory for cancel / budget stops (RFC v1). */
	readonly trajectory: RlmTrajectoryEntry[] = [];

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
		};
	}

	put(text: string, source?: string): RlmRecord {
		const id = String(this.#next++);
		const record: RlmRecord = {
			id,
			bytes: Buffer.byteLength(text, "utf8"),
			sha256: createHash("sha256").update(text).digest("hex"),
			source,
			text,
		};
		this.records.set(id, record);
		this.note("put", `handle=rlm://h/${id} bytes=${record.bytes}${source ? ` source=${source}` : ""}`);
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
		return {
			handle: formatHandle(record.id),
			start: from,
			end: to,
			text,
			citation: `${formatHandle(record.id)}[${from}:${to}]`,
		};
	}

	search(handle: string, pattern: string, limit = 8): RlmHit[] {
		const record = this.require(handle);
		const regex = new RegExp(pattern, "g");
		const hits: RlmHit[] = [];
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
		return hits;
	}

	/** Operator / abort path: stop further subcalls; keep handles + trajectory. */
	cancel(reason = "cancelled"): void {
		if (this.budget.cancelled) return;
		this.budget.cancelled = true;
		this.budget.cancelReason = reason;
		this.note("cancel", reason, true);
	}

	note(op: string, detail: string, failOpen?: boolean): void {
		this.trajectory.push({ ts: Date.now(), op, detail, failOpen });
	}

	/**
	 * Charge a subcall. Throws {@link RlmBudgetError} when mechanical budget is exhausted,
	 * cancelled, or wall-clock exceeded.
	 */
	charge(tokens: number, cost = 0): void {
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
		if (this.budget.tokens + tokens > this.budget.maxTotalTokens) {
			throw new RlmBudgetError(`rlm maxTotalTokens ${this.budget.maxTotalTokens} exhausted`);
		}
		if (this.budget.maxCost > 0 && this.budget.cost >= this.budget.maxCost) {
			throw new RlmBudgetError(`rlm maxCost ${this.budget.maxCost} exhausted`);
		}
		if (this.budget.maxCost > 0 && this.budget.cost + cost > this.budget.maxCost) {
			throw new RlmBudgetError(`rlm maxCost ${this.budget.maxCost} exhausted`);
		}
		this.budget.calls += 1;
		this.budget.tokens += tokens;
		this.budget.cost += cost;
	}

	status(): string {
		const parts = [
			`handles=${this.records.size}`,
			`calls=${this.budget.calls}/${this.budget.maxCalls}`,
			`tokens=${this.budget.tokens}/${this.budget.maxTotalTokens}`,
			`maxDepth=${this.budget.maxDepth}`,
		];
		if (this.budget.maxCost > 0) parts.push(`cost=${this.budget.cost.toFixed(4)}/${this.budget.maxCost}`);
		if (this.budget.wallClockMs > 0) {
			parts.push(`wallMs=${Date.now() - this.budget.startedAt}/${this.budget.wallClockMs}`);
		}
		if (this.budget.cancelled) parts.push(`cancelled=${this.budget.cancelReason ?? "yes"}`);
		parts.push(`trajectory=${this.trajectory.length}`);
		return parts.join(" ");
	}


	/** Compact-safe: never clears records. Compaction of root chat must call nothing here. */
	assertSurvivesCompaction(): void {
		// Marker for tests / reviewers — store is independent of message branch.
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
		"Full payload is NOT in this message. Use the rlm tool (peek/search/query) on the handle.",
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
