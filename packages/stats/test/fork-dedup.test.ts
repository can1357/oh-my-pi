import { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, getRecentRequests, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { getOverallStats } from "@oh-my-pi/omp-stats/rollup";
import * as parser from "@oh-my-pi/omp-stats/parser";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-fork-dedup-");

interface AssistantOptions {
	entryId: string;
	parentId?: string | null;
	timestamp: string;
}

function buildUserEntry(entryId: string, timestamp: string, content: string) {
	return {
		type: "message",
		id: entryId,
		parentId: null,
		timestamp,
		message: { role: "user", content },
	};
}

function buildAssistantEntry(opts: AssistantOptions) {
	return {
		type: "message",
		id: opts.entryId,
		parentId: opts.parentId ?? null,
		timestamp: opts.timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			responseId: `resp-${opts.entryId}`,
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
			},
			stopReason: "stop",
			timestamp: Date.parse(opts.timestamp),
			duration: 10,
			ttft: 5,
		},
	};
}

async function writeSessionFile(
	folderSlug: string,
	fileName: string,
	header: { id: string; cwd: string; parentSession?: string; inheritedThroughEntryId?: string },
	entries: unknown[],
): Promise<string> {
	const sessionDir = path.join(getSessionsDir(), folderSlug);
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, fileName);
	const headerEntry = {
		type: "session",
		version: 3,
		id: header.id,
		timestamp: new Date().toISOString(),
		cwd: header.cwd,
		...(header.parentSession ? { parentSession: header.parentSession } : {}),
		...(header.inheritedThroughEntryId ? { inheritedThroughEntryId: header.inheritedThroughEntryId } : {}),
	};
	const lines = [headerEntry, ...entries].map(entry => JSON.stringify(entry)).join("\n");
	await Bun.write(sessionFile, `${lines}\n`);
	return sessionFile;
}

/**
 * Writes a fork's session file born after its parent's, as a real fork always is. A full stats
 * sync ingests transcripts in creation order (birth time, `orderForIngest`), so the fork follows
 * its parent and the parent keeps the entries the fork copied. A filesystem that stamps files
 * from the kernel's coarse clock (ext4) gives two files written back to back one birth time, and
 * their order then falls to the order the directory lists them in, which ext4 takes from a hash
 * of their names. So the fork is written again until it is born after its parent.
 */
async function writeForkSessionFile(parentFile: string, ...args: Parameters<typeof writeSessionFile>): Promise<string> {
	const born = async (file: string) => {
		const stat = await fs.stat(file);
		return stat.birthtimeMs || stat.ctimeMs;
	};
	const parentBorn = await born(parentFile);
	const deadline = Date.now() + 5_000;
	for (;;) {
		const forkFile = await writeSessionFile(...args);
		if ((await born(forkFile)) > parentBorn) return forkFile;
		if (Date.now() > deadline) throw new Error("the fork's session file is never born after its parent's");
		await fs.rm(forkFile);
		// The file clock moves by a kernel tick (1 to 10 ms); no fake timer moves it.
		await Bun.sleep(1);
	}
}

/**
 * Writes a parent and its reset fork (`/tan` clone) that copied the parent's prompt, its call to `read`
 * and, with `approval`, that call's approval, then leaves the state an older build left when the fork
 * synced first: the fork owns the copied rows at its zeroed cost, both cursors are current, and the
 * upgrade's one-shot has not run. The database is closed, as before an upgrade.
 */
async function writeStaleResetFork(approval: boolean): Promise<{ parentFile: string; forkFile: string }> {
	const ts = new Date("2026-06-24T10:00:00.000Z").toISOString();
	const userEntry = buildUserEntry("user01ab", ts, "hello");
	const plainEntry = buildAssistantEntry({ entryId: "asst01ab", parentId: "user01ab", timestamp: ts });
	const toolCall = { type: "toolCall", id: "call01ab", name: "read", arguments: { path: "a.ts" } };
	const assistantEntry = {
		...plainEntry,
		message: { ...plainEntry.message, content: [...plainEntry.message.content, toolCall] },
	};
	const approvalEntry = {
		type: "custom",
		id: "appr01ab",
		parentId: "asst01ab",
		timestamp: ts,
		customType: "tool_approval_requested",
		data: { toolCallId: "call01ab", toolName: "read", requestedAt: ts },
	};
	const parentFile = await writeSessionFile(
		"--tmp--fork-dedup",
		"01_parent.jsonl",
		{ id: "parent00", cwd: "/tmp/project" },
		approval ? [userEntry, assistantEntry, approvalEntry] : [userEntry, assistantEntry],
	);
	const copied = structuredClone(assistantEntry);
	copied.message.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const copies = approval ? [userEntry, copied, approvalEntry] : [userEntry, copied];
	const lastCopy = copies[copies.length - 1].id;
	const ownTs = new Date("2026-06-24T10:05:00.000Z").toISOString();
	const forkFile = await writeSessionFile(
		"--tmp--fork-dedup",
		"02_fork.jsonl",
		{ id: "fork0000", cwd: "/tmp/project", parentSession: "parent00", inheritedThroughEntryId: lastCopy },
		[...copies, buildAssistantEntry({ entryId: "asst02cd", parentId: lastCopy, timestamp: ownTs })],
	);
	await syncAllSessions({ workers: 1, files: [parentFile, forkFile] });

	const db = await initDb();
	db.query(
		"UPDATE messages SET session_file = ?, cost_input = 0, cost_output = 0, cost_total = 0 WHERE entry_id = ?",
	).run(forkFile, "asst01ab");
	db.query("UPDATE user_messages SET session_file = ? WHERE entry_id = ?").run(forkFile, "user01ab");
	db.query("UPDATE tool_calls SET session_file = ? WHERE tool_call_id = ?").run(forkFile, "call01ab");
	db.query("UPDATE tool_approvals SET session_file = ? WHERE tool_call_id = ?").run(forkFile, "call01ab");
	db.query("DELETE FROM meta WHERE key = ?").run("inherited_prefix_replay_v1");
	expect(getOverallStats().totalCost).toBeCloseTo(0.003, 8);
	closeDb();
	return { parentFile, forkFile };
}

function makeStat(sessionFile: string, entryId: string, timestamp: number, premium = 0): MessageStats {
	return {
		sessionFile,
		entryId,
		folder: "/tmp/fork-dedup",
		model: "gpt-5.4",
		provider: "openai",
		api: "openai-responses",
		timestamp,
		duration: 10,
		ttft: 5,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			premiumRequests: premium,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		},
		agentType: "main",
	};
}

describe("stats sync deduplicates forked-session entries", () => {
	it("keeps each request attributed to its original transcript when the fork finishes parsing first", async () => {
		const ts = new Date("2026-06-24T10:00:00.000Z").toISOString();
		const userEntry = buildUserEntry("user01ab", ts, "hello");
		const assistantEntry = buildAssistantEntry({ entryId: "asst01ab", parentId: "user01ab", timestamp: ts });

		const parentFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"01_parent.jsonl",
			{ id: "parent00", cwd: "/tmp/project" },
			[userEntry, assistantEntry],
		);

		// `SessionManager.createBranchedSession` / `forkFrom` deep-copy the
		// parent's entries into the child file with `parentSession` in the
		// header. Earlier stats sync keyed uniqueness on (session_file,
		// entry_id), so both files contributed the same provider request to
		// every aggregate.
		const forkFile = await writeForkSessionFile(
			parentFile,
			"--tmp--fork-dedup",
			"02_fork.jsonl",
			{ id: "fork0000", cwd: "/tmp/project", parentSession: parentFile },
			[userEntry, assistantEntry],
		);
		const parse = parser.parseSessionFile;
		const forkParsed = parse(forkFile);
		const observer = spyOn(parser, "parseSessionFile").mockImplementation(async (file, offset, state, replay) => {
			if (file === forkFile) return forkParsed;
			// Finish the real fork read before allowing its parent's read to start.
			await forkParsed;
			return parse(file, offset, state, replay);
		});
		try {
			await syncAllSessions({ workers: 1 });
		} finally {
			observer.mockRestore();
		}

		const assistantRequests = getRecentRequests(10).filter(r => r.entryId === "asst01ab");
		expect(assistantRequests).toHaveLength(1);
		expect(assistantRequests[0].sessionFile).toBe(parentFile);

		const overall = getOverallStats();
		expect(overall.totalRequests).toBe(1);
		expect(overall.totalInputTokens).toBe(100);
		expect(overall.totalOutputTokens).toBe(50);
		expect(overall.totalCost).toBeCloseTo(0.003, 8);
	});

	it("admits new entries appended in the forked session", async () => {
		const ts = new Date("2026-06-24T10:00:00.000Z").toISOString();
		const userEntry = buildUserEntry("user01ab", ts, "hello");
		const assistantEntry = buildAssistantEntry({ entryId: "asst01ab", parentId: "user01ab", timestamp: ts });

		const parentFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"01_parent.jsonl",
			{ id: "parent00", cwd: "/tmp/project" },
			[userEntry, assistantEntry],
		);

		// After fork, the child file appends a fresh user+assistant pair.
		// Inherited entries must dedupe; new ones must still count.
		const newTs = new Date("2026-06-24T10:05:00.000Z").toISOString();
		const newUserEntry = buildUserEntry("user02cd", newTs, "follow-up");
		const newAssistantEntry = buildAssistantEntry({
			entryId: "asst02cd",
			parentId: "user02cd",
			timestamp: newTs,
		});
		await writeSessionFile(
			"--tmp--fork-dedup",
			"02_fork.jsonl",
			{ id: "fork0000", cwd: "/tmp/project", parentSession: parentFile },
			[userEntry, assistantEntry, newUserEntry, newAssistantEntry],
		);

		await syncAllSessions({ workers: 1 });

		const overall = getOverallStats();
		expect(overall.totalRequests).toBe(2);
		expect(overall.totalInputTokens).toBe(200);
		expect(overall.totalOutputTokens).toBe(100);
		expect(overall.totalCost).toBeCloseTo(0.006, 8);
	});

	it("collapses pre-existing duplicate rows on init (one-shot migration)", async () => {
		await initDb();
		closeDb();

		// Clear the fork-dedupe sentinel so the migration runs against the
		// hand-inserted dupes, then plant two messages and two user_messages
		// rows that share (entry_id, timestamp) under different session_files
		// — exactly the shape `SessionManager.fork()` leaves behind.
		const database = new Database(getStatsDbPath());
		database.prepare("DELETE FROM meta WHERE key = ?").run("fork_dedupe_v1");
		const ts = Date.now();
		const insertMessage = database.prepare(`
			INSERT INTO messages (
				session_file, entry_id, folder, model, provider, api, timestamp,
				duration, ttft, stop_reason, error_message,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
				cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, agent_type
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const sharedArgs = [
			"/tmp/fork-dedup/project",
			"gpt-5.4",
			"openai",
			"openai-responses",
			ts,
			10,
			5,
			"stop",
			null,
			100,
			50,
			0,
			0,
			150,
			0,
			0.001,
			0.002,
			0,
			0,
			0.003,
			"main",
		];
		insertMessage.run("/tmp/parent.jsonl", "asst01ab", ...sharedArgs);
		insertMessage.run("/tmp/fork.jsonl", "asst01ab", ...sharedArgs);
		const insertUser = database.prepare(`
			INSERT INTO user_messages (
				session_file, entry_id, folder, timestamp, model, provider,
				chars, words, yelling, profanity, anguish,
				negation, repetition, blame
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const sharedUser = ["/tmp/fork-dedup/project", ts, "gpt-5.4", "openai", 5, 1, 0, 0, 0, 0, 0, 0];
		insertUser.run("/tmp/parent.jsonl", "user01ab", ...sharedUser);
		insertUser.run("/tmp/fork.jsonl", "user01ab", ...sharedUser);
		database.close();

		await initDb();

		const messageRows = getRecentRequests(10).filter(r => r.entryId === "asst01ab");
		expect(messageRows).toHaveLength(1);
		expect(messageRows[0].sessionFile).toBe("/tmp/parent.jsonl");
		const overall = getOverallStats();
		expect(overall.totalRequests).toBe(1);
		expect(overall.totalCost).toBeCloseTo(0.003, 8);

		// The migration is idempotent. Re-running init must not delete the
		// surviving row.
		closeDb();
		await initDb();
		expect(getOverallStats().totalRequests).toBe(1);
	});

	it("still upserts premium_requests for re-syncs of the same session file", async () => {
		await initDb();
		const stat = makeStat("/tmp/session-a.jsonl", "asst01ab", Date.now(), 0);
		insertMessageStats([stat]);
		const upgraded = { ...stat, usage: { ...stat.usage, premiumRequests: 1 } };
		insertMessageStats([upgraded]);

		const requests = getRecentRequests(10).filter(r => r.entryId === "asst01ab");
		expect(requests).toHaveLength(1);
		expect(requests[0].usage.premiumRequests).toBe(1);
	});

	it("leaves a reset fork's copied calls to the parent even when the fork syncs first", async () => {
		const ts = new Date("2026-06-24T10:00:00.000Z").toISOString();
		const userEntry = buildUserEntry("user01ab", ts, "hello");
		const plainEntry = buildAssistantEntry({ entryId: "asst01ab", parentId: "user01ab", timestamp: ts });
		const toolCall = { type: "toolCall", id: "call01ab", name: "read", arguments: { path: "a.ts" } };
		const assistantEntry = {
			...plainEntry,
			message: { ...plainEntry.message, content: [...plainEntry.message.content, toolCall] },
		};
		const approvalEntry = {
			type: "custom",
			id: "appr01ab",
			parentId: "asst01ab",
			timestamp: ts,
			customType: "tool_approval_requested",
			data: { toolCallId: "call01ab", toolName: "read", requestedAt: ts },
		};
		const parentFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"01_parent.jsonl",
			{ id: "parent00", cwd: "/tmp/project" },
			[userEntry, assistantEntry, approvalEntry],
		);
		// `forkFrom` with `resetInheritedCost` (a `/tan` clone) zeroes the copy's cost and marks the
		// copied prefix; the clone then makes a call of its own.
		const copied = structuredClone(assistantEntry);
		copied.message.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		const ownTs = new Date("2026-06-24T10:05:00.000Z").toISOString();
		const forkFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"02_fork.jsonl",
			{ id: "fork0000", cwd: "/tmp/project", parentSession: parentFile, inheritedThroughEntryId: "appr01ab" },
			[
				userEntry,
				copied,
				approvalEntry,
				buildAssistantEntry({ entryId: "asst02cd", parentId: "appr01ab", timestamp: ownTs }),
			],
		);

		// The fork lands first, as a from-scratch sync of a fork newer than an idle parent does.
		await syncAllSessions({ workers: 1, files: [forkFile, parentFile] });

		const requests = getRecentRequests(10);
		expect(requests.find(request => request.entryId === "asst01ab")?.sessionFile).toBe(parentFile);
		expect(requests.find(request => request.entryId === "asst02cd")?.sessionFile).toBe(forkFile);
		const overall = getOverallStats();
		expect(overall.totalRequests).toBe(2);
		// Without the marker the fork's zeroed copy claims the request and the parent's $0.003 is lost.
		expect(overall.totalCost).toBeCloseTo(0.006, 8);
		// The copied tool call stays the parent's, so it still joins the parent's request row.
		const db = await initDb();
		const owners = db
			.query<{ session_file: string }, [string]>("SELECT session_file FROM tool_calls WHERE tool_call_id = ?")
			.all("call01ab");
		expect(owners.map(owner => owner.session_file)).toEqual([parentFile]);
		// The copied prompt stays the parent's too, so the parent's reply link names its model.
		const prompts = db
			.query<{ session_file: string; model: string | null }, [string]>(
				"SELECT session_file, model FROM user_messages WHERE entry_id = ?",
			)
			.all("user01ab");
		expect(prompts).toEqual([{ session_file: parentFile, model: "gpt-5.4" }]);
		// The copied approval stays with the call it gates.
		const approvals = db
			.query<{ session_file: string }, [string]>("SELECT session_file FROM tool_approvals WHERE tool_call_id = ?")
			.all("call01ab");
		expect(approvals.map(approval => approval.session_file)).toEqual([parentFile]);
	});

	it.each([
		{ name: "its requests, prompts and tool calls", approval: false, apart: false },
		{ name: "its tool approvals too", approval: true, apart: false },
		// Blocked by the fork's old rows, the parent takes them back in the replay their removal marks.
		{ name: "after the parent re-parsed in an earlier batch", approval: true, apart: true },
	])(
		"hands a reset fork's copies that an older build gave the fork back to the parent on upgrade: $name",
		async ({ approval, apart }) => {
			const { parentFile, forkFile } = await writeStaleResetFork(approval);

			await initDb();
			if (apart) {
				await syncAllSessions({ workers: 1, files: [parentFile] });
				await syncAllSessions({ workers: 1, files: [forkFile] });
				const pending = (await initDb()).query("SELECT 1 FROM meta WHERE key = 'session_reconciliation'").get();
				expect(pending).not.toBeNull();
			}
			await syncAllSessions({ workers: 1, files: [forkFile, parentFile] });

			const requests = getRecentRequests(10);
			expect(requests.find(request => request.entryId === "asst01ab")?.sessionFile).toBe(parentFile);
			expect(requests.find(request => request.entryId === "asst02cd")?.sessionFile).toBe(forkFile);
			expect(getOverallStats().totalCost).toBeCloseTo(0.006, 8);
			const repaired = await initDb();
			const owners = (sql: string, id: string) =>
				repaired
					.query<{ session_file: string }, [string]>(sql)
					.all(id)
					.map(row => row.session_file);
			expect(owners("SELECT session_file FROM user_messages WHERE entry_id = ?", "user01ab")).toEqual([parentFile]);
			expect(owners("SELECT session_file FROM tool_calls WHERE tool_call_id = ?", "call01ab")).toEqual([parentFile]);
			expect(owners("SELECT session_file FROM tool_approvals WHERE tool_call_id = ?", "call01ab")).toEqual(
				approval ? [parentFile] : [],
			);
		},
	);

	it("re-reads no transcript on upgrade when none is a reset fork", async () => {
		const ts = new Date("2026-06-24T10:00:00.000Z").toISOString();
		const userEntry = buildUserEntry("user01ab", ts, "hello");
		const assistantEntry = buildAssistantEntry({ entryId: "asst01ab", parentId: "user01ab", timestamp: ts });
		const parentFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"01_parent.jsonl",
			{ id: "parent00", cwd: "/tmp/project" },
			[userEntry, assistantEntry],
		);
		// An ordinary fork names its parent but copies at full cost: nothing of it needs repair.
		const forkFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"02_fork.jsonl",
			{ id: "fork0000", cwd: "/tmp/project", parentSession: "parent00" },
			[userEntry, assistantEntry],
		);
		await syncAllSessions({ workers: 1, files: [parentFile, forkFile] });
		const db = await initDb();
		db.query("DELETE FROM meta WHERE key = ?").run("inherited_prefix_replay_v1");

		const parse = parser.parseSessionFile;
		const parsed: string[] = [];
		const observer = spyOn(parser, "parseSessionFile").mockImplementation(async (file, offset, state, replay) => {
			parsed.push(file);
			return parse(file, offset, state, replay);
		});
		try {
			await syncAllSessions({ workers: 1, files: [parentFile, forkFile] });
		} finally {
			observer.mockRestore();
		}

		expect(parsed).toEqual([]);
		expect(db.query("SELECT 1 FROM meta WHERE key = 'session_reconciliation'").get()).toBeNull();
		const replayKey = db
			.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'inherited_prefix_replay_v1'")
			.get();
		expect(replayKey?.value).toBe("complete");
	});

	it("counts every call of a session whose header marks an entry its file does not hold", async () => {
		const ts = new Date("2026-06-24T10:00:00.000Z").toISOString();
		const laterTs = new Date("2026-06-24T10:05:00.000Z").toISOString();
		const sessionFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"01_session.jsonl",
			{ id: "session0", cwd: "/tmp/project", inheritedThroughEntryId: "gone0000" },
			[
				buildUserEntry("user01ab", ts, "hello"),
				buildAssistantEntry({ entryId: "asst01ab", parentId: "user01ab", timestamp: ts }),
				buildUserEntry("user02cd", laterTs, "again"),
				buildAssistantEntry({ entryId: "asst02cd", parentId: "user02cd", timestamp: laterTs }),
			],
		);

		await syncAllSessions({ workers: 1, files: [sessionFile] });

		const overall = getOverallStats();
		expect(overall.totalRequests).toBe(2);
		expect(overall.totalCost).toBeCloseTo(0.006, 8);
		const db = await initDb();
		const prompts = db.query<{ entry_id: string }, []>("SELECT entry_id FROM user_messages ORDER BY entry_id").all();
		expect(prompts.map(prompt => prompt.entry_id)).toEqual(["user01ab", "user02cd"]);
	});

	it.each([
		{ name: "a legacy /tan clone", boundaryData: "fork0000" },
		// An ordinary fork of such a clone keeps the clone's boundary and id under its own header.
		{ name: "a file derived from a legacy /tan clone", boundaryData: "tanclone" },
	])("leaves $name's copies to the parent by its fork boundary", async ({ boundaryData }) => {
		const ts = new Date("2026-06-24T10:00:00.000Z").toISOString();
		const userEntry = buildUserEntry("user01ab", ts, "hello");
		const assistantEntry = buildAssistantEntry({ entryId: "asst01ab", parentId: "user01ab", timestamp: ts });
		const parentFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"01_parent.jsonl",
			{ id: "parent00", cwd: "/tmp/project" },
			[userEntry, assistantEntry],
		);
		// Written before `inheritedThroughEntryId`: no header marker, only the boundary entry right
		// after the copied entries.
		const copied = structuredClone(assistantEntry);
		copied.message.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		const boundary = {
			type: "custom",
			id: "bound001",
			parentId: "asst01ab",
			timestamp: ts,
			customType: "tan-fork-boundary",
			data: boundaryData,
		};
		const ownTs = new Date("2026-06-24T10:05:00.000Z").toISOString();
		const forkFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"02_fork.jsonl",
			{ id: "fork0000", cwd: "/tmp/project", parentSession: parentFile },
			[
				userEntry,
				copied,
				boundary,
				buildAssistantEntry({ entryId: "asst02cd", parentId: "bound001", timestamp: ownTs }),
			],
		);

		await syncAllSessions({ workers: 1, files: [forkFile, parentFile] });

		const requests = getRecentRequests(10);
		expect(requests.find(request => request.entryId === "asst01ab")?.sessionFile).toBe(parentFile);
		expect(requests.find(request => request.entryId === "asst02cd")?.sessionFile).toBe(forkFile);
		expect(getOverallStats().totalCost).toBeCloseTo(0.006, 8);
	});
});
