import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, getFileOffset, initDb } from "@oh-my-pi/omp-stats/db";
import { getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-reply-links-");

const timestamp = "2026-11-10T12:00:00.000Z";

function user(id: string, parentId: string | null): object {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content: "why is this still broken" } };
}

function assistant(id: string, parentId: string): object {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
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

function lines(entries: object[]): string {
	return entries.map(entry => `${JSON.stringify(entry)}\n`).join("");
}

async function writeSession(name: string, entries: object[]): Promise<string> {
	const file = path.join(getSessionsDir(), "--tmp--reply-links", `${name}.jsonl`);
	await Bun.write(file, lines(entries));
	return file;
}

function models(): Record<string, string | null> {
	const database = new Database(getStatsDbPath(), { readonly: true });
	try {
		const rows = database.query("SELECT entry_id, model FROM user_messages ORDER BY entry_id").all() as {
			entry_id: string;
			model: string | null;
		}[];
		return Object.fromEntries(rows.map(row => [row.entry_id, row.model]));
	} finally {
		database.close();
	}
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
});
