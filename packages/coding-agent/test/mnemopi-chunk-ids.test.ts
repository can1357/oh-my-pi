import { beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { MnemopiBackendConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import type { AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TempDir } from "@oh-my-pi/pi-utils";

// Mnemopi is lazy-loaded at runtime; preload it for synchronous state construction.
await Promise.all([loadMnemopi(), loadMnemopiCore()]);

const TEST_SESSION_ID = "test-session-id";
let registeredMnemopiState: MnemopiSessionState | undefined;
let tempDbDir: ReturnType<typeof TempDir.createSync> | undefined;
let tempDbPath: string | undefined;

function makeMnemopiConfig(
	overrides: (Partial<MnemopiBackendConfig> & Record<string, unknown>) | undefined = {},
): MnemopiBackendConfig {
	if (!tempDbPath) {
		tempDbDir = TempDir.createSync(`@mnemopi-test-${Date.now()}-`);
		tempDbPath = tempDbDir.join("mnemopi.db");
	}
	return {
		dbPath: tempDbPath,
		bank: "test-bank",
		autoRecall: true,
		autoRetain: true,
		polyphonicRecall: false,
		enhancedRecall: false,
		proactiveLinking: false,
		retainEveryNTurns: 3,
		retentionChunkMaxChars: 0,
		consolidateEveryNTurns: 0,
		recallLimit: 10,
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		injectionTokenLimit: 1024,
		debug: false,
		recallLengthNormalization: "none",
		recallScoreFloor: 0,
		providerOptions: {
			noEmbeddings: true,
			embeddingModel: undefined,
			embeddingApiUrl: undefined,
			embeddingApiKey: undefined,
			llm: false,
		},
		llmMode: "none",
		llmBaseUrl: undefined,
		llmApiKey: undefined,
		llmModel: undefined,
		...overrides,
	};
}

interface RegisterMnemopiStateOptions {
	cwd?: string;
	sessionId?: string;
	entries?: () => unknown[];
	listeners?: Set<AgentSessionEventListener>;
}

function registerMnemopiState(
	config?: MnemopiBackendConfig,
	options: RegisterMnemopiStateOptions = {},
): MnemopiSessionState {
	const finalConfig = config ?? makeMnemopiConfig();
	const sessionId = options.sessionId ?? TEST_SESSION_ID;
	registeredMnemopiState = new MnemopiSessionState({
		sessionId,
		config: finalConfig,
		session: {
			sessionId,
			settings: Settings.isolated({
				"memory.backend": "mnemopi",
				"mnemopi.noEmbeddings": true,
				"mnemopi.llmMode": "none",
			}),
			modelRegistry: {
				getApiKeyForProvider: async () => undefined,
				resolver: () => async () => undefined,
			} as never,
			sessionManager: {
				getEntries: options.entries ?? (() => []),
				getCwd: () => options.cwd ?? "/tmp",
			} as never,
			emitNotice: () => {},
			getHindsightSessionState: () => undefined,
			subscribe: (listener: AgentSessionEventListener) => {
				options.listeners?.add(listener);
				return () => options.listeners?.delete(listener);
			},
		} as never,
	});
	setMnemopiSessionState(registeredMnemopiState.session as never, registeredMnemopiState);
	return registeredMnemopiState;
}

/**
 * Regression: retention chunking wrote every chunk of one oversized message through
 * `rememberInScope` without an explicit id. The store dedupes by CONTENT, so two byte-identical
 * chunks (a long repeated payload) collapsed into a single row that kept only the FIRST chunk's
 * ranges -- the repeat was silently lost and exact reconstruction became impossible.
 *
 * This drives the real retention entry point and inspects the rows that actually land, so it fails
 * if `state.ts` stops supplying ids -- which a test of the id-derivation helper alone could not
 * detect.
 */
describe("retention chunking supplies per-chunk memory ids", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	it("stores byte-identical chunks of one message as separate rows", async () => {
		// One oversized message whose chunks come out byte-identical. A uniform payload guarantees
		// that whatever the split offsets are: a multi-character unit only yields identical chunks
		// when the boundaries happen to land in phase with it, which would make this test vacuous.
		const state = registerMnemopiState(makeMnemopiConfig({ retentionChunkMaxChars: 500, bank: "chunk-ids-bank" }), {
			// Own session and bank: the temp database is shared across tests in this file, the retained
			// turn cursor is per session, and rows carry their bank in working_memory.session_id.
			sessionId: "chunk-ids-session",
			cwd: "/work/chunk-ids",
			entries: () => [{ type: "message", message: { role: "user", content: "x".repeat(3000) } }],
		});

		await state.forceRetainCurrentSession();

		const rows = state.memory.beam.db
			.prepare(`
				SELECT id, content, metadata_json
				FROM working_memory
				WHERE json_extract(metadata_json, '$.chunk_index') IS NOT NULL
				  AND session_id = 'chunk-ids-bank'
				ORDER BY json_extract(metadata_json, '$.chunk_index')
			`)
			.all() as { id: string; content: string; metadata_json: string }[];

		// The message is oversized, so it must have produced several chunk rows. Before the fix the
		// identical ones collapsed and this count came up short.
		expect(rows.length).toBeGreaterThan(1);
		expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);

		// The point of the fix: chunks sharing identical text still occupy distinct rows...
		const byContent = new Map<string, number>();
		for (const row of rows) byContent.set(row.content, (byContent.get(row.content) ?? 0) + 1);
		expect(Math.max(...byContent.values())).toBeGreaterThan(1);

		// ...and each row kept its OWN ranges, which is what reconstruction slices by.
		const ranges = rows.map(row => JSON.stringify(JSON.parse(row.metadata_json).ranges));
		expect(new Set(ranges).size).toBe(rows.length);

		await state.dispose({ consolidate: false });
	});
});

/**
 * Regression: chunk boundaries are computed on framed length, so a recalled `<memories>` block can
 * straddle one whenever the surrounding text alone exceeds `retentionChunkMaxChars`. Neither half
 * then matches the tag regexes, `prepareRetentionTranscript()` cannot strip them, and the recalled
 * memories get persisted -- the recall->retain feedback loop the stripping exists to prevent.
 */
describe("retention chunking never persists recalled memory blocks", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	it("strips a <memories> block that would straddle a chunk boundary", async () => {
		const secret = "RECALLED-MEMORY-CANARY";
		// Offsets chosen so a chunk boundary lands inside the block but AFTER the canary, so the
		// canary survives intact in one chunk. Two subtleties make an arbitrary payload useless
		// here: a block that happens to sit wholly inside one chunk is stripped correctly and the
		// test passes without the fix, and a boundary that cuts through the canary itself leaves no
		// contiguous copy of it, so only the tag assertions can ever fail.
		const content = `${"a".repeat(191)}<memories>\n- ${secret}\n- ${"c".repeat(120)}\n</memories>${"b".repeat(600)}`;
		const state = registerMnemopiState(makeMnemopiConfig({ retentionChunkMaxChars: 300, bank: "chunk-leak-bank" }), {
			sessionId: "chunk-leak-session",
			cwd: "/work/chunk-leak",
			entries: () => [{ type: "message", message: { role: "user", content } }],
		});

		await state.forceRetainCurrentSession();

		// embed_text is derived from the chunk's RANGES, sliced out of the source array. It is
		// included here because misaligned ranges -- offsets computed on sanitized content but
		// applied to raw messages -- would slice a torn tag straight into it.
		const rows = state.memory.beam.db
			.prepare(
				"SELECT content, COALESCE(embed_text, '') AS embed_text FROM working_memory WHERE session_id = 'chunk-leak-bank'",
			)
			.all() as { content: string; embed_text: string }[];
		expect(rows.length).toBeGreaterThan(1);
		// No fragment of the recalled block survives anywhere: not the payload, and not a torn tag.
		const stored = rows.map(row => `${row.content}\n${row.embed_text}`).join("\n");
		expect(stored).not.toContain(secret);
		expect(stored).not.toContain("<memories>");
		expect(stored).not.toContain("</memories>");
		// The surrounding conversation is still retained -- stripping must not eat the turn.
		expect(stored).toContain("aaaa");
		expect(stored).toContain("bbbb");

		await state.dispose({ consolidate: false });
	});
});

/**
 * Regression: chunk ids must not depend on the caller's `sourceId`. `maybeRetainOnAgentEnd` builds
 * that from `Date.now()`, so keying chunk identity on it gave the same chunk a fresh id on every
 * pass; after a cursor reset (`setSessionId`) the replay then INSERTED duplicate rows -- with
 * duplicate facts, annotations and embeddings -- where content dedupe used to collapse them.
 */
describe("retention chunk ids are stable across passes", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	it("reuses the same rows when the same chunks arrive under a different sourceId", async () => {
		// `maybeRetainOnAgentEnd` passes `${sessionId}-${Date.now()}`, so consecutive passes present
		// the SAME chunks under different sourceIds. Driving retainMessages directly reproduces that
		// without depending on wall-clock timing.
		const config = makeMnemopiConfig({ retentionChunkMaxChars: 500, bank: "chunk-replay-bank" });
		const state = registerMnemopiState(config, { sessionId: "chunk-replay-session", cwd: "/work/replay" });
		const messages = [{ role: "user", content: "y".repeat(3000) }];
		const count = () =>
			(
				state.memory.beam.db
					.prepare("SELECT COUNT(*) AS n FROM working_memory WHERE session_id = 'chunk-replay-bank'")
					.get() as { n: number }
			).n;

		await state.retainMessages(messages, "session-1756300000000", { retainedThroughUserTurn: 1 });
		const first = count();
		expect(first).toBeGreaterThan(1);

		await state.retainMessages(messages, "session-1756300009999", { retainedThroughUserTurn: 1 });
		expect(count()).toBe(first);

		await state.dispose({ consolidate: false });
	});
});

/**
 * Regression: the per-chunk crash-safe cursor must be computed in ONE turn space. Sanitizing inside
 * retainMessages() while `userTurns` and sliceUnretainedMessages() still counted the raw array
 * subtracted a sanitized batch total from a raw cumulative count, so every non-final chunk's cursor
 * was inflated by each dropped user turn after it. A chunk holding the first ~276 chars of a turn
 * then claimed that whole turn was retained, and a crash mid-loop left the remainder permanently
 * unretained: the restored cursor skipped past it.
 */
describe("retention cursor stays in one turn space", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	it("does not mark a partially stored turn as retained when a later turn is dropped", async () => {
		// The trailing user turn is nothing but a recalled memory block, so sanitization drops it.
		const state = registerMnemopiState(
			makeMnemopiConfig({ retentionChunkMaxChars: 300, bank: "chunk-cursor-bank" }),
			{
				sessionId: "chunk-cursor-session",
				cwd: "/work/cursor",
				entries: () => [
					{ type: "message", message: { role: "user", content: "q".repeat(900) } },
					{ type: "message", message: { role: "assistant", content: "an answer that is long enough to keep" } },
					{ type: "message", message: { role: "user", content: "<memories>\n- recalled thing\n</memories>" } },
				],
			},
		);

		await state.forceRetainCurrentSession();

		const rows = state.memory.beam.db
			.prepare(`
				SELECT json_extract(metadata_json, '$.chunk_index') AS idx,
				       json_extract(metadata_json, '$.retained_through_user_turn') AS cursor
				FROM working_memory
				WHERE session_id = 'chunk-cursor-bank'
				  AND json_extract(metadata_json, '$.chunk_index') IS NOT NULL
				ORDER BY idx
			`)
			.all() as { idx: number; cursor: number }[];

		expect(rows.length).toBeGreaterThan(1);
		// Only the LAST chunk may report the turn as fully retained.
		for (const row of rows.slice(0, -1)) expect(row.cursor).toBe(0);
		expect(rows.at(-1)?.cursor).toBe(1);

		await state.dispose({ consolidate: false });
	});
});

/**
 * Regression: `chunkIndex` restarts at 0 on every `retainMessages()` call, so keying chunk identity
 * on session + index alone made two DIFFERENT batches collide whenever the same text recurred at the
 * same batch-local index -- and because an explicit id bypasses content dedupe, the later batch took
 * the update path and quietly replaced the earlier occurrence's ranges. The id therefore also
 * carries the batch's start cursor: stable when a window is replayed, distinct between batches.
 *
 * The start cursor rather than the end cursor because it identifies the batch's SPAN rather than its
 * endpoint. On the production call paths the two are equivalent -- two batches share an end cursor
 * only when no new user turn arrived between them, which means either a replay (where colliding is
 * the point) or an assistant-only batch, whose framing differs so its text cannot collide -- so this
 * test deliberately does not claim to distinguish them.
 */
describe("retention chunk ids separate batches but not replays", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	it("keeps two batches of identical text apart and stays idempotent on replay", async () => {
		const config = makeMnemopiConfig({ retentionChunkMaxChars: 500, bank: "chunk-batch-bank" });
		const state = registerMnemopiState(config, { sessionId: "chunk-batch-session", cwd: "/work/batch" });
		const messages = [{ role: "user", content: "z".repeat(3000) }];
		const count = () =>
			(
				state.memory.beam.db
					.prepare("SELECT COUNT(*) AS n FROM working_memory WHERE session_id = 'chunk-batch-bank'")
					.get() as { n: number }
			).n;

		// Batch 1 covers up to turn 1.
		await state.retainMessages(messages, "session-1756300000000", { retainedThroughUserTurn: 1 });
		const afterFirst = count();
		expect(afterFirst).toBeGreaterThan(1);

		// Batch 2 is a LATER window that happens to hold identical text: distinct rows.
		await state.retainMessages(messages, "session-1756300001111", { retainedThroughUserTurn: 2 });
		expect(count()).toBe(afterFirst * 2);

		// Replaying either batch under a fresh volatile sourceId adds nothing.
		await state.retainMessages(messages, "session-1756300002222", { retainedThroughUserTurn: 1 });
		await state.retainMessages(messages, "session-1756300003333", { retainedThroughUserTurn: 2 });
		expect(count()).toBe(afterFirst * 2);

		await state.dispose({ consolidate: false });
	});
});

/**
 * Regression: a chunk's identity must not depend on how a retention pass was SLICED. Keying on the
 * batch-global `chunkIndex` meant retaining turns 1 and 2 in separate passes and then replaying both
 * in one pass gave turn 2 a different id (index 0 alone vs index 1 in the merged pass), so the
 * replay inserted a duplicate. The locator is the chunk's global turn number plus its ordinal within
 * that turn, which is identical however the same turns are batched.
 */
describe("retention chunk ids survive re-partitioning", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	it("adds nothing when incrementally retained turns are replayed as one window", async () => {
		const config = makeMnemopiConfig({ retentionChunkMaxChars: 900, bank: "chunk-partition-bank" });
		const state = registerMnemopiState(config, { sessionId: "chunk-partition-session", cwd: "/work/partition" });
		const turn1 = { role: "user", content: `first turn ${"a".repeat(400)}` };
		const turn2 = { role: "user", content: `second turn ${"b".repeat(400)}` };
		const count = () =>
			(
				state.memory.beam.db
					.prepare("SELECT COUNT(*) AS n FROM working_memory WHERE session_id = 'chunk-partition-bank'")
					.get() as { n: number }
			).n;

		// Retained one turn at a time, as periodic retention does.
		await state.retainMessages([turn1], "session-1756300000000", { retainedThroughUserTurn: 1 });
		await state.retainMessages([turn2], "session-1756300001111", { retainedThroughUserTurn: 2 });
		const afterIncremental = count();
		expect(afterIncremental).toBe(2);

		// Same turns, one pass -- a different partition of identical content.
		await state.retainMessages([turn1, turn2], "session-1756300002222", { retainedThroughUserTurn: 2 });
		expect(count()).toBe(afterIncremental);

		await state.dispose({ consolidate: false });
	});
});
