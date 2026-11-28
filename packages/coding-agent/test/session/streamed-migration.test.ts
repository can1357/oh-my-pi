import { describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { FileEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { migrateSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-migrations";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const TIMESTAMP = "2025-01-01T00:00:00.000Z";

function header(id: string, version?: number | string): Record<string, unknown> {
	return { type: "session", id, ...(version === undefined ? {} : { version }), timestamp: TIMESTAMP };
}

function user(text: string, id?: string): Record<string, unknown> {
	return {
		type: "message",
		...(id === undefined ? {} : { id }),
		timestamp: TIMESTAMP,
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function compaction(firstKeptEntryIndex: number, id?: string): Record<string, unknown> {
	return {
		type: "compaction",
		...(id === undefined ? {} : { id }),
		timestamp: TIMESTAMP,
		summary: "earlier turns",
		tokensBefore: 100,
		firstKeptEntryIndex,
	};
}

async function writeSessions(dir: string, lines: readonly Record<string, unknown>[]) {
	const whole = path.join(dir, "whole.jsonl");
	const streamed = path.join(dir, "streamed.jsonl");
	const text = lines
		.map(line => `${JSON.stringify(line.type === "session" ? { ...line, cwd: dir } : line)}\n`)
		.join("");
	await Bun.write(whole, text);
	await Bun.write(streamed, new Blob([text, "\n".repeat(8 * 1024 * 1024)]));
	return { whole, streamed };
}

/** The session the whole-file load migrates: every line read, then migrated as one array. */
async function loadWhole(file: string): Promise<FileEntry[]> {
	const entries = parseSessionEntries(await Bun.file(file).text());
	migrateSessionEntries(entries);
	return entries;
}

/** The session a manager streams in, migrating each line as it arrives: its header, then its entries. */
async function loadStreamed(file: string): Promise<FileEntry[]> {
	const storage = new FileSessionStorage();
	const readChunks = spyOn(storage, "readChunks");
	const manager = await SessionManager.open(file, undefined, storage, { suppressBreadcrumb: true });
	expect(readChunks).toHaveBeenCalled();
	await manager.close();
	return [manager.getHeader()!, ...manager.getEntries()];
}

/**
 * The migrated structure of `entries`, with each id written as the position of
 * the entry holding it, since the migration draws new ids at random.
 */
function shape(entries: readonly FileEntry[]): Record<string, unknown>[] {
	const positions = new Map<string, number>();
	for (const [position, entry] of entries.entries()) if (entry.type !== "session") positions.set(entry.id, position);
	const ref = (id: string | null | undefined) =>
		typeof id === "string" ? (positions.get(id) ?? `unknown ${id}`) : id;
	return entries.map(entry => {
		if (entry.type === "session") return { type: entry.type, version: entry.version };
		const shaped: Record<string, unknown> = { type: entry.type, id: ref(entry.id), parentId: ref(entry.parentId) };
		if (entry.type === "compaction") {
			shaped.firstKeptEntryId = Object.hasOwn(entry, "firstKeptEntryId") ? ref(entry.firstKeptEntryId) : "absent";
			if ("firstKeptEntryIndex" in entry) shaped.firstKeptEntryIndex = entry.firstKeptEntryIndex;
		}
		return shaped;
	});
}

const message = (position: number, parent: number | null) => ({ type: "message", id: position, parentId: parent });

describe("an old session migrates the same streamed in as loaded whole", () => {
	const cases: { name: string; lines: Record<string, unknown>[]; expected: Record<string, unknown>[] }[] = [
		{
			name: "a v1 compaction keeping an earlier entry keeps that entry's new id",
			lines: [header("s1"), user("a"), user("b"), compaction(2), user("c")],
			expected: [
				{ type: "session", version: 3 },
				message(1, null),
				message(2, 1),
				{ type: "compaction", id: 3, parentId: 2, firstKeptEntryId: 2 },
				message(4, 3),
			],
		},
		{
			name: "a v1 compaction whose index names itself keeps its own new id",
			lines: [header("s1"), user("a"), compaction(2), user("b")],
			expected: [
				{ type: "session", version: 3 },
				message(1, null),
				{ type: "compaction", id: 2, parentId: 1, firstKeptEntryId: 2 },
				message(3, 2),
			],
		},
		{
			name: "a v1 compaction whose index names a later entry without an id keeps no id",
			lines: [header("s1"), user("a"), compaction(3), user("b")],
			expected: [
				{ type: "session", version: 3 },
				message(1, null),
				{ type: "compaction", id: 2, parentId: 1, firstKeptEntryId: undefined },
				message(3, 2),
			],
		},
		{
			name: "a second header of a current-version session without ids keeps the version the migration gave it",
			lines: [header("s1", 3), user("a"), header("s2", 3), user("b")],
			expected: [{ type: "session", version: 3 }, message(1, null), { type: "session", version: 2 }, message(3, 1)],
		},
		{
			name: "a v1 compaction targeting a later header preserves its existing anchor",
			lines: [header("s1"), { ...compaction(2), firstKeptEntryId: "header-anchor" }, header("s2"), user("a")],
			expected: [
				{ type: "session", version: 3 },
				{ type: "compaction", id: 1, parentId: null, firstKeptEntryId: "unknown header-anchor" },
				{ type: "session", version: 3 },
				message(3, 1),
			],
		},
		{
			name: "a v1 compaction targeting a missing record preserves its existing anchor",
			lines: [header("s1"), { ...compaction(99), firstKeptEntryId: "missing-anchor" }, user("a")],
			expected: [
				{ type: "session", version: 3 },
				{ type: "compaction", id: 1, parentId: null, firstKeptEntryId: "unknown missing-anchor" },
				message(2, 1),
			],
		},
		{
			name: "an unknown version migrates without renumbering indexed entries",
			lines: [header("s1", "unknown"), { ...user("a", "a1"), parentId: null }],
			expected: [{ type: "session", version: 3 }, message(1, null)],
		},
		{
			name: "an unknown version migrates and renumbers entries without ids",
			lines: [header("s1", "unknown"), user("a"), user("b")],
			expected: [{ type: "session", version: 3 }, message(1, null), message(2, 1)],
		},
	];

	for (const { name, lines, expected } of cases) {
		it(name, async () => {
			using dir = TempDir.createSync("@omp-streamed-migration-");
			const files = await writeSessions(dir.path(), lines);
			expect(shape(await loadStreamed(files.streamed))).toEqual(expected);
			expect(shape(await loadWhole(files.whole))).toEqual(expected);
		});
	}

	it("a v1 compaction targeting a later entry keeps its original id", async () => {
		using dir = TempDir.createSync("@omp-streamed-migration-");
		const files = await writeSessions(dir.path(), [
			header("s1"),
			user("a", "x1"),
			compaction(3, "x2"),
			user("b", "x3"),
			user("c", "x4"),
		]);
		const loaded = await loadStreamed(files.streamed);
		const expected = [
			{ type: "session", version: 3 },
			message(1, null),
			{ type: "compaction", id: 2, parentId: 1, firstKeptEntryId: "unknown x3" },
			message(3, 2),
			message(4, 3),
		];
		expect(shape(loaded)).toEqual(expected);
		expect(shape(await loadWhole(files.whole))).toEqual(expected);
		const streamed = loaded.slice(1) as SessionEntry[];
		// No entry holds the target's original id after migration.
		const keptAsInFile = streamed.map(entry =>
			entry.type === "compaction" ? { ...entry, firstKeptEntryId: "x3" } : entry,
		);
		for (const options of [undefined, { transcript: true }]) {
			expect(buildSessionContext(streamed, undefined, undefined, options)).toEqual(
				buildSessionContext(keptAsInFile, undefined, undefined, options),
			);
		}
	});
});
