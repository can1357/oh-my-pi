import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, getFileOffset, initDb, setFileOffset } from "@oh-my-pi/omp-stats/db";
import { getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-reply-links-");

const timestamp = "2026-11-10T12:00:00.000Z";

function user(id: string, parentId: string | null): object {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content: "why is this still broken" } };
}

function assistant(id: string, parentId: string, model = "gpt-5.4", provider = "openai"): object {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider,
			model,
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		},
	};
}

/** The entries the agent writes between a user message and its reply. */
function digest(id: string, parentId: string): object {
	return { type: "custom", id, parentId, timestamp, customType: "system-prompt-digest", data: {} };
}

function notice(id: string, parentId: string): object {
	return {
		type: "custom_message",
		id,
		parentId,
		timestamp,
		customType: "fleet-moment",
		content: "load is fine",
		display: false,
	};
}

/** Entries that start a new request below a user message: an invoked skill and a `/clear`. */
function skill(id: string, parentId: string): object {
	return {
		type: "custom_message",
		id,
		parentId,
		timestamp,
		customType: "skill-prompt",
		content: "run the skill",
		display: true,
		attribution: "user",
	};
}

function reset(id: string, parentId: string): object {
	return { type: "reset_boundary", id, parentId, timestamp };
}

function bash(id: string, parentId: string): object {
	return { type: "message", id, parentId, timestamp, message: { role: "bashExecution", command: "ls", output: "" } };
}

function toolResult(id: string, parentId: string): object {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [], isError: false },
	};
}

/** The marker coding-agent's `discardEntryDurably()` appends under a failed turn's parent; the turn stays in the file. */
function discard(id: string, parentId: string, discardedEntryId: string): object {
	return {
		type: "branch_summary",
		id,
		parentId,
		timestamp,
		fromId: parentId,
		summary: "",
		details: { kind: "discarded-entry-branch", discardedEntryId },
	};
}

/** A `service_tier_change` copy the discard appends after its marker. */
function tier(id: string, parentId: string): object {
	return { type: "service_tier_change", id, parentId, timestamp, serviceTier: null };
}

function lines(entries: object[]): string {
	return entries.map(entry => `${JSON.stringify(entry)}\n`).join("");
}

async function writeSession(name: string, entries: object[]): Promise<string> {
	const file = path.join(getSessionsDir(), "--tmp--reply-links", `${name}.jsonl`);
	await Bun.write(file, lines(entries));
	return file;
}

/** The rows `sql` selects from the stats database, through a read-only connection of its own. */
function selectRows<Row>(sql: string): Row[] {
	const database = new Database(getStatsDbPath(), { readonly: true });
	try {
		return database.query(sql).all() as Row[];
	} finally {
		database.close();
	}
}

/** The responding model of each user message, or with `"messages"` the model of each request row. */
function models(table: "user_messages" | "messages" = "user_messages"): Record<string, string | null> {
	const rows = selectRows<{ entry_id: string; model: string | null }>(
		`SELECT entry_id, model FROM ${table} ORDER BY entry_id`,
	);
	return Object.fromEntries(rows.map(row => [row.entry_id, row.model]));
}

/** The responding model and provider of each user message. */
function credits(): Record<string, { model: string | null; provider: string | null }> {
	const rows = selectRows<{ entry_id: string; model: string | null; provider: string | null }>(
		"SELECT entry_id, model, provider FROM user_messages ORDER BY entry_id",
	);
	return Object.fromEntries(rows.map(row => [row.entry_id, { model: row.model, provider: row.provider }]));
}

/**
 * Rewrite `file`'s cursor as a stats reader before reply versions persisted it at the same offset: without
 * `replyVersion` and `replyLink`, awaiting `pendingReplies`. That reader never retracted a discarded reply's link.
 */
function writeEarlierCursor(file: string, pendingReplies: Record<string, string>): void {
	const stored = getFileOffset(file);
	if (!stored?.parserState) throw new Error(`${file} has no cursor`);
	const state = { ...stored.parserState, pendingReplies };
	delete state.replyLink;
	delete state.replyVersion;
	setFileOffset(file, stored.offset, stored.lastModified, state);
}

describe("user message reply links", () => {
	it("links a reply written behind non-message entries, but not past another branch or request", async () => {
		await writeSession("session", [
			user("u1", null),
			notice("n1", "u1"),
			digest("d1", "n1"),
			assistant("a1", "d1"),
			// u2 is abandoned: the next reply continues the branch at a1.
			user("u2", "a1"),
			digest("d2", "u2"),
			assistant("a2", "a1"),
			// A message on a sibling branch leaves u3's reply to link.
			user("u3", "a2"),
			bash("b3", "u3"),
			assistant("a3", "u3"),
			// The reply below an invoked skill or a `/clear` answers that request, not u4 or u5.
			user("u4", "a3"),
			skill("s4", "u4"),
			assistant("a4", "s4"),
			user("u5", "a4"),
			reset("r5", "u5"),
			assistant("a5", "r5"),
		]);
		await syncAllSessions({ workers: 1 });

		expect(models()).toEqual({ u1: "gpt-5.4", u2: null, u3: "gpt-5.4", u4: null, u5: null });
	});

	it("links a reply that a later sync pass reads, also from a cursor written before replies were tracked", async () => {
		const file = await writeSession("session", [user("u1", null), digest("d1", "u1")]);
		const legacy = await writeSession("legacy", [user("u2", null)]);
		await syncAllSessions({ workers: 1 });
		expect(models()).toEqual({ u1: null, u2: null });
		expect(getFileOffset(file)?.parserState?.pendingReplies).toEqual({ u1: "u1", d1: "u1" });
		closeDb();

		const database = new Database(getStatsDbPath());
		database.run(
			"UPDATE file_offsets SET parser_state = json_remove(parser_state, '$.pendingReplies') WHERE session_file = ?",
			[legacy],
		);
		database.close();
		await fs.appendFile(file, lines([assistant("a1", "d1")]));
		await fs.appendFile(legacy, lines([assistant("a2", "u2")]));
		await syncAllSessions({ workers: 1 });

		expect(models()).toEqual({ u1: "gpt-5.4", u2: "gpt-5.4" });
		expect(getFileOffset(file)?.parserState?.pendingReplies).toEqual({});
	});

	it("re-links stored rows once by re-parsing only the sessions holding unlinked messages", async () => {
		// u3 never gets a reply, so its row stays unlinked after the re-link.
		const unlinked = await writeSession("unlinked", [
			user("u1", null),
			digest("d1", "u1"),
			assistant("a1", "d1"),
			user("u3", "a1"),
		]);
		const linked = await writeSession("linked", [user("u2", null), assistant("a2", "u2")]);
		await syncAllSessions({ workers: 1 });
		closeDb();

		// A database written by the parent-only rule: the reply behind the digest left u1 unlinked.
		const database = new Database(getStatsDbPath());
		database.run("UPDATE user_messages SET model = NULL, provider = NULL WHERE entry_id = 'u1'");
		database.run("DELETE FROM meta WHERE key = 'user_message_links_v2'");
		database.close();

		await initDb();
		expect(getFileOffset(unlinked)).toBeNull();
		expect(getFileOffset(linked)).not.toBeNull();

		await syncAllSessions({ workers: 1 });
		expect(models()).toEqual({ u1: "gpt-5.4", u2: "gpt-5.4", u3: null });
		closeDb();

		await initDb();
		expect(getFileOffset(unlinked)).not.toBeNull();
	});

	// If this regresses, a prompt whose failed reply the session discarded and kept off the branch is credited to the
	// failed model instead of the model whose retry answered it.
	it("credits a prompt to the retry after a discarded reply, keeping the discarded call's request", async () => {
		await writeSession("session", [
			user("u1", null),
			digest("d1", "u1"),
			assistant("a1", "d1", "failed-model"),
			discard("m1", "d1", "a1"),
			// The retry fails too; its discard copies a tier change after the marker.
			assistant("a2", "m1", "failed-model"),
			discard("m2", "m1", "a2"),
			tier("t2", "m2"),
			assistant("a3", "t2", "retry-model"),
			// A marker naming a turn that answered no prompt leaves the prompt's reply in place.
			user("u2", "a3"),
			assistant("a4", "u2"),
			toolResult("r4", "a4"),
			assistant("a5", "r4", "failed-model"),
			discard("m5", "r4", "a5"),
			assistant("a6", "m5", "retry-model"),
		]);
		await syncAllSessions({ workers: 1 });

		expect(models()).toEqual({ u1: "retry-model", u2: "gpt-5.4" });
		expect(models("messages")).toEqual({
			a1: "failed-model",
			a2: "failed-model",
			a3: "retry-model",
			a4: "gpt-5.4",
			a5: "failed-model",
			a6: "retry-model",
		});
	}, 15_000);

	// If this regresses, a prompt stored with its failed reply keeps crediting the failed model after a later sync pass
	// reads the discard marker and the retry.
	it("re-links a stored prompt when a later sync pass reads the discard of its reply", async () => {
		const retried = await writeSession("retried", [
			user("u1", null),
			digest("d1", "u1"),
			assistant("a1", "d1", "failed-model"),
		]);
		const pending = await writeSession("pending", [user("u2", null), assistant("a2", "u2", "failed-model")]);
		await syncAllSessions({ workers: 1 });
		expect(models()).toEqual({ u1: "failed-model", u2: "failed-model" });

		await fs.appendFile(retried, lines([discard("m1", "d1", "a1"), assistant("a3", "m1", "retry-model")]));
		// u2's retry is not written yet, so u2 awaits a reply again.
		await fs.appendFile(pending, lines([discard("m2", "u2", "a2")]));
		await syncAllSessions({ workers: 1 });
		expect(models()).toEqual({ u1: "retry-model", u2: null });

		await fs.appendFile(pending, lines([tier("t2", "m2"), assistant("a4", "t2", "retry-model")]));
		await syncAllSessions({ workers: 1 });
		expect(models()).toEqual({ u1: "retry-model", u2: "retry-model" });
		expect(models("messages")).toEqual({
			a1: "failed-model",
			a2: "failed-model",
			a3: "retry-model",
			a4: "retry-model",
		});
	}, 30_000);

	// If this regresses, an upgraded stats process resuming a cursor written before reply versions keeps crediting a
	// prompt to its discarded reply and leaves the retry that answered it unlinked.
	it("retracts a discarded reply when its marker follows the offset of an earlier reader's cursor", async () => {
		const file = await writeSession("session", [
			user("u1", null),
			digest("d1", "u1"),
			assistant("a1", "d1", "failed-model"),
		]);
		await syncAllSessions({ workers: 1 });
		expect(models()).toEqual({ u1: "failed-model" });
		expect(getFileOffset(file)?.parserState?.replyLink).toEqual({ reply: "a1", user: "u1" });

		writeEarlierCursor(file, {});

		await fs.appendFile(file, lines([discard("m1", "d1", "a1"), assistant("a2", "m1", "retry-model")]));
		await syncAllSessions({ workers: 1 });

		expect(models()).toEqual({ u1: "retry-model" });
		expect(models("messages")).toEqual({ a1: "failed-model", a2: "retry-model" });
		expect(getFileOffset(file)?.parserState).toMatchObject({
			replyLink: { reply: "a2", user: "u1" },
			replyVersion: 2,
		});
	}, 30_000);

	// If this regresses, a stats process started before the upgrade that synced past a discard marker leaves the prompt
	// crediting the discarded reply: the upgraded reader skips the unchanged file, or reads only the retry, whose link
	// the stored credit refuses.
	it("repairs the credit of a discarded reply when an earlier reader's cursor already passed the marker", async () => {
		const failed = { model: "failed-model", provider: "failed-provider" };
		const retry = { model: "retry-model", provider: "retry-provider" };
		const pending = await writeSession("pending", [
			user("u1", null),
			digest("d1", "u1"),
			assistant("a1", "d1", failed.model, failed.provider),
			discard("m1", "d1", "a1"),
		]);
		const retried = await writeSession("retried", [
			user("u2", null),
			digest("d2", "u2"),
			assistant("a3", "d2", failed.model, failed.provider),
			discard("m3", "d2", "a3"),
		]);
		await syncAllSessions({ workers: 1 });

		// What the earlier reader left: each prompt credits its failed reply, and the cursor past the marker awaits no
		// reply, because that reader linked the failed reply and ignored the marker.
		const database = await initDb();
		database.run("UPDATE user_messages SET model = ?, provider = ?", [failed.model, failed.provider]);
		// A pass that re-imported the transcript before the offset would bring these request rows back.
		database.run("DELETE FROM messages");
		for (const file of [pending, retried]) {
			writeEarlierCursor(file, {});
			expect(getFileOffset(file)?.parserState?.offset).toBe((await fs.stat(file)).size);
		}

		// u2's retry lands before the upgraded reader's first pass. u1's file is unchanged, so its marker alone clears
		// the credit.
		await fs.appendFile(retried, lines([assistant("a4", "m3", retry.model, retry.provider)]));
		await syncAllSessions({ workers: 1 });
		expect(credits()).toEqual({ u1: { model: null, provider: null }, u2: retry });

		await fs.appendFile(pending, lines([assistant("a2", "m1", retry.model, retry.provider)]));
		await syncAllSessions({ workers: 1 });
		expect(credits()).toEqual({ u1: retry, u2: retry });
		expect(models("messages")).toEqual({ a2: retry.model, a4: retry.model });
	}, 30_000);

	// If this regresses, a reconciliation replay that upgrades an earlier reader's cursor keeps the discarded reply's
	// credit, or a later replay clears the retry's credit: a replay applies only the links of uncredited prompts.
	it("repairs that credit in a reconciliation replay, and keeps the retry's credit in a later replay", async () => {
		const failed = { model: "failed-model", provider: "failed-provider" };
		const retry = { model: "retry-model", provider: "retry-provider" };
		const file = await writeSession("session", [
			user("u1", null),
			digest("d1", "u1"),
			assistant("a1", "d1", failed.model, failed.provider),
			discard("m1", "d1", "a1"),
		]);
		await syncAllSessions({ workers: 1 });
		const database = await initDb();
		database.run("UPDATE user_messages SET model = ?, provider = ?", [failed.model, failed.provider]);
		writeEarlierCursor(file, {});
		database.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('session_reconciliation', 'pending')");

		await syncAllSessions({ workers: 1 });
		expect(credits()).toEqual({ u1: { model: null, provider: null } });
		expect(getFileOffset(file)?.parserState?.replyVersion).toBe(2);

		await fs.appendFile(file, lines([assistant("a2", "m1", retry.model, retry.provider)]));
		await syncAllSessions({ workers: 1 });
		expect(credits()).toEqual({ u1: retry });

		(await initDb()).run("INSERT OR REPLACE INTO meta (key, value) VALUES ('session_reconciliation', 'pending')");
		await syncAllSessions({ workers: 1 });
		expect(credits()).toEqual({ u1: retry });
		expect(models("messages")).toEqual({ a1: failed.model, a2: retry.model });
	}, 30_000);
});
