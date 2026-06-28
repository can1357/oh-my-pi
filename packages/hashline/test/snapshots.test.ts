import { describe, expect, it } from "bun:test";
import { computeFileHash, InMemorySnapshotStore } from "@pk-nerdsaver-ai/hashline";

const PATH = "/tmp/__hashline-snapshots__.ts";
const OTHER = "/tmp/__hashline-other__.ts";
const TAG_RE = /^[0-9A-F]{4}$/;

describe("InMemorySnapshotStore", () => {
	it("derives the tag from whole-file content (matches computeFileHash)", () => {
		const store = new InMemorySnapshotStore();
		const text = "L1\nL2\nL3\n";
		const tag = store.record(PATH, text);
		expect(tag).toMatch(TAG_RE);
		expect(tag).toBe(computeFileHash(text));
	});

	it("fuses repeated reads of identical content onto one tag", () => {
		const store = new InMemorySnapshotStore();
		const text = "alpha\nbeta\ngamma\n";
		const first = store.record(PATH, text);
		const second = store.record(PATH, text);
		expect(second).toBe(first);
		// One head, byHash resolves to the same full text.
		expect(store.head(PATH)?.hash).toBe(first);
		expect(store.byHash(PATH, first)?.text).toBe(text);
	});

	it("mints a new tag when content changes and retains the prior version", () => {
		const store = new InMemorySnapshotStore();
		const v1 = "one\ntwo\n";
		const v2 = "one\ntwo\nthree\n";
		const tag1 = store.record(PATH, v1);
		const tag2 = store.record(PATH, v2);
		expect(tag2).not.toBe(tag1);
		// Head is the latest; the older version is still resolvable by its tag.
		expect(store.head(PATH)?.hash).toBe(tag2);
		expect(store.byHash(PATH, tag1)?.text).toBe(v1);
		expect(store.byHash(PATH, tag2)?.text).toBe(v2);
	});

	it("promotes a re-observed older version back to head", () => {
		const store = new InMemorySnapshotStore();
		const v1 = "x\n";
		const v2 = "y\n";
		const tag1 = store.record(PATH, v1);
		store.record(PATH, v2);
		// File reverts to v1 content: recording it again makes v1 the head.
		expect(store.record(PATH, v1)).toBe(tag1);
		expect(store.head(PATH)?.hash).toBe(tag1);
	});

	it("bounds per-path history to maxVersionsPerPath (oldest dropped)", () => {
		const store = new InMemorySnapshotStore({ maxVersionsPerPath: 2 });
		const tagA = store.record(PATH, "A\n");
		const tagB = store.record(PATH, "B\n");
		const tagC = store.record(PATH, "C\n");
		// Only the two newest versions survive.
		expect(store.byHash(PATH, tagC)?.text).toBe("C\n");
		expect(store.byHash(PATH, tagB)?.text).toBe("B\n");
		expect(store.byHash(PATH, tagA)).toBeNull();
	});

	it("bounds tracked paths to maxPaths (cold path evicted)", () => {
		const store = new InMemorySnapshotStore({ maxPaths: 1 });
		const tag = store.record(PATH, "first\n");
		store.record(OTHER, "second\n");
		// Recording OTHER evicted PATH from the LRU.
		expect(store.byHash(PATH, tag)).toBeNull();
		expect(store.head(PATH)).toBeNull();
	});

	it("rejects cross-path lookups", () => {
		const store = new InMemorySnapshotStore();
		const tag = store.record(PATH, "shared\n");
		expect(store.byHash(OTHER, tag)).toBeNull();
	});

	it("invalidate drops one path; clear drops everything", () => {
		const store = new InMemorySnapshotStore();
		const tagA = store.record(PATH, "A\n");
		const tagB = store.record(OTHER, "B\n");
		store.invalidate(PATH);
		expect(store.byHash(PATH, tagA)).toBeNull();
		expect(store.byHash(OTHER, tagB)?.text).toBe("B\n");
		store.clear();
		expect(store.byHash(OTHER, tagB)).toBeNull();
	});

	it("relocate moves version history and read provenance to a new path", () => {
		const store = new InMemorySnapshotStore();
		const dest = "/tmp/__hashline-dest__.ts";
		const tag = store.record(PATH, "A\n", [1]);
		store.relocate(PATH, dest);
		expect(store.byHash(PATH, tag)).toBeNull();
		expect(store.byHash(dest, tag)?.text).toBe("A\n");
		expect(store.byHash(dest, tag)?.seenLines).toEqual(new Set([1]));
		expect(store.head(dest)?.hash).toBe(tag);
	});

	it("findByHash returns every retained version with that tag across paths", () => {
		const store = new InMemorySnapshotStore();
		const text = "shared\n";
		const tag = store.record(PATH, text);
		store.record(OTHER, text);

		const matches = store.findByHash(tag);
		expect(matches.map(snapshot => snapshot.path).sort()).toEqual([OTHER, PATH].sort());
		expect(matches.every(snapshot => snapshot.hash === tag)).toBe(true);
		// A tag no retained version carries yields no matches.
		expect(store.findByHash(tag === "0000" ? "FFFF" : "0000")).toEqual([]);
	});
});
