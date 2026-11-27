/**
 * The TTL and overflow trim of transient working memory addresses rows by rowid, not by `id`.
 *
 * `id TEXT PRIMARY KEY` on a rowid table admits NULL, and a database rebuilt by SQLite's `.recover`
 * can hold such a row. By id the trim could not remove one, because `id NOT IN (keep set)` is NULL,
 * never true, for the row itself. While such a row was among the newest `workingMemoryLimit` rows,
 * the keep set held a NULL, which made the test NULL for every other row too, so the overflow half
 * trimmed nothing until newer writes pushed the row out of that window.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import { remember } from "@oh-my-pi/pi-mnemopi/core/beam/store";
import type { BeamConfig, BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";
import { openDatabase } from "@oh-my-pi/pi-mnemopi/db";

const SESSION = "session-a";
// A row as SQLite's `.recover` rebuilt one: a page of an fts5 index read back as a working_memory
// record, keeping that page's rowid ((10 << 37) + 1, segment 10 page 1) and its NULL id.
const RECOVERED_ROWID = 10 * 2 ** 37 + 1;
// A rowid a JS number cannot hold: 2^53 + 1 reads back as 2^53 unless it stays text.
const HUGE_ROWID = "9007199254740993";

const states: BeamMemoryState[] = [];

function makeState(limit: number, ttlHours = 24): BeamMemoryState {
	const db = openDatabase(":memory:");
	initBeam(db);
	const config: BeamConfig = {
		workingMemoryLimit: limit,
		workingMemoryTtlHours: ttlHours,
		recencyHalflifeHours: 72,
		vecWeight: 0.5,
		ftsWeight: 0.3,
		importanceWeight: 0.2,
		useCloud: false,
		localLlmEnabled: false,
		maxEpisodeChars: 100_000,
	};
	const state = {
		db,
		dbPath: ":memory:",
		sessionId: SESSION,
		authorId: "author-a",
		authorType: "user",
		channelId: "channel-a",
		useCloud: false,
		eventEmitter: () => {},
		annotations: null,
		triples: null,
		episodicGraph: null,
		veracityConsolidator: null,
		caches: { timestampParse: new Map(), extractionBuffer: [] },
		config,
	} as unknown as BeamMemoryState;
	states.push(state);
	return state;
}

afterEach(() => {
	while (states.length > 0) states.pop()?.db.close();
});

function addMemory(state: BeamMemoryState, id: string, timestamp: string): void {
	state.db
		.prepare("INSERT INTO working_memory (id, content, source, timestamp, session_id) VALUES (?, ?, 'test', ?, ?)")
		.run(id, `content of ${id}`, timestamp, SESSION);
}

/** A recovered row: a rowid, content, this session, and the timestamp `.recover` left (none by default). */
function addRecoveredRow(state: BeamMemoryState, rowid: number | string, timestamp: string | null = null): void {
	state.db.run(`INSERT INTO working_memory (rowid, content, timestamp, session_id) VALUES (${rowid}, ?, ?, ?)`, [
		"an fts5 index page read back as a memory",
		timestamp,
		SESSION,
	]);
}

function ids(state: BeamMemoryState): (string | null)[] {
	return (state.db.query("SELECT id FROM working_memory ORDER BY rowid").all() as { id: string | null }[]).map(
		row => row.id,
	);
}

function count(state: BeamMemoryState): number {
	return (state.db.query("SELECT COUNT(*) AS n FROM working_memory").get() as { n: number }).n;
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

describe("working-memory trim with a row that has no id", () => {
	it("trims the oldest rows when every row has an id", () => {
		// The control: the overflow trim works, so a later failure is the damaged row and not the setup.
		const state = makeState(2);
		for (const id of ["wm-1", "wm-2", "wm-3"]) addMemory(state, id, hoursAgo(1));
		remember(state, "the write that runs the trim");
		expect(count(state)).toBe(2);
	});

	it("removes a row with no id that falls outside the newest N", () => {
		const state = makeState(2);
		for (const id of ["wm-1", "wm-2", "wm-3"]) addMemory(state, id, hoursAgo(1));
		addRecoveredRow(state, RECOVERED_ROWID);
		const kept = remember(state, "the write that runs the trim");
		// A row with no timestamp sorts outside the newest N, so the trim takes it with the oldest.
		expect(ids(state)).toEqual(["wm-3", kept]);
	});

	it("still trims the oldest rows when a row with no id is inside the newest N", () => {
		// By id, one such row in the keep set made the whole anti-join NULL, so this write trimmed
		// nothing and five rows stayed under a limit of two.
		const state = makeState(2);
		for (const id of ["wm-1", "wm-2", "wm-3"]) addMemory(state, id, hoursAgo(2));
		addRecoveredRow(state, RECOVERED_ROWID, hoursAgo(0));
		remember(state, "the write that runs the trim");
		expect(count(state)).toBe(2);
		expect(ids(state)).not.toContain("wm-1");
	});

	it("removes a row with no id once it is past the TTL", () => {
		const state = makeState(1000);
		addMemory(state, "wm-old", hoursAgo(72));
		addRecoveredRow(state, RECOVERED_ROWID, hoursAgo(72));
		const kept = remember(state, "the write that runs the trim");
		expect(ids(state)).toEqual([kept]);
	});

	it("removes a row whose rowid is past 2^53", () => {
		// The rowid is read and bound as decimal text; as a JS number this row's rowid would be 2^53.
		const state = makeState(1000);
		addRecoveredRow(state, HUGE_ROWID, hoursAgo(72));
		const kept = remember(state, "the write that runs the trim");
		expect(ids(state)).toEqual([kept]);
	});

	it("still purges the artifacts of the trimmed rows that have an id", () => {
		const state = makeState(1000);
		addMemory(state, "wm-old", hoursAgo(72));
		addRecoveredRow(state, RECOVERED_ROWID, hoursAgo(72));
		state.db
			.prepare("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test-model')")
			.run("wm-old", JSON.stringify([1, 0, 0, 0]));
		state.db
			.prepare("INSERT INTO annotations (memory_id, kind, value) VALUES (?, 'occurred_on', '2026-01-01')")
			.run("wm-old");
		remember(state, "the write that runs the trim");
		expect(state.db.query("SELECT 1 FROM memory_embeddings WHERE memory_id = 'wm-old'").get()).toBeNull();
		expect(state.db.query("SELECT 1 FROM annotations WHERE memory_id = 'wm-old'").get()).toBeNull();
	});
});
