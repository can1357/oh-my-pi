/**
 * Contracts for the `entry_patch` records a session's passes append (an elide pass's placeholders, a
 * retry saga's marker, a compaction's corrected `tokensAfter`): every stats reader reads an entry with
 * the fields a later record sets, exactly as it reads the session with those fields written inline (the
 * control), and no reader returns a record as an entry.
 */

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getRequestDetails, getSessionEntryDetail } from "@oh-my-pi/omp-stats/client/api";
import { closeDb, getRecentRequests, initDb } from "@oh-my-pi/omp-stats/db";
import { getSessionEntry, type ParseSessionResult, parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { handleApi } from "@oh-my-pi/omp-stats/server";
import { buildSessionTrace, getTraceEntry } from "@oh-my-pi/omp-stats/trace";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { SpotlightSessionBuilder } from "./helpers/spotlight-session";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-entry-patches-");

afterEach(() => {
	vi.restoreAllMocks();
});

const T = Date.parse("2026-11-20T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const PROMPT = `Summarize this log:\n${"a line of a long pasted log\n".repeat(80)}(end of log)`;
const PROMPT_ELIDED = "Summarize this log:\n[shaken ~500 tokens — recover: artifact://7 (region 1)]";
const REPLY = `Here is the file:\n\`\`\`\n${"export const a = 1;\n".repeat(200)}\`\`\``;
const REPLY_ELIDED = "Here is the file:\n[shaken ~800 tokens — recover: artifact://7 (region 2)]";
const OUTPUT = "x".repeat(4000);
const OUTPUT_ELIDED = "[shaken ~1000 tokens — recover: artifact://7 (region 3)]";
const RECOVERY = {
	kind: "auto-retry",
	status: "superseded",
	attempt: 1,
	recovery: "wait",
	note: "Retried after a rate limit",
};
const USAGE = {
	input: 1000,
	output: 200,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1200,
	cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 },
};

/** How a session holds the fields its passes set: in `entry_patch` records after the entries, or written inline. */
type Form = "patched" | "inline";
const FORMS: readonly Form[] = ["patched", "inline"];

/** Entry ids of one form's session; each form has its own, since stats counts an entry a fork copied once. */
function ids(form: Form) {
	return {
		user: `user-${form}`,
		reply: `reply-${form}`,
		call: `call-${form}`,
		result: `result-${form}`,
		compaction: `compaction-${form}`,
		elide: `elide-${form}`,
		recovery: `recovery-${form}`,
		done: `done-${form}`,
	};
}

function replyContent(form: Form, text: string): Record<string, unknown>[] {
	return [
		{ type: "text", text },
		{ type: "toolCall", id: ids(form).call, name: "write", arguments: { path: "src/a.ts", content: "x" } },
	];
}

/**
 * A session's lines: a user prompt, a reply with a tool call, its result, a snapcompact compaction, then
 * the final reply. Patched, an elide pass's record and a retry saga's record follow the compaction, and
 * the final reply names the last record as parent; inline, those fields are on the entries and the final
 * reply names the compaction.
 */
function sessionLines(form: Form): string[] {
	const id = ids(form);
	const inline = form === "inline";
	const entries: Record<string, unknown>[] = [
		{ type: "session", version: 3, id: `session-${form}`, timestamp: iso(T), cwd: "/repo" },
		{
			type: "message",
			id: id.user,
			parentId: null,
			timestamp: iso(T + 1000),
			message: { role: "user", content: inline ? PROMPT_ELIDED : PROMPT, timestamp: T + 1000 },
		},
		{
			type: "message",
			id: id.reply,
			parentId: id.user,
			timestamp: iso(T + 2000),
			message: {
				role: "assistant",
				content: replyContent(form, inline ? REPLY_ELIDED : REPLY),
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-4-5",
				stopReason: "toolUse",
				timestamp: T + 1500,
				duration: 500,
				usage: USAGE,
				...(inline ? { elidedOutputTokens: 800, retryRecovery: RECOVERY } : {}),
			},
		},
		{
			type: "message",
			id: id.result,
			parentId: id.reply,
			timestamp: iso(T + 3000),
			message: {
				role: "toolResult",
				toolCallId: id.call,
				toolName: "write",
				content: [{ type: "text", text: inline ? OUTPUT_ELIDED : OUTPUT }],
				isError: false,
				timestamp: T + 3000,
				...(inline ? { prunedAt: T + 5000 } : {}),
			},
		},
		{
			type: "compaction",
			id: id.compaction,
			parentId: id.result,
			timestamp: iso(T + 4000),
			summary: "## Goal\nsummarized",
			firstKeptEntryId: id.result,
			method: "snapcompact",
			tokensBefore: 100_000,
			tokensAfter: inline ? 20_000 : 80_000,
		},
	];
	if (!inline) {
		entries.push(
			{
				type: "custom",
				customType: "entry_patch",
				id: id.elide,
				parentId: id.compaction,
				timestamp: iso(T + 5000),
				data: {
					patches: [
						{ entryId: id.user, message: { content: PROMPT_ELIDED } },
						{
							entryId: id.reply,
							message: { content: replyContent(form, REPLY_ELIDED), elidedOutputTokens: 800 },
						},
						{
							entryId: id.result,
							message: { content: [{ type: "text", text: OUTPUT_ELIDED }], prunedAt: T + 5000 },
						},
					],
				},
			},
			{
				type: "custom",
				customType: "entry_patch",
				id: id.recovery,
				parentId: id.elide,
				timestamp: iso(T + 5500),
				data: {
					patches: [
						{ entryId: id.compaction, entry: { tokensAfter: 20_000 } },
						{ entryId: id.reply, message: { retryRecovery: RECOVERY } },
					],
				},
			},
		);
	}
	entries.push({
		type: "message",
		id: id.done,
		parentId: inline ? id.compaction : id.recovery,
		timestamp: iso(T + 6000),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Done." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-5",
			stopReason: "stop",
			timestamp: T + 6000,
			duration: 500,
			usage: USAGE,
		},
	});
	return entries.map(entry => JSON.stringify(entry));
}

function sessionPath(name: string): string {
	return path.join(getSessionsDir(), "--repo--", `${name}.jsonl`);
}

async function writeSession(form: Form): Promise<string> {
	const file = sessionPath(form);
	await Bun.write(file, `${sessionLines(form).join("\n")}\n`);
	return file;
}

/** `value` with the form in its ids replaced, so the two forms compare equal when they read the same. */
function sameIds<T>(value: T, form: Form): T {
	return JSON.parse(JSON.stringify(value).replaceAll(`-${form}`, "-x"));
}

/** Route the dashboard client's requests to the server's API handler. */
function serveApi(): void {
	const api = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) =>
			handleApi(new Request(`http://stats.test${input}`, init)),
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(api);
}

/** The rows a sync stored for `file` that its entries' patchable fields decide. */
async function storedRows(file: string) {
	const db = await initDb();
	const user = db.prepare("SELECT chars FROM user_messages WHERE session_file = ?").get(file) as {
		chars: number;
	} | null;
	const call = db.prepare("SELECT result_chars FROM tool_calls WHERE session_file = ?").get(file) as {
		result_chars: number;
	} | null;
	const compaction = db
		.prepare("SELECT tokens_after FROM snapcompact_compactions WHERE session_file = ?")
		.get(file) as { tokens_after: number } | null;
	return { userChars: user?.chars, resultChars: call?.result_chars, tokensAfter: compaction?.tokens_after };
}

/** The rows of a parse that its entries' patchable fields decide. */
function patchableRows(parsed: ParseSessionResult) {
	return {
		userChars: parsed.userStats.map(row => [row.entryId, row.chars]),
		callResultChars: parsed.toolCalls.map(row => [row.toolCallId, row.resultChars]),
		resultChars: parsed.toolResults.map(row => [row.toolCallId, row.resultChars]),
		tokensAfter: parsed.snapcompactCompactions.map(row => [row.entryId, row.tokensAfter]),
		requests: parsed.stats.map(row => row.entryId),
	};
}

/** {@link patchableRows} of a whole parse of `form`'s session: every row, with the fields the records set. */
function patchedRows(form: Form) {
	const id = ids(form);
	return {
		userChars: [[id.user, PROMPT_ELIDED.length]],
		callResultChars: [[id.call, OUTPUT_ELIDED.length]],
		resultChars: [[id.call, OUTPUT_ELIDED.length]],
		tokensAfter: [[id.compaction, 20_000]],
		requests: [id.reply, id.done],
	};
}

describe("a session whose passes appended entry_patch records reads as with those fields inline", () => {
	// `omp stats` would count the heavy content an elide pass removed, and the compaction size it corrected.
	it("parseSessionFile derives its rows from the fields the records set", async () => {
		for (const form of FORMS) {
			const parsed = await parseSessionFile(await writeSession(form));
			expect({ form, ...patchableRows(parsed) }).toEqual({ form, ...patchedRows(form) });
		}
	});

	// The database replaces a session's stored rows with the rows of a `reset` read: a tail read that met a record
	// for an entry before the tail and returned no rows would leave the session with none.
	it("a tail read that meets a record for an entry before the tail returns every row of the session, patched", async () => {
		const lines = sessionLines("patched");
		const firstRecord = lines.findIndex(line => line.includes('"entry_patch"'));
		const file = sessionPath("patched");
		await Bun.write(file, `${lines.slice(0, firstRecord).join("\n")}\n`);
		const first = await parseSessionFile(file);
		await fs.appendFile(file, `${lines.slice(firstRecord).join("\n")}\n`);
		const tail = await parseSessionFile(file, first.newOffset, first.parserState);
		expect({ reset: tail.reset, newOffset: tail.newOffset, ...patchableRows(tail) }).toEqual({
			reset: true,
			newOffset: (await fs.stat(file)).size,
			...patchedRows("patched"),
		});
	});

	// The live watcher's sync reads only the files that changed and settles no reconciliation, so it alone must
	// leave the patched rows stored.
	it("a sync of the changed file that meets a record after it stored its target's rows replaces those rows", async () => {
		const lines = sessionLines("patched");
		const firstRecord = lines.findIndex(line => line.includes('"entry_patch"'));
		const file = sessionPath("patched");
		await Bun.write(file, `${lines.slice(0, firstRecord).join("\n")}\n`);
		await syncAllSessions({ workers: 1 });
		expect(await storedRows(file)).toEqual({
			userChars: PROMPT.length,
			resultChars: OUTPUT.length,
			tokensAfter: 80_000,
		});

		await fs.appendFile(file, `${lines.slice(firstRecord).join("\n")}\n`);
		await syncAllSessions({ files: [file], workers: 1 });
		const expected = { userChars: PROMPT_ELIDED.length, resultChars: OUTPUT_ELIDED.length, tokensAfter: 20_000 };
		expect(await storedRows(file)).toEqual(expected);
		const inline = await writeSession("inline");
		await syncAllSessions({ workers: 1 });
		expect(await storedRows(inline)).toEqual(expected);
	}, 30_000);

	// A database an older build filled holds rows derived from an entry before a record set its fields.
	// The first open derives the rows of each file modified since records were first written again, once:
	// an older file, which holds no record, keeps its cursor and its rows, and a later open derives
	// nothing again.
	it("a database that stored rows before its records applied derives them again once, for the files modified since records were written", async () => {
		const file = await writeSession("patched");
		const old = await writeSession("inline");
		// Before the first build that wrote a record: no file this old holds one.
		const beforeRecords = new Date("2026-11-01T00:00:00Z");
		await fs.utimes(old, beforeRecords, beforeRecords);
		const setChars = (db: Database, sessionFile: string, chars: number) =>
			db.prepare("UPDATE user_messages SET chars = ? WHERE session_file = ?").run(chars, sessionFile);
		const stored = async () => {
			const db = await initDb();
			const charsOf = (sessionFile: string) =>
				db
					.query<{ chars: number }, [string]>("SELECT chars FROM user_messages WHERE session_file = ?")
					.get(sessionFile)?.chars;
			return { patched: charsOf(file), old: charsOf(old) };
		};
		try {
			await syncAllSessions({ workers: 1 });
			let db = await initDb();
			// As an older build left them: the patched file's row derived from the original prompt, past the
			// record; the older file's row a value no derive gives, which a derive of it would replace.
			setChars(db, file, PROMPT.length);
			setChars(db, old, -7);
			db.prepare("DELETE FROM meta WHERE key = 'entry_patch_v1'").run();
			closeDb();
			await syncAllSessions({ workers: 1 });
			expect(await stored()).toEqual({ patched: PROMPT_ELIDED.length, old: -7 });

			// A later open: a value no derive gives stays in each row.
			db = await initDb();
			setChars(db, file, -7);
			closeDb();
			const later = await syncAllSessions({ workers: 1 });
			expect({ later, stored: await stored() }).toEqual({
				later: { processed: 0, files: 0 },
				stored: { patched: -7, old: -7 },
			});
		} finally {
			closeDb();
		}
	}, 30_000);

	// When entries share an id, a record sets its fields on the last of them only, as `applyEntryPatches`
	// decides for the other readers of the file (the session loader, the trace, the Python tools). Setting
	// them on each would count the earlier entry as the record left only the later one.
	it("a record sets its fields on the last of the entries that share its target's id, in one read or two", async () => {
		const prompt = (timestamp: number) => ({
			type: "message",
			id: "dup-user",
			parentId: null,
			timestamp: iso(timestamp),
			message: { role: "user", content: PROMPT, timestamp },
		});
		const lines = [
			{ type: "session", version: 3, id: "dup-session", timestamp: iso(T), cwd: "/repo" },
			prompt(T + 1000),
			prompt(T + 2000),
			{
				type: "custom",
				customType: "entry_patch",
				id: "dup-elide",
				parentId: "dup-user",
				timestamp: iso(T + 3000),
				data: { patches: [{ entryId: "dup-user", message: { content: PROMPT_ELIDED } }] },
			},
		].map(entry => JSON.stringify(entry));
		const userChars = (parsed: ParseSessionResult) => parsed.userStats.map(row => [row.entryId, row.chars]);
		const expected = [
			["dup-user", PROMPT.length],
			["dup-user", PROMPT_ELIDED.length],
		];
		const file = sessionPath("duplicate-id");

		await Bun.write(file, `${lines.join("\n")}\n`);
		expect(userChars(await parseSessionFile(file))).toEqual(expected);
		// The span drawer finds the first entry with the id, which no record sets a field on.
		const first = await getSessionEntry(file, "dup-user");
		expect(first && "message" in first ? first.message : null).toMatchObject({ content: PROMPT });

		// The record in a later read: the read derives the whole session again, as one read does.
		await Bun.write(file, `${lines.slice(0, 3).join("\n")}\n`);
		const head = await parseSessionFile(file);
		await fs.appendFile(file, `${lines[3]}\n`);
		const tail = await parseSessionFile(file, head.newOffset, head.parserState);
		expect({ reset: tail.reset, users: userChars(tail) }).toEqual({ reset: true, users: expected });
	});

	// The duplicate-id fixture every reader of a session file reads (the session loader, the windowed viewers, the
	// native archive scanner, the Python sync): the record between the two entries sets its fields on the later.
	const DUPLICATE_ID_FIXTURE = path.join(
		import.meta.dir,
		"../../../crates/natives/fixtures/entry-patch-duplicate-id.json",
	);
	const jsonl = (entries: readonly object[]) => `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;

	it("reads the duplicate-id fixture every reader reads with the record's fields on the later entry", async () => {
		const { lines, reads }: { lines: object[]; reads: string[] } = await Bun.file(DUPLICATE_ID_FIXTURE).json();
		const file = sessionPath("duplicate-id-fixture");
		await Bun.write(file, jsonl(lines));
		const parsed = await parseSessionFile(file);
		expect(parsed.userStats.map(row => [row.entryId, row.chars])).toEqual(reads.map(text => ["u1", text.length]));
	});

	// The same fixture with the sync boundary between the record and the later entry. The first sync stores the earlier
	// entry with the record's fields, as the last entry with the id so far; once the later entry arrives the record
	// sets its fields on that one, so the second sync must store the earlier entry as written, as a whole-file sync does.
	it("a sync that reads a later entry with a patched id stores the entry an earlier sync patched as written", async () => {
		const { lines, reads }: { lines: object[]; reads: string[] } = await Bun.file(DUPLICATE_ID_FIXTURE).json();
		const file = sessionPath("duplicate-id-split");
		await Bun.write(file, jsonl(lines.slice(0, 3)));
		await syncAllSessions({ workers: 1 });
		const afterFirst = (await storedRows(file)).userChars;
		await fs.appendFile(file, jsonl(lines.slice(3)));
		await syncAllSessions({ files: [file], workers: 1 });
		const whole = await parseSessionFile(file);
		expect({
			afterFirst,
			stored: (await storedRows(file)).userChars,
			whole: whole.userStats.map(row => row.chars),
		}).toEqual({
			afterFirst: reads[1]?.length,
			// The table keeps one row per entry id, the first entry's.
			stored: reads[0]?.length,
			whole: reads.map(text => text.length),
		});
	}, 30_000);

	// A record may precede its target (entries another writer appended, a copy written out of order). A sync that
	// reads the record before its target must keep it: the next sync reads only the appended target, and would
	// store the content the record replaced, where a read of the whole file stores the record's.
	it("a sync that reads a record before its target keeps it, so the sync that reads the target stores the record's fields", async () => {
		const file = sessionPath("early-record");
		const head = `${[
			{ type: "session", version: 3, id: "early-session", timestamp: iso(T), cwd: "/repo" },
			{
				type: "custom",
				customType: "entry_patch",
				id: "early-elide",
				parentId: null,
				timestamp: iso(T + 1000),
				data: { patches: [{ entryId: "early-user", message: { content: PROMPT_ELIDED } }] },
			},
		]
			.map(entry => JSON.stringify(entry))
			.join("\n")}\n`;
		const target = {
			type: "message",
			id: "early-user",
			parentId: "early-elide",
			timestamp: iso(T + 2000),
			message: { role: "user", content: PROMPT, timestamp: T + 2000 },
		};
		// The first sync reads through the record; the second reads only the appended target.
		await Bun.write(file, head);
		await syncAllSessions({ workers: 1 });
		await fs.appendFile(file, `${JSON.stringify(target)}\n`);
		await syncAllSessions({ files: [file], workers: 1 });
		const whole = await parseSessionFile(file);
		expect({
			stored: (await storedRows(file)).userChars,
			whole: whole.userStats.map(row => row.chars),
		}).toEqual({ stored: PROMPT_ELIDED.length, whole: [PROMPT_ELIDED.length] });
	}, 30_000);

	// The trace timeline labels turns, model spans and compaction markers from these fields.
	it("the trace shows the fields the records set", async () => {
		const [patched, inline] = await Promise.all(
			FORMS.map(async form => {
				const trace = await buildSessionTrace(await writeSession(form));
				const [main] = trace.tracks;
				return sameIds(
					{
						markers: main.markers.map(marker => marker.label),
						turns: main.spans.filter(span => span.kind === "turn").map(span => span.label),
						models: main.spans.filter(span => span.kind === "model").map(span => span.detail),
					},
					form,
				);
			}),
		);
		expect(patched).toEqual({
			markers: ["compaction 100k→20k"],
			turns: [PROMPT_ELIDED.replace(/\s+/g, " ")],
			models: [REPLY_ELIDED.replace(/\s+/g, " "), "Done."],
		});
		expect(patched).toEqual(inline);
	}, 30_000);

	// The span drawer shows one entry whole: the elided output, not the original, and never a record.
	it("the span drawer reads an entry with the fields the records set, and no record", async () => {
		serveApi();
		for (const form of FORMS) {
			const id = ids(form);
			const file = await writeSession(form);
			const expected = { message: { content: [{ type: "text", text: OUTPUT_ELIDED }], prunedAt: T + 5000 } };
			const server = await getTraceEntry(file, id.result);
			const { entry: client } = await getSessionEntryDetail(file, id.result);
			expect({ form, server, client }).toMatchObject({ form, server: expected, client: expected });
		}
		const file = sessionPath("patched");
		expect(await getTraceEntry(file, ids("patched").elide)).toBeNull();
		await expect(getSessionEntryDetail(file, ids("patched").elide)).rejects.toThrow();
	}, 30_000);

	// The request drawer shows a request's output: the elided reply with its retry marker.
	it("the request drawer reads a request with the fields the records set, and no record", async () => {
		serveApi();
		const files = new Map<Form, string>();
		for (const form of FORMS) files.set(form, await writeSession(form));
		await syncAllSessions({ workers: 1 });
		await initDb();
		const expected = sameIds(
			{ content: replyContent("patched", REPLY_ELIDED), elidedOutputTokens: 800, retryRecovery: RECOVERY },
			"patched",
		);
		for (const form of FORMS) {
			const id = ids(form);
			const entry = await getSessionEntry(files.get(form) ?? "", id.reply);
			const row = getRecentRequests(10).find(request => request.entryId === id.reply);
			if (!row?.id) throw new Error(`no stored request for ${form}`);
			const details = await getRequestDetails(row.id);
			const read = { form, server: entry && "message" in entry ? entry.message : null, client: details.output };
			expect(sameIds(read, form)).toMatchObject({ form, server: expected, client: expected });
		}
		expect(await getSessionEntry(files.get("patched") ?? "", ids("patched").elide)).toBeNull();
	}, 30_000);

	// A read from an offset with no stored cursor rebuilds the Spotlight state from the prefix: a record there
	// that sets a write's target decides whether the write closed the earlier read of the file.
	it("the prefix scan of an offset-only read reads its entries with the fields the records set", async () => {
		for (const form of FORMS) {
			const b = new SpotlightSessionBuilder(T).header("/repo").marker();
			b.user("go");
			const [cut] = b.request({ cacheRead: 10_000, calls: [{ name: "read", args: { path: "src/a.ts:100-200" } }] });
			b.result(cut, {
				text: "100\tconst a = 1;\n… [120-178] (read artifact://0:21-79)\n179\tconst z = 2;",
				shape: {
					inTokens: 3000,
					outTokens: 1000,
					original: {
						url: "artifact://0",
						lines: 101,
						start: 100,
						path: "src/a.ts",
						kept: [
							[1, 20],
							[80, 101],
						],
					},
				},
			});
			const writeArgs = (file: string) => ({ path: file, content: "x" });
			// A write of src/a.ts stops the read of it; the record (any assistant content may be patched) names src/b.ts.
			const [write] = b.request({
				calls: [{ name: "write", args: writeArgs(form === "inline" ? "src/b.ts" : "src/a.ts") }],
			});
			b.result(write, { text: "ok" });
			const before = b.text();
			let prefix = before;
			if (form === "patched") {
				const entries = Bun.JSONL.parse(before) as { id: string; message?: { content?: unknown } }[];
				const reply = entries.find(
					entry =>
						Array.isArray(entry.message?.content) &&
						entry.message.content.some((block: { id?: string }) => block.id === write),
				);
				if (!reply) throw new Error("Expected the reply that made the write");
				prefix += `${JSON.stringify({
					type: "custom",
					customType: "entry_patch",
					id: `record-${form}`,
					parentId: reply.id,
					timestamp: iso(T + 60_000),
					data: {
						patches: [
							{
								entryId: reply.id,
								message: {
									content: [{ type: "toolCall", id: write, name: "write", arguments: writeArgs("src/b.ts") }],
								},
							},
						],
					},
				})}\n`;
			}
			const [reread] = b.request({ calls: [{ name: "read", args: { path: "src/a.ts:150-160" } }] });
			b.result(reread, { text: "150\tline" });
			const file = sessionPath(`prefix-${form}`);
			await Bun.write(file, prefix + b.text().slice(before.length));

			const parsed = await parseSessionFile(file, Buffer.byteLength(prefix));
			expect({ form, needs: parsed.spotlight.needs.map(row => [row.toolCallId, row.reread]) }).toEqual({
				form,
				needs: [[cut, [[51, 61]]]],
			});
		}
	});
});
