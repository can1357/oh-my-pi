import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StateBrokerStore } from "@oh-my-pi/pi-coding-agent/state-broker/store";
import type { StateEntry } from "@oh-my-pi/pi-coding-agent/state-broker/wire";
import { STATE_PAGE_LIMIT } from "@oh-my-pi/pi-coding-agent/state-broker/wire";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

/** Convenience: one entry. */
function entry(key: string, rev: number, value: unknown): StateEntry {
	return { key, rev, value };
}

describe("StateBrokerStore", () => {
	let tempDir = "";
	let dbPath = "";
	let store: StateBrokerStore | undefined;
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "state-broker-store-"));
		// Never let a default path resolve to the developer's real ~/.omp, even
		// though every store here is opened with an explicit path.
		process.env.PI_CODING_AGENT_DIR = tempDir;
		dbPath = path.join(tempDir, "state.db");
		store = StateBrokerStore.open(dbPath);
	});

	afterEach(async () => {
		store?.close();
		store = undefined;
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		await removeWithRetries(tempDir);
	});

	test("push assigns ascending seq and summary/currentSeq agree", () => {
		const s = store!;
		expect(s.currentSeq("history")).toBe(0);

		const first = s.push("history", [entry("a", 10, { v: 1 })]);
		expect(first).toEqual({ seq: 1, accepted: 1 });
		const second = s.push("history", [entry("b", 11, { v: 2 }), entry("c", 12, { v: 3 })]);
		expect(second).toEqual({ seq: 3, accepted: 2 });

		expect(s.currentSeq("history")).toBe(3);

		const summary = s.summary();
		const history = summary.find(d => d.domain === "history");
		expect(history).toEqual({ domain: "history", seq: 3, entries: 3 });
		// Untouched domains report zero.
		const titles = summary.find(d => d.domain === "titles");
		expect(titles).toEqual({ domain: "titles", seq: 0, entries: 0 });
	});

	test("strict LWW: equal rev is a no-op, greater wins, lesser is rejected", () => {
		const s = store!;
		expect(s.push("history", [entry("k", 100, "first")])).toEqual({ seq: 1, accepted: 1 });

		// Equal rev: dropped, seq does NOT advance.
		expect(s.push("history", [entry("k", 100, "tie")])).toEqual({ seq: 1, accepted: 0 });
		expect(s.currentSeq("history")).toBe(1);
		// Value unchanged by the rejected tie.
		expect(s.delta("history", 0, 10).entries[0]!.value).toBe("first");

		// Lesser rev: rejected.
		expect(s.push("history", [entry("k", 50, "older")])).toEqual({ seq: 1, accepted: 0 });
		expect(s.currentSeq("history")).toBe(1);
		expect(s.delta("history", 0, 10).entries[0]!.value).toBe("first");

		// Greater rev: accepted, advances seq, overwrites value.
		expect(s.push("history", [entry("k", 101, "newer")])).toEqual({ seq: 2, accepted: 1 });
		expect(s.currentSeq("history")).toBe(2);
		const latest = s.delta("history", 0, 10).entries;
		expect(latest).toHaveLength(1);
		expect(latest[0]).toEqual({ key: "k", rev: 101, value: "newer" });
	});

	test("mixed batch counts only the entries that won their comparison", () => {
		const s = store!;
		s.push("history", [entry("a", 5, "a5")]);
		// a@5 tie (drop), b@1 new (accept), a@6 wins (accept).
		const result = s.push("history", [entry("a", 5, "a5-again"), entry("b", 1, "b1"), entry("a", 6, "a6")]);
		expect(result.accepted).toBe(2);
		// seq advanced by exactly the two accepted rows (1 -> 3).
		expect(result.seq).toBe(3);
		expect(s.currentSeq("history")).toBe(3);
	});

	test("tombstone (value:null) round-trips as null through push -> delta", () => {
		const s = store!;
		// A JS `null` value encodes to SQL NULL — the tombstone marker. That is
		// the only reachable shape: there is no public push that stores the JSON
		// string "null", so the observable wire contract is simply that a
		// null-valued entry round-trips as null.
		expect(s.push("history", [entry("gone", 7, null)])).toEqual({ seq: 1, accepted: 1 });
		const rows = s.delta("history", 0, 10).entries;
		expect(rows).toHaveLength(1);
		expect(rows[0]!.key).toBe("gone");
		expect(rows[0]!.value).toBeNull();

		// A tombstone still wins LWW and replaces a prior concrete value.
		s.push("history", [entry("k", 1, { real: true })]);
		s.push("history", [entry("k", 2, null)]);
		const k = s.delta("history", 0, 10).entries.find(e => e.key === "k");
		expect(k).toEqual({ key: "k", rev: 2, value: null });

		// A stored concrete value is distinguishable from a tombstone.
		s.push("history", [entry("kept", 1, { real: true })]);
		const kept = s.delta("history", 0, 10).entries.find(e => e.key === "kept");
		expect(kept!.value).toEqual({ real: true });
	});

	test("delta: ascending seq, limit clamp, more flag, empty stays at since", () => {
		const s = store!;
		for (let i = 1; i <= 5; i += 1) s.push("history", [entry(`k${i}`, i, i)]);

		const page = s.delta("history", 0, 2);
		expect(page.entries.map(e => e.key)).toEqual(["k1", "k2"]);
		expect(page.seq).toBe(2);
		// `more` true exactly because the page filled.
		expect(page.more).toBe(true);

		const next = s.delta("history", page.seq, 2);
		expect(next.entries.map(e => e.key)).toEqual(["k3", "k4"]);
		expect(next.seq).toBe(4);
		expect(next.more).toBe(true);

		const last = s.delta("history", next.seq, 2);
		expect(last.entries.map(e => e.key)).toEqual(["k5"]);
		expect(last.seq).toBe(5);
		// Page did not fill (1 < 2) -> more is false.
		expect(last.more).toBe(false);

		// Empty delta: seq stays at `since`, more false.
		const empty = s.delta("history", 5, 2);
		expect(empty.entries).toHaveLength(0);
		expect(empty.seq).toBe(5);
		expect(empty.more).toBe(false);
	});

	test("delta clamps limit above STATE_PAGE_LIMIT", () => {
		const s = store!;
		const batch: StateEntry[] = [];
		for (let i = 1; i <= STATE_PAGE_LIMIT + 1; i += 1) batch.push(entry(`k${i}`, i, i));
		s.push("history", batch);

		// Ask for far more than the ceiling; the store clamps to STATE_PAGE_LIMIT.
		const page = s.delta("history", 0, STATE_PAGE_LIMIT * 5);
		expect(page.entries).toHaveLength(STATE_PAGE_LIMIT);
		// Filled to the cap -> more is true, one row remains.
		expect(page.more).toBe(true);
		const rest = s.delta("history", page.seq, STATE_PAGE_LIMIT * 5);
		expect(rest.entries).toHaveLength(1);
		expect(rest.more).toBe(false);
	});

	test("subscribe fires on accepted push, not on a fully-rejected one; unsubscribe stops delivery", () => {
		const s = store!;
		s.push("history", [entry("k", 10, "v")]);

		let fired = 0;
		const unsub = s.subscribe("history", () => {
			fired += 1;
		});

		// Accepted push -> one wake-up.
		s.push("history", [entry("k", 11, "v2")]);
		expect(fired).toBe(1);

		// Fully-rejected push (equal rev) -> no wake-up.
		s.push("history", [entry("k", 11, "tie")]);
		expect(fired).toBe(1);

		// Rejected (lesser rev) -> no wake-up.
		s.push("history", [entry("k", 5, "older")]);
		expect(fired).toBe(1);

		// A push to a different domain does not wake this subscriber.
		s.push("titles", [entry("t", 1, "x")]);
		expect(fired).toBe(1);

		// After unsubscribe, no further delivery.
		unsub();
		s.push("history", [entry("k", 12, "v3")]);
		expect(fired).toBe(1);
	});

	test("reopening the same path preserves state", () => {
		const s = store!;
		s.push("history", [entry("a", 10, "keep"), entry("b", 11, null)]);
		s.push("titles", [entry("t", 3, "title")]);
		s.close();
		store = undefined;

		const reopened = StateBrokerStore.open(dbPath);
		try {
			expect(reopened.currentSeq("history")).toBe(2);
			expect(reopened.currentSeq("titles")).toBe(1);
			const history = reopened.delta("history", 0, 10).entries;
			expect(history).toEqual([
				{ key: "a", rev: 10, value: "keep" },
				{ key: "b", rev: 11, value: null },
			]);
			// A further push continues the seq from where it left off.
			expect(reopened.push("history", [entry("c", 12, "more")])).toEqual({ seq: 3, accepted: 1 });
		} finally {
			reopened.close();
		}
	});
});
