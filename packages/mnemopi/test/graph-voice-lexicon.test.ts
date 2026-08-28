import { afterEach, describe, expect, it } from "bun:test";
import { type BeamMemoryState, initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import { PolyphonicRecallEngine } from "@oh-my-pi/pi-mnemopi/core/polyphonic-recall";
import { closeQuietly, openDatabase } from "@oh-my-pi/pi-mnemopi/db";

function makeBeam(): BeamMemoryState {
	const db = openDatabase(":memory:", { create: true, readwrite: true });
	initBeam(db);
	return {
		db,
		sessionId: "test-session",
		authorId: null,
		authorType: null,
		channelId: "test-session",
		useCloud: false,
		pluginManager: null,
		annotations: null,
		triples: null,
		episodicGraph: null,
		veracityConsolidator: null,
		caches: { timestampParse: new Map(), extractionBuffer: [] },
		config: {
			workingMemoryLimit: 1000,
			workingMemoryTtlHours: 24,
			recencyHalflifeHours: 72,
			vecWeight: 0.5,
			ftsWeight: 0.3,
			importanceWeight: 0.2,
			useCloud: false,
			localLlmEnabled: false,
			maxEpisodeChars: 100_000,
		},
	};
}

function insertFact(beam: BeamMemoryState, factId: string, subject: string, object: string): void {
	beam.db.run(
		`INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, source_msg_id, confidence)
			VALUES (?, ?, ?, 'is', ?, ?, 'lm1', 0.8)`,
		[factId, beam.sessionId, subject, object, new Date().toISOString()],
	);
}

/**
 * Every scenario shares one bank shape so the lexicon-on and lexicon-off runs differ only in
 * the environment. `Everything` is deliberately BOTH a `facts.subject` and a gist participant
 * (a real single-word entity that happens to be a common word — the Windows search tool);
 * `People`/`Something` appear only as gist participants, i.e. uncorroborated.
 */
function seedLexiconFixture(beam: BeamMemoryState): PolyphonicRecallEngine {
	const engine = new PolyphonicRecallEngine({ db: beam.db, sessionId: beam.sessionId, channelId: beam.channelId });
	insertFact(beam, "f_everything", "Everything", "indexes the whole filesystem");
	insertFact(beam, "f_kitty", "Kitty", "renders images over APC");
	// Writer placeholders, which must stay out of the dictionary under every env.
	insertFact(beam, "f_placeholder", "fact", "a flat statement stored with a placeholder subject");
	const participants = [
		// (a) single common English words that survive `ENTITY_EXTRACTION_STOP_WORDS` and are
		// NOT in the measured `COMMON_SENTENCE_WORDS` backstop.
		"People",
		"Something",
		// (b) multi-word participants: one real entity plus one built purely from lexicon
		// words, to prove the multi-word bypass is not narrowed to "looks like an entity".
		"Kitty APC graphics upload",
		"Something People",
		// (c) corroborated by `facts.subject`.
		"Everything",
		// (d) a member of the measured backstop, which must be dropped even when the
		// lexicon is switched off.
		"Visual",
		// (e) writer placeholders arriving through the gist path.
		"Version",
		"Entities",
	];
	beam.db.run(
		`INSERT INTO gists (id, text, timestamp, participants_json, memory_id)
			VALUES ('gist_lm1', 'lexicon fixture gist', ?, ?, 'lm1')`,
		[new Date().toISOString(), JSON.stringify(participants)],
	);
	return engine;
}

function dictionaryOf(engine: PolyphonicRecallEngine): string[] {
	return engine.subjectDictionary().map(entry => entry.toLowerCase());
}

const previousLexicon = process.env.MNEMOPI_GRAPH_LEXICON;

afterEach(() => {
	if (previousLexicon === undefined) delete process.env.MNEMOPI_GRAPH_LEXICON;
	else process.env.MNEMOPI_GRAPH_LEXICON = previousLexicon;
});

describe("graph-voice common-word lexicon", () => {
	it("excludes uncorroborated single-word common participants when the lexicon is active", () => {
		const beam = makeBeam();
		try {
			const dictionary = dictionaryOf(seedLexiconFixture(beam));
			// Neither word is in the measured 13, so only the curated lexicon can remove them.
			expect(dictionary).not.toContain("people");
			expect(dictionary).not.toContain("something");
			// Real entities are untouched.
			expect(dictionary).toContain("kitty");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("never filters multi-word participants, even ones made only of common words", () => {
		const beam = makeBeam();
		try {
			const dictionary = dictionaryOf(seedLexiconFixture(beam));
			expect(dictionary).toContain("kitty apc graphics upload");
			expect(dictionary).toContain("something people");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("never filters a single-word participant corroborated by a facts.subject", () => {
		const beam = makeBeam();
		try {
			const dictionary = dictionaryOf(seedLexiconFixture(beam));
			expect(dictionary).toContain("everything");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("keeps junk common words out of the graph voice's seed matches", () => {
		const beam = makeBeam();
		try {
			const engine = seedLexiconFixture(beam);
			expect(engine.matchStoredSubjects("what do people think about something?")).toEqual([]);
			// The same query shape still reaches a real entity.
			expect(engine.matchStoredSubjects("does kitty do something for people?")).toEqual(["Kitty"]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("bypasses the lexicon under MNEMOPI_GRAPH_LEXICON=0 and keeps only the measured backstop", () => {
		process.env.MNEMOPI_GRAPH_LEXICON = "0";
		const beam = makeBeam();
		try {
			const dictionary = dictionaryOf(seedLexiconFixture(beam));
			// Kill switch off => the curated lexicon does not apply.
			expect(dictionary).toContain("people");
			expect(dictionary).toContain("something");
			// The measured 13-word backstop is always on.
			expect(dictionary).not.toContain("visual");
			// The bypass guards are unchanged by the kill switch.
			expect(dictionary).toContain("something people");
			expect(dictionary).toContain("everything");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("rejects writer placeholders regardless of the lexicon kill switch", () => {
		for (const value of ["1", "0"]) {
			process.env.MNEMOPI_GRAPH_LEXICON = value;
			const beam = makeBeam();
			try {
				const dictionary = dictionaryOf(seedLexiconFixture(beam));
				expect(dictionary).not.toContain("fact");
				expect(dictionary).not.toContain("version");
				expect(dictionary).not.toContain("entities");
			} finally {
				closeQuietly(beam.db);
			}
		}
	});
});
