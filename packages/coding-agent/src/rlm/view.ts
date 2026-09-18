import { createHash, randomUUID } from "node:crypto";
import { formatHandle, type RlmStore } from "./store";

/** One granted slice into a spilled handle (raw tool args). */
export interface RlmGrant {
	handle: string;
	start?: number;
	end?: number;
}
/** One resolved, immutable grant slice (capability). */
export interface RlmResolvedGrant {
	handle: string;
	recordId: string;
	start: number;
	end: number;
	sha256: string;
	/** Capped excerpt text the worker may see. */
	text: string;
	citation: string;
	bytes: number;
}

/**
 * First-class capability view for one RLM inference.
 * Worker receives this view only — never unrestricted store access.
 */
export interface RlmView {
	id: string;
	createdAt: number;
	grants: readonly RlmResolvedGrant[];
	/** Total granted UTF-8 bytes (capped excerpts). */
	grantedBytes: number;
}

export const RLM_VIEW_SLICE = 8_192;

/**
 * Resolve raw handle grants into an immutable {@link RlmView}.
 * Unknown handles throw; callers fail-open.
 */
export function resolveRlmView(
	store: RlmStore,
	grants: readonly RlmGrant[],
	options?: { maxGrants?: number; perGrantSlice?: number },
): RlmView {
	const maxGrants = options?.maxGrants ?? 8;
	const perGrantSlice = options?.perGrantSlice ?? RLM_VIEW_SLICE;
	const limited = grants.slice(0, maxGrants);
	const resolved: RlmResolvedGrant[] = [];

	for (const grant of limited) {
		const peek = store.peek(grant.handle, grant.start ?? 0, grant.end);
		const text = peek.text.length > perGrantSlice ? peek.text.slice(0, perGrantSlice) : peek.text;
		const record = store.get(grant.handle);
		if (!record) throw new Error(`unknown rlm handle: ${grant.handle}`);
		resolved.push({
			handle: peek.handle,
			recordId: record.id,
			start: peek.start,
			end: peek.start + text.length,
			sha256: createHash("sha256").update(text).digest("hex"),
			text,
			citation: `${formatHandle(record.id)}[${peek.start}:${peek.start + text.length}]`,
			bytes: Buffer.byteLength(text, "utf8"),
		});
	}

	return {
		id: `view:${randomUUID()}`,
		createdAt: Date.now(),
		grants: Object.freeze(resolved),
		grantedBytes: resolved.reduce((n, g) => n + g.bytes, 0),
	};
}

/** Format granted excerpts for a worker prompt (no store access). */
export function formatViewExcerpts(view: RlmView): string {
	return view.grants.map(g => `${g.citation}\n${g.text}`).join("\n\n");
}

export function viewCitations(view: RlmView): string {
	return view.grants.map(g => g.citation).join("; ");
}
