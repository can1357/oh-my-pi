import type { LimitsMeta } from "./output-meta";

export interface ListLimitResult<T> {
	items: T[];
	limitReached?: number;
	meta: Partial<LimitsMeta>;
}

export interface ListLimitOptions {
	limit?: number;
	headLimit?: number;
	limitType?: "match" | "result";
}

export function applyListLimit<T>(items: T[], options: ListLimitOptions): ListLimitResult<T> {
	const meta: Partial<LimitsMeta> = {};
	const limitType = options.limitType ?? "result";
	const effectiveLimit = options.limit !== undefined && options.limit > 0 ? options.limit : undefined;
	const effectiveHeadLimit = options.headLimit !== undefined && options.headLimit > 0 ? options.headLimit : undefined;
	let limited = items;
	let limitReached: number | undefined;

	if (effectiveLimit !== undefined && items.length >= effectiveLimit) {
		limited = items.slice(0, effectiveLimit);
		limitReached = effectiveLimit;
		const suggestion = effectiveLimit * 2;
		if (limitType === "match") {
			meta.matchLimit = { reached: effectiveLimit, suggestion };
		} else {
			meta.resultLimit = { reached: effectiveLimit, suggestion };
		}
	}

	if (effectiveHeadLimit !== undefined && limited.length > effectiveHeadLimit) {
		limited = limited.slice(0, effectiveHeadLimit);
		meta.headLimit = { reached: effectiveHeadLimit, suggestion: effectiveHeadLimit * 2 };
	}

	return { items: limited, limitReached, meta };
}
