import { describe, expect, it } from "bun:test";
import {
	DEDUPER_NAME,
	DEDUPER_VERSION,
	exactDedup,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/context-hygiene/dedup";
import type { ContextItem } from "@oh-my-pi/pi-coding-agent/memory-fabric/context-hygiene/types";

const clock = () => new Date("2026-07-22T12:00:00.000Z");
const opts = { now: clock };

function item(over: Partial<ContextItem> & { id: string; content: string }): ContextItem {
	return over;
}

describe("context-hygiene / exact dedup (byte identity only)", () => {
	it("collapses byte-identical items, keeping the first occurrence", () => {
		const items = [
			item({ id: "a", content: "same text" }),
			item({ id: "b", content: "same text" }),
			item({ id: "c", content: "different" }),
		];
		const out = exactDedup(items, opts);
		expect(out.items.map(i => i.id)).toEqual(["a", "c"]);
		expect(out.removed.map(r => r.originId)).toEqual(["b"]);
		expect(out.removed[0].canonicalId).toBe("a");
	});

	it("does NOT collapse items that differ by even one character", () => {
		const items = [item({ id: "a", content: "exit code 1" }), item({ id: "b", content: "exit code 2" })];
		const out = exactDedup(items, opts);
		expect(out.items.map(i => i.id)).toEqual(["a", "b"]);
		expect(out.removed).toEqual([]);
	});

	it("preserves input order of the survivors", () => {
		const items = [
			item({ id: "1", content: "x" }),
			item({ id: "2", content: "y" }),
			item({ id: "3", content: "x" }),
			item({ id: "4", content: "z" }),
		];
		const out = exactDedup(items, opts);
		expect(out.items.map(i => i.id)).toEqual(["1", "2", "4"]);
	});
});

describe("context-hygiene / dedup provenance retention (rule #1)", () => {
	it("merges the origin id, source and index of every removed copy onto the canonical", () => {
		const items = [
			item({ id: "a", content: "dup", source: "lane/one" }),
			item({ id: "b", content: "dup", source: "lane/two" }),
			item({ id: "c", content: "dup", source: "lane/three" }),
		];
		const out = exactDedup(items, opts);
		const canonical = out.items[0];
		expect(canonical.id).toBe("a");
		expect(canonical.provenance.duplicatesMerged).toEqual([
			{ originId: "b", source: "lane/two", index: 1 },
			{ originId: "c", source: "lane/three", index: 2 },
		]);
		expect(canonical.provenance.deduper).toBe(DEDUPER_NAME);
		expect(canonical.provenance.deduperVersion).toBe(DEDUPER_VERSION);
		expect(canonical.provenance.dedupedAt).toBe("2026-07-22T12:00:00.000Z");
	});

	it("prefers an existing upstream originId over the item id when merging", () => {
		const items = [
			item({ id: "a", content: "dup" }),
			item({ id: "b", content: "dup", provenance: { originId: "upstream-b" } }),
		];
		const out = exactDedup(items, opts);
		expect(out.items[0].provenance.duplicatesMerged).toEqual([
			{ originId: "upstream-b", source: undefined, index: 1 },
		]);
	});

	it("does not stamp deduper metadata on an item that absorbed nothing", () => {
		const out = exactDedup([item({ id: "solo", content: "unique" })], opts);
		expect(out.items[0].provenance.duplicatesMerged).toBeUndefined();
		expect(out.items[0].provenance.deduper).toBeUndefined();
		expect(out.items[0].provenance.originId).toBe("solo");
	});

	it("never mutates the caller's input items", () => {
		const input = [item({ id: "a", content: "dup" }), item({ id: "b", content: "dup" })];
		exactDedup(input, opts);
		expect(input).toHaveLength(2);
		expect(input[0].provenance).toBeUndefined();
	});
});

describe("context-hygiene / dedup protected content", () => {
	it("never removes a no-compression item, even as an exact duplicate", () => {
		const items = [item({ id: "a", content: "pin" }), item({ id: "b", content: "pin", noCompression: true })];
		const out = exactDedup(items, opts);
		expect(out.items.map(i => i.id)).toEqual(["a", "b"]);
		expect(out.removed).toEqual([]);
	});

	it("honours a custom isProtected predicate", () => {
		const items = [item({ id: "a", content: "dup" }), item({ id: "b", content: "dup", type: "security" })];
		const out = exactDedup(items, { ...opts, isProtected: i => i.type === "security" });
		expect(out.items.map(i => i.id)).toEqual(["a", "b"]);
	});

	it("retains whitespace-only items instead of collapsing them together", () => {
		const items = [item({ id: "a", content: "   " }), item({ id: "b", content: "   " })];
		const out = exactDedup(items, opts);
		expect(out.items.map(i => i.id)).toEqual(["a", "b"]);
		expect(out.removed).toEqual([]);
	});

	it("collapses whitespace-only items when skipEmpty is disabled", () => {
		const items = [item({ id: "a", content: "   " }), item({ id: "b", content: "   " })];
		const out = exactDedup(items, { ...opts, skipEmpty: false });
		expect(out.items.map(i => i.id)).toEqual(["a"]);
	});
});

describe("context-hygiene / dedup keying", () => {
	it("treats identical content from different sources as duplicates by default", () => {
		const items = [item({ id: "a", content: "d", source: "one" }), item({ id: "b", content: "d", source: "two" })];
		const out = exactDedup(items, opts);
		expect(out.items.map(i => i.id)).toEqual(["a"]);
	});

	it("keeps them apart when scopeBySource is enabled", () => {
		const items = [item({ id: "a", content: "d", source: "one" }), item({ id: "b", content: "d", source: "two" })];
		const out = exactDedup(items, { ...opts, scopeBySource: true });
		expect(out.items.map(i => i.id)).toEqual(["a", "b"]);
	});

	it("lets a custom keyOf override the default keying", () => {
		const items = [item({ id: "a", content: "one" }), item({ id: "b", content: "two" })];
		const out = exactDedup(items, { ...opts, keyOf: () => "constant" });
		expect(out.items.map(i => i.id)).toEqual(["a"]);
	});
});

describe("context-hygiene / dedup telemetry", () => {
	it("reports deterministic before/after counts, bytes and token estimates", () => {
		const items = [item({ id: "a", content: "12345678" }), item({ id: "b", content: "12345678" })];
		const out = exactDedup(items, opts);
		expect(out.telemetry.inputCount).toBe(2);
		expect(out.telemetry.outputCount).toBe(1);
		expect(out.telemetry.removedCount).toBe(1);
		expect(out.telemetry.bytesBefore).toBe(16);
		expect(out.telemetry.bytesAfter).toBe(8);
		expect(out.telemetry.approxTokensBefore).toBe(4);
		expect(out.telemetry.approxTokensAfter).toBe(2);
		expect(out.telemetry.failedOpen).toBe(false);
		expect(out.telemetry.dedupedAt).toBe("2026-07-22T12:00:00.000Z");
	});

	it("handles an empty input list without error", () => {
		const out = exactDedup([], opts);
		expect(out.items).toEqual([]);
		expect(out.telemetry.inputCount).toBe(0);
		expect(out.telemetry.failedOpen).toBe(false);
	});
});

describe("context-hygiene / dedup fail-open (rule #4)", () => {
	it("returns the original list unchanged when a key extractor throws", () => {
		const items = [item({ id: "a", content: "x" }), item({ id: "b", content: "y" })];
		const boom = () => {
			throw new Error("boom");
		};
		const out = exactDedup(items, { ...opts, keyOf: boom });
		expect(out.items.map(i => i.id)).toEqual(["a", "b"]);
		expect(out.removed).toEqual([]);
		expect(out.telemetry.failedOpen).toBe(true);
		expect(out.telemetry.bytesAfter).toBe(out.telemetry.bytesBefore);
	});

	it("never throws out of the dedup step", () => {
		const boom = () => {
			throw new Error("boom");
		};
		expect(() => exactDedup([item({ id: "a", content: "x" })], { ...opts, isProtected: boom })).not.toThrow();
	});
});
