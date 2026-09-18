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

export interface RlmBudget {
	maxDepth: number;
	maxCalls: number;
	maxTotalTokens: number;
	calls: number;
	tokens: number;
}

/** Session-scoped original-byte store. Corpus never belongs in the root prompt. */
export class RlmStore {
	#next = 1;
	readonly records = new Map<string, RlmRecord>();
	readonly budget: RlmBudget;

	constructor(budget?: Partial<RlmBudget>) {
		this.budget = {
			maxDepth: budget?.maxDepth ?? 0,
			maxCalls: budget?.maxCalls ?? 32,
			maxTotalTokens: budget?.maxTotalTokens ?? 1_000_000,
			calls: 0,
			tokens: 0,
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

	/** Charge a subcall. Throws when the mechanical budget is exhausted. */
	charge(tokens: number): void {
		if (this.budget.calls >= this.budget.maxCalls) {
			throw new RlmBudgetError(`rlm maxCalls ${this.budget.maxCalls} exhausted`);
		}
		if (this.budget.tokens + tokens > this.budget.maxTotalTokens) {
			throw new RlmBudgetError(`rlm maxTotalTokens ${this.budget.maxTotalTokens} exhausted`);
		}
		this.budget.calls += 1;
		this.budget.tokens += tokens;
	}

	status(): string {
		return [
			`handles=${this.records.size}`,
			`calls=${this.budget.calls}/${this.budget.maxCalls}`,
			`tokens=${this.budget.tokens}/${this.budget.maxTotalTokens}`,
			`maxDepth=${this.budget.maxDepth}`,
		].join(" ");
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
