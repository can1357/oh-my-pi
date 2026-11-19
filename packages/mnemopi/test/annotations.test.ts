import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ANNOTATION_KINDS,
	AnnotationStore,
	addAnnotation,
	filterCleanMentions,
	filterFacts,
	initAnnotations,
	queryAnnotations,
} from "@oh-my-pi/pi-mnemopi/core/annotations";
import { openDatabase } from "@oh-my-pi/pi-mnemopi/db";

const cleanup: string[] = [];

function tempDb(): string {
	const dir = mkdtempSync(join(tmpdir(), "mnemopi-annotations-"));
	cleanup.push(dir);
	return join(dir, "annotations.db");
}

afterEach(() => {
	while (cleanup.length > 0) {
		const path = cleanup.pop();
		if (path) rmSync(path, { recursive: true, force: true });
	}
});

describe("AnnotationStore", () => {
	it("preserves multiple annotation values for one memory without temporal invalidation columns", () => {
		const store = new AnnotationStore(tempDb());
		try {
			const firstId = store.add("mem-1", "mentions", "Alice");
			const secondId = store.add("mem-1", "mentions", "Bob");
			store.add("mem-1", "mentions", "Charlie");
			store.add("mem-1", "fact", "The user prefers concise answers");

			expect(firstId).toBeGreaterThan(0);
			expect(secondId).toBeGreaterThan(firstId);
			expect(new Set(store.queryByMemory("mem-1", "mentions").map(row => row.value))).toEqual(
				new Set(["Alice", "Bob", "Charlie"]),
			);
			const [row] = store.exportAll();
			expect(row).not.toHaveProperty("valid_from");
			expect(row).not.toHaveProperty("valid_until");
		} finally {
			store.close();
		}
	});

	it("queries by memory, kind, value, memory link, and distinct values", () => {
		const store = new AnnotationStore(tempDb());
		try {
			store.add("mem-1", "mentions", "Alice");
			store.add("mem-1", "mentions", "Bob");
			store.add("mem-2", "mentions", "Alice");
			store.add("mem-1", "fact", "Some fact about mem-1");

			expect(store.queryByMemory("mem-1")).toHaveLength(3);
			expect(store.queryByMemory("mem-1", "mentions").every(row => row.kind === "mentions")).toBe(true);
			expect(new Set(store.queryByKind("mentions", { value: "Alice" }).map(row => row.memory_id))).toEqual(
				new Set(["mem-1", "mem-2"]),
			);
			expect(new Set(store.queryByKind("mentions", { memory_id: "mem-1" }).map(row => row.value))).toEqual(
				new Set(["Alice", "Bob"]),
			);
			expect(store.getDistinctValues("mentions")).toEqual(["Alice", "Bob"]);
		} finally {
			store.close();
		}
	});

	it("deduplicates logical annotations idempotently while preserving different kinds", () => {
		const store = new AnnotationStore(tempDb());
		try {
			store.add("mem-1", "mentions", "Alice", "extractor", 0.8);
			store.add("mem-1", "mentions", "Alice", "other", 0.1);
			store.add("mem-1", "fact", "Alice");
			store.addMany("mem-1", "mentions", ["Alice", "Bob", "", "  "]);

			expect(store.queryByMemory("mem-1", "mentions").map(row => row.value)).toEqual(["Alice", "Bob"]);
			expect(store.queryByMemory("mem-1", "fact").map(row => row.value)).toEqual(["Alice"]);
		} finally {
			store.close();
		}
	});

	it("filters known annotation kinds, noisy mention rows, and short facts like the Python helpers", () => {
		expect(ANNOTATION_KINDS.has("mentions")).toBe(true);
		expect(ANNOTATION_KINDS.has("fact")).toBe(true);
		expect(ANNOTATION_KINDS.has("occurred_on")).toBe(true);
		expect(ANNOTATION_KINDS.has("has_source")).toBe(true);
		expect(filterFacts(["short", "This fact is long enough"])).toEqual(["This fact is long enough"]);
		expect(
			filterCleanMentions([{ value: "Alice" }, { value: "assistant" }, { value: "Project Alice" }]).map(
				row => row.value,
			),
		).toEqual(["Alice"]);
	});

	it("exports and imports with idempotent duplicate-id handling", () => {
		const src = new AnnotationStore(tempDb());
		const dst = new AnnotationStore(tempDb());
		try {
			src.add("mem-1", "mentions", "Alice", "extraction", 0.8);
			src.add("mem-1", "mentions", "Bob");
			const exported = src.exportAll();

			expect(dst.importAll(exported)).toEqual({
				inserted: 2,
				skipped: 0,
				overwritten: 0,
				imported_renumbered: 0,
			});
			expect(dst.importAll(exported)).toEqual({
				inserted: 0,
				skipped: 2,
				overwritten: 0,
				imported_renumbered: 0,
			});
			expect(dst.exportAll()).toHaveLength(2);
		} finally {
			src.close();
			dst.close();
		}
	});

	it("initializes and reuses a shared bun:sqlite connection", () => {
		const path = tempDb();
		initAnnotations(path);
		const db = openDatabase(path);
		try {
			const store = new AnnotationStore({ conn: db });
			store.add("mem-1", "has_source", "custom-tool");
			using statement = db.prepare("SELECT memory_id, kind, value FROM annotations");
			const rows = statement.all() as {
				memory_id: string;
				kind: string;
				value: string;
			}[];
			expect(rows).toEqual([{ memory_id: "mem-1", kind: "has_source", value: "custom-tool" }]);
		} finally {
			db.close();
		}
	});

	it("provides module-level snake_case convenience APIs", () => {
		const path = tempDb();
		addAnnotation("mem-1", "occurred_on", "2026-05-30", "test", 1.0, path);
		addAnnotation("mem-1", "mentions", "Alice", "test", 1.0, path);
		expect(queryAnnotations("mem-1", "occurred_on", undefined, path).map(row => row.value)).toEqual(["2026-05-30"]);
	});
});
