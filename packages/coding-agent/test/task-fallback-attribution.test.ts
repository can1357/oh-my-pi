import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "../src/session/session-entries";
import { findFallbackEntryForEvent } from "../src/task/fallback-attribution";

function change(id: string, model: string, from?: string): SessionEntry {
	return {
		type: "model_change",
		id,
		parentId: null,
		timestamp: "2026-10-12T00:00:00Z",
		model,
		resolvedModelIsFallback: from !== undefined,
		...(from ? { fallback: { from } } : {}),
	} as SessionEntry;
}

describe("findFallbackEntryForEvent", () => {
	const branch = [change("a", "p/primary"), change("b", "p/fb1", "p/primary")];

	it("attributes the primary transition once", () => {
		const entry = findFallbackEntryForEvent(branch, "p/primary", new Set());
		expect(entry?.id).toBe("b");
		expect(findFallbackEntryForEvent(branch, "p/primary", new Set(["b"]))).toBeUndefined();
	});

	it("ignores an advisor event whose source differs from the newest entry", () => {
		expect(findFallbackEntryForEvent(branch, "p/advisor", new Set())).toBeUndefined();
	});

	it("skips plain model changes but never re-attributes a consumed entry", () => {
		const later = [...branch, change("c", "p/primary")];
		expect(findFallbackEntryForEvent(later, "p/primary", new Set())?.id).toBe("b");
		expect(findFallbackEntryForEvent(later, "p/primary", new Set(["b"]))).toBeUndefined();
	});
});
