const KIRO_TOOL_USE_ID = /^[a-zA-Z0-9_-]+$/;

export interface KiroToolUseIdNormalizer {
	normalize(id: string): string;
}

/** Stable request-local normalization; valid IDs remain byte-identical. */
export function createKiroToolUseIdNormalizer(): KiroToolUseIdNormalizer {
	const byOriginal = new Map<string, string>();
	const owners = new Map<string, string>();
	return {
		normalize(id) {
			const existing = byOriginal.get(id);
			if (existing) return existing;
			const base = id && KIRO_TOOL_USE_ID.test(id) ? id : `call_${Bun.hash(id || "<empty>").toString(36)}`;
			let candidate = base;
			let suffix = 2;
			while (owners.has(candidate) && owners.get(candidate) !== id) candidate = `${base}_${suffix++}`;
			owners.set(candidate, id);
			byOriginal.set(id, candidate);
			return candidate;
		},
	};
}
