import { Database } from "bun:sqlite";
import { describe, expect, it, onTestFinished, spyOn } from "bun:test";
import * as nodeFs from "node:fs";
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
	header: { id: string; cwd: string; parentSession?: string },
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
	};
	const lines = [headerEntry, ...entries].map(entry => JSON.stringify(entry)).join("\n");
	await Bun.write(sessionFile, `${lines}\n`);
	return sessionFile;
}

/**
 * Make `others` report `parentFile`'s birth and change times, as files created in one kernel clock
 * tick do. The stat spy is restored when the calling test ends, also after a timeout.
 */
function bornTogether(parentFile: string, others: string[]): void {
	const { birthtimeMs, ctimeMs } = nodeFs.statSync(parentFile);
	const realStat = nodeFs.promises.stat;
	const stat = spyOn(nodeFs.promises, "stat").mockImplementation((async (target: nodeFs.PathLike) => {
		const stats = await realStat(target);
		if (typeof target === "string" && others.includes(target)) {
			stats.birthtimeMs = birthtimeMs;
			stats.ctimeMs = ctimeMs;
		}
		return stats;
	}) as typeof nodeFs.promises.stat);
	onTestFinished(() => stat.mockRestore());
}

/**
 * Write `entries` to `file` as coding-agent writes a session: the fixed 256-byte title slot line
 * (`serializeTitleSlot`), then the session header with `fields` over the defaults. For a copy,
 * `SessionManager.forkFrom` with `seance` (the task executor's consult) records the source's session
 * id as `parentSession` and the source transcript's absolute path as `seanceSource`;
 * `createBranchedSession` records the source transcript's absolute path as `parentSession`, spelled as
 * the session was opened.
 */
async function writeCopy(file: string, fields: Record<string, unknown>, entries: unknown[]): Promise<void> {
	const timestamp = new Date().toISOString();
	const slot = { type: "title", v: 1, title: "", updatedAt: timestamp, pad: "" };
	slot.pad = " ".repeat(255 - JSON.stringify(slot).length);
	const header = { type: "session", version: 3, id: Bun.randomUUIDv7(), timestamp, cwd: "/tmp/project", ...fields };
	const lines = [slot, header, ...entries].map(entry => JSON.stringify(entry)).join("\n");
	await Bun.write(file, `${lines}\n`);
}

/** An assistant entry with its usage cost zeroed, as a seance's `resetInheritedCost` leaves inherited turns. */
function buildInheritedAssistantEntry(opts: AssistantOptions) {
	const entry = buildAssistantEntry(opts);
	entry.message.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	return entry;
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
		const forkFile = await writeSessionFile(
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
		onTestFinished(() => observer.mockRestore());
		await syncAllSessions({ workers: 1 });

		const assistantRequests = getRecentRequests(10).filter(r => r.entryId === "asst01ab");
		expect(assistantRequests).toHaveLength(1);
		expect(assistantRequests[0].sessionFile).toBe(parentFile);

		const overall = getOverallStats();
		expect(overall.totalRequests).toBe(1);
		expect(overall.totalInputTokens).toBe(100);
		expect(overall.totalOutputTokens).toBe(50);
		expect(overall.totalCost).toBeCloseTo(0.003, 8);
	});

	it("ingests a parent before a fork born in the same clock tick, whichever the directory lists first", async () => {
		const ts = new Date("2026-06-24T10:00:00.000Z").toISOString();
		const userEntry = buildUserEntry("user01ab", ts, "hello");
		const assistantEntry = buildAssistantEntry({ entryId: "asst01ab", parentId: "user01ab", timestamp: ts });
		const parentFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"01_parent.jsonl",
			{ id: "parent00", cwd: "/tmp/project" },
			[userEntry, assistantEntry],
		);
		const forkFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"02_fork.jsonl",
			{ id: "fork0000", cwd: "/tmp/project", parentSession: parentFile },
			[userEntry, assistantEntry],
		);

		// Birth times are only as fine as the kernel's clock tick, so a fork written right after its
		// parent usually gets the parent's birth time, and a directory lists names in the filesystem's
		// own order (ext4 lists `02_fork.jsonl` before `01_parent.jsonl`). Force both.
		bornTogether(parentFile, [forkFile]);
		const listing = spyOn(parser, "listAllSessionFiles").mockResolvedValue([forkFile, parentFile]);
		onTestFinished(() => listing.mockRestore());
		await syncAllSessions({ workers: 1 });

		const assistantRequests = getRecentRequests(10).filter(r => r.entryId === "asst01ab");
		expect(assistantRequests.map(r => r.sessionFile)).toEqual([parentFile]);
		expect(getOverallStats().totalRequests).toBe(1);
	});

	it("ingests a transcript before a subagent transcript under its directory born in the same tick", async () => {
		const ts = new Date("2026-06-24T10:00:00.000Z").toISOString();
		const userEntry = buildUserEntry("user01ab", ts, "hello");
		const assistantEntry = buildAssistantEntry({ entryId: "asst01ab", parentId: "user01ab", timestamp: ts });
		// A subagent's transcript lives in its parent's directory and is named after it:
		// `Parent.Child.jsonl` sorts before `Parent.jsonl` by name alone.
		const parentFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"2026-06-24T10-00-00-000Z_root/Parent.jsonl",
			{ id: "parent00", cwd: "/tmp/project" },
			[userEntry, assistantEntry],
		);
		const childFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"2026-06-24T10-00-00-000Z_root/Parent/Parent.Child.jsonl",
			{ id: "child000", cwd: "/tmp/project", parentSession: parentFile },
			[userEntry, assistantEntry],
		);
		bornTogether(parentFile, [childFile]);
		const listing = spyOn(parser, "listAllSessionFiles").mockResolvedValue([childFile, parentFile]);
		onTestFinished(() => listing.mockRestore());
		await syncAllSessions({ workers: 1 });

		const assistantRequests = getRecentRequests(10).filter(r => r.entryId === "asst01ab");
		expect(assistantRequests.map(r => r.sessionFile)).toEqual([parentFile]);
	});

	it("ingests a seance's source before a sibling seance named before it and born in the same tick", async () => {
		const ts = new Date("2026-06-24T10:00:00.000Z").toISOString();
		const userEntry = buildUserEntry("user01ab", ts, "hello");
		const assistantEntry = buildAssistantEntry({ entryId: "asst01ab", parentId: "user01ab", timestamp: ts });
		// A seance can consult a subagent from a sibling transcript: `Alpha.jsonl` copies `Zebra.jsonl`.
		const sourceFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"2026-06-24T10-00-00-000Z_root/Zebra.jsonl",
			{ id: "zebra000", cwd: "/tmp/project" },
			[userEntry, assistantEntry],
		);
		const copyFile = path.join(path.dirname(sourceFile), "Alpha.jsonl");
		await writeCopy(copyFile, { parentSession: "zebra000", seanceSource: sourceFile }, [
			userEntry,
			buildInheritedAssistantEntry({ entryId: "asst01ab", parentId: "user01ab", timestamp: ts }),
		]);
		bornTogether(sourceFile, [copyFile]);
		const listing = spyOn(parser, "listAllSessionFiles").mockResolvedValue([copyFile, sourceFile]);
		onTestFinished(() => listing.mockRestore());
		await syncAllSessions({ workers: 1 });

		const assistantRequests = getRecentRequests(10).filter(r => r.entryId === "asst01ab");
		expect(assistantRequests.map(r => r.sessionFile)).toEqual([sourceFile]);
		const overall = getOverallStats();
		expect(overall.totalRequests).toBe(1);
		expect(overall.totalCost).toBeCloseTo(0.003, 8);
	});

	it("ingests a seance's source before a seance under an older caller's directory born in the same tick", async () => {
		const ts = new Date("2026-06-24T10:00:00.000Z").toISOString();
		const userEntry = buildUserEntry("user01ab", ts, "hello");
		const assistantEntry = buildAssistantEntry({ entryId: "asst01ab", parentId: "user01ab", timestamp: ts });
		// The caller's directory is named for an older session, so it sorts before the source it consults.
		const sourceFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"2026-06-24T10-00-00-000Z_source.jsonl",
			{ id: "source00", cwd: "/tmp/project" },
			[userEntry, assistantEntry],
		);
		const copyFile = path.join(path.dirname(sourceFile), "2026-06-24T09-00-00-000Z_caller", "Consult.jsonl");
		await writeCopy(copyFile, { parentSession: "source00", seanceSource: sourceFile }, [
			userEntry,
			buildInheritedAssistantEntry({ entryId: "asst01ab", parentId: "user01ab", timestamp: ts }),
		]);
		bornTogether(sourceFile, [copyFile]);
		const listing = spyOn(parser, "listAllSessionFiles").mockResolvedValue([copyFile, sourceFile]);
		onTestFinished(() => listing.mockRestore());
		await syncAllSessions({ workers: 1 });

		const assistantRequests = getRecentRequests(10).filter(r => r.entryId === "asst01ab");
		expect(assistantRequests.map(r => r.sessionFile)).toEqual([sourceFile]);
		const overall = getOverallStats();
		expect(overall.totalRequests).toBe(1);
		expect(overall.totalCost).toBeCloseTo(0.003, 8);
	});

	it("ingests a seance's source before its copy when both session headers run past 4 KiB", async () => {
		const ts = new Date("2026-06-24T10:00:00.000Z").toISOString();
		const userEntry = buildUserEntry("user01ab", ts, "hello");
		const assistantEntry = buildAssistantEntry({ entryId: "asst01ab", parentId: "user01ab", timestamp: ts });
		// Writers bound no header: a long session name or many workspace directories make it kilobytes long,
		// and a copy carries its source's directories.
		const additionalDirectories = Array.from(
			{ length: 48 },
			(_, i) => `/tmp/project/workspace-${i}-${"d".repeat(80)}`,
		);
		const sourceFile = path.join(
			getSessionsDir(),
			"--tmp--fork-dedup",
			"2026-06-24T10-00-00-000Z_root",
			"Zebra.jsonl",
		);
		await writeCopy(sourceFile, { id: "zebra000", title: "n".repeat(6000), additionalDirectories }, [
			userEntry,
			assistantEntry,
		]);
		const copyFile = path.join(path.dirname(sourceFile), "Alpha.jsonl");
		await writeCopy(copyFile, { parentSession: "zebra000", seanceSource: sourceFile, additionalDirectories }, [
			userEntry,
			buildInheritedAssistantEntry({ entryId: "asst01ab", parentId: "user01ab", timestamp: ts }),
		]);
		expect((await Bun.file(sourceFile).text()).split("\n")[1]!.length).toBeGreaterThan(4096);
		expect((await Bun.file(copyFile).text()).split("\n")[1]!.length).toBeGreaterThan(4096);
		bornTogether(sourceFile, [copyFile]);
		const listing = spyOn(parser, "listAllSessionFiles").mockResolvedValue([copyFile, sourceFile]);
		onTestFinished(() => listing.mockRestore());
		await syncAllSessions({ workers: 1 });

		const assistantRequests = getRecentRequests(10).filter(r => r.entryId === "asst01ab");
		expect(assistantRequests.map(r => r.sessionFile)).toEqual([sourceFile]);
		expect(getOverallStats().totalCost).toBeCloseTo(0.003, 8);
	});

	it("ingests a transcript before its branch born in the same tick when the branch names it through a symlink", async () => {
		const ts = new Date("2026-06-24T10:00:00.000Z").toISOString();
		const userEntry = buildUserEntry("user01ab", ts, "hello");
		const assistantEntry = buildAssistantEntry({ entryId: "asst01ab", parentId: "user01ab", timestamp: ts });
		const sessionsDir = getSessionsDir();
		const sourceFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"2026-06-24T10-00-00-000Z_root/Zebra.jsonl",
			{ id: "zebra000", cwd: "/tmp/project" },
			[userEntry, assistantEntry],
		);
		// A branch's header names its source by the path the session was opened through, here a
		// symlink to the sessions directory, while the listing spells both by the real directory.
		const linkedSessions = `${sessionsDir}-link`;
		await fs.symlink(sessionsDir, linkedSessions);
		const copyFile = path.join(path.dirname(sourceFile), "2026-06-24T10-05-00-000Z_branch00.jsonl");
		await writeCopy(copyFile, { parentSession: path.join(linkedSessions, path.relative(sessionsDir, sourceFile)) }, [
			userEntry,
			assistantEntry,
		]);
		bornTogether(sourceFile, [copyFile]);
		const listing = spyOn(parser, "listAllSessionFiles").mockResolvedValue([copyFile, sourceFile]);
		onTestFinished(() => listing.mockRestore());
		await syncAllSessions({ workers: 1 });

		const assistantRequests = getRecentRequests(10).filter(r => r.entryId === "asst01ab");
		expect(assistantRequests.map(r => r.sessionFile)).toEqual([sourceFile]);
		expect(getOverallStats().totalRequests).toBe(1);
	});

	it("commits a parent before its fork when parallel workers finish the fork first", async () => {
		const ts = new Date("2026-06-24T10:00:00.000Z").toISOString();
		const userEntry = buildUserEntry("user01ab", ts, "hello");
		const assistantEntry = buildAssistantEntry({ entryId: "asst01ab", parentId: "user01ab", timestamp: ts });
		const parentFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"2026-06-24T10-00-00-000Z_parent00.jsonl",
			{ id: "parent00", cwd: "/tmp/project" },
			[userEntry, assistantEntry],
		);
		const forkFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"2026-06-24T10-00-01-000Z_fork0000.jsonl",
			{ id: "fork0000", cwd: "/tmp/project", parentSession: parentFile },
			[userEntry, assistantEntry],
		);
		// Send the parent's parse to its worker only once the fork's worker has answered, as when the
		// parent's transcript is much longer: the fork's result always arrives first.
		const forkAnswered = Promise.withResolvers<void>();
		const post = Worker.prototype.postMessage;
		const posting = spyOn(Worker.prototype, "postMessage").mockImplementation(function (
			this: Worker,
			message: unknown,
		) {
			const sessionFile = (message as { sessionFile?: string } | null)?.sessionFile;
			if (sessionFile === forkFile) this.addEventListener("message", () => forkAnswered.resolve(), { once: true });
			if (sessionFile === parentFile) {
				void forkAnswered.promise.then(() => post.call(this, message));
				return;
			}
			post.call(this, message);
		} as typeof Worker.prototype.postMessage);
		onTestFinished(() => posting.mockRestore());
		const committed: string[] = [];
		await syncAllSessions({ workers: 2, onProgress: event => committed.push(event.sessionFile) });

		expect(committed).toEqual([parentFile, forkFile]);
		const assistantRequests = getRecentRequests(10).filter(r => r.entryId === "asst01ab");
		expect(assistantRequests.map(r => r.sessionFile)).toEqual([parentFile]);
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
});
