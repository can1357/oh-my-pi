import { describe, expect, it } from "bun:test";
import { computeFileHash, InMemorySnapshotStore } from "@oh-my-pi/hashline";

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

	// The tokens.rs incident: a tag minted early in a session touching dozens
	// of files aged out of the path LRU, downgrading a recoverable stale-tag
	// mismatch to the misleading "hash is not from this session" rejection.
	it("keeps an early tag resolvable across a wide session at default capacity", () => {
		const store = new InMemorySnapshotStore();
		const tag = store.record(PATH, "first\n");
		for (let i = 0; i < 100; i++) store.record(`/w/other-${i}.ts`, `content ${i}\n`);
		expect(store.byHash(PATH, tag)?.text).toBe("first\n");
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

	// 4-hex tags are the low 16 bits of a non-cryptographic hash, so two
	// genuinely different file states can collide (birthday collisions at
	// ~256 distinct texts). The store must retain them as DISTINCT versions
	// so downstream tag→text lookups can still tell them apart. Regression
	// for issue #4075.
	describe("hash collisions", () => {
		// These two texts both hash to `1D84` under `computeFileHash`.
		const COLLIDE_A = "line one 263\nline two 4471\n";
		const COLLIDE_B = "line one 410\nline two 6970\n";

		it("keeps two colliding texts as separate versions with separate seenLines", () => {
			expect(computeFileHash(COLLIDE_A)).toBe(computeFileHash(COLLIDE_B));

			const store = new InMemorySnapshotStore();
			const tagA = store.record(PATH, COLLIDE_A, [1]);
			const tagB = store.record(PATH, COLLIDE_B, [2]);
			expect(tagA).toBe(tagB);

			// The two texts must round-trip independently via byContent.
			expect(store.byContent(PATH, COLLIDE_A)?.text).toBe(COLLIDE_A);
			expect(store.byContent(PATH, COLLIDE_B)?.text).toBe(COLLIDE_B);
			// seenLines never cross-contaminate: the [1] and [2] reads stay on
			// their own snapshots even though both tags say `1D84`.
			expect(store.byContent(PATH, COLLIDE_A)?.seenLines).toEqual(new Set([1]));
			expect(store.byContent(PATH, COLLIDE_B)?.seenLines).toEqual(new Set([2]));
			// byHash surfaces the most-recently-recorded version among the
			// colliders (B was recorded second → head).
			expect(store.byHash(PATH, tagA)?.text).toBe(COLLIDE_B);
			expect(store.head(PATH)?.text).toBe(COLLIDE_B);
		});

		it("still fuses identical repeated reads of one colliding text onto one snapshot", () => {
			const store = new InMemorySnapshotStore();
			const first = store.record(PATH, COLLIDE_A, [1]);
			const again = store.record(PATH, COLLIDE_A, [2]);
			expect(again).toBe(first);
			// One snapshot, seenLines union. The collider B is not present, so
			// byContent(B) is null even though the tag matches.
			expect(store.byContent(PATH, COLLIDE_A)?.seenLines).toEqual(new Set([1, 2]));
			expect(store.byContent(PATH, COLLIDE_B)).toBeNull();
		});
	});
});
