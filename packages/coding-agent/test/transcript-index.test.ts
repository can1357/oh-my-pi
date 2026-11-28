import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { wordQuery } from "@oh-my-pi/pi-coding-agent/session/search-query";
import {
	closeTranscriptIndex,
	indexedMessageCounts,
	isTranscriptIndexFresh,
	syncTranscriptIndex,
	transcriptSessionIds,
} from "@oh-my-pi/pi-coding-agent/session/transcript-index";
import {
	getConfigRootDir,
	getSessionsDir,
	getTranscriptIndexDbPath,
	removeSyncWithRetries,
	setAgentDir,
} from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let root: string;
let bucket: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-transcripts-"));
	setAgentDir(path.join(root, "agent"));
	closeTranscriptIndex();
	bucket = path.join(getSessionsDir(), "--proj--");
	fs.mkdirSync(bucket, { recursive: true });
});

afterEach(() => {
	closeTranscriptIndex();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(path.join(getConfigRootDir(), "agent"));
		delete process.env.PI_CODING_AGENT_DIR;
	}
	removeSyncWithRetries(root);
});

function line(entry: unknown): string {
	return `${JSON.stringify(entry)}\n`;
}

function header(id: string): string {
	return line({ type: "session", version: 3, id, timestamp: "2024-01-01T00:00:00.000Z", cwd: "/proj" });
}

function message(role: string, content: unknown): Record<string, unknown> {
	return {
		type: "message",
		id: crypto.randomUUID().slice(0, 8),
		parentId: null,
		timestamp: "2024-01-01T00:00:01.000Z",
		message: { role, content, timestamp: 1 },
	};
}

function sessionsMatching(query: string): string[] {
	const words = wordQuery(query);
	if (!words) throw new Error(`no words in ${query}`);
	return [...transcriptSessionIds(words, undefined)].sort();
}

it("indexes user and assistant text as session files grow, shrink, and vanish", async () => {
	const file = path.join(bucket, "2024-01-01T00-00-00-000Z_s1.jsonl");
	fs.writeFileSync(
		file,
		header("s1") +
			line(message("user", "deploy the widget")) +
			line(
				message("assistant", [
					{ type: "thinking", thinking: "hidden musing" },
					{ type: "text", text: "widget deployed" },
				]),
			) +
			line(message("toolResult", [{ type: "text", text: "tool noise" }])),
	);
	// Python-style spaced JSON is still a session.
	fs.writeFileSync(
		path.join(bucket, "2024-01-02T00-00-00-000Z_s2.jsonl"),
		'{"type": "session", "id": "s2", "cwd": "/proj"}\n{"type": "message", "message": {"role": "user", "content": "spaced widget"}}\n',
	);
	expect(isTranscriptIndexFresh(60_000)).toBe(false);
	expect((await syncTranscriptIndex()).outcome).toBe("synced");
	expect(isTranscriptIndexFresh(60_000)).toBe(true);
	expect(sessionsMatching("widget")).toEqual(["s1", "s2"]);
	expect(sessionsMatching("musing")).toEqual([]);
	expect(sessionsMatching("noise")).toEqual([]);
	// Message records count every role, tool results included, while the index is current for the file.
	const records = () => indexedMessageCounts([{ path: file, size: fs.statSync(file).size }]).get(file);
	expect(records()).toBe(3);

	// Appended lines index on the next sync; an unterminated last line waits for its newline.
	fs.appendFileSync(
		file,
		line(message("user", "rotate the keys")) +
			JSON.stringify(message("assistant", [{ type: "text", text: "gizmo" }])),
	);
	await syncTranscriptIndex();
	expect(sessionsMatching("rotate keys")).toEqual(["s1"]);
	expect(sessionsMatching("gizmo")).toEqual([]);
	expect(records()).toBeUndefined();
	fs.appendFileSync(file, "\n");
	await syncTranscriptIndex();
	expect(sessionsMatching("gizmo")).toEqual(["s1"]);
	expect(records()).toBe(5);

	// A shorter rewrite replaces everything indexed from the old content.
	fs.writeFileSync(file, header("s1") + line(message("user", "fresh start")));
	await syncTranscriptIndex();
	expect(sessionsMatching("deploy")).toEqual([]);
	expect(sessionsMatching("fresh")).toEqual(["s1"]);

	fs.rmSync(file);
	await syncTranscriptIndex();
	expect(sessionsMatching("fresh")).toEqual([]);
	expect(sessionsMatching("widget")).toEqual(["s2"]);
});

/** A store as a binary before rows kept their entry id left it, last synced just now. */
function writeStoreWithoutEntryIds(): string {
	const store = getTranscriptIndexDbPath();
	fs.mkdirSync(path.dirname(store), { recursive: true });
	const db = new Database(store);
	db.run(
		"CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, cwd TEXT NOT NULL, indexed INTEGER NOT NULL, messages INTEGER NOT NULL)",
	);
	db.run(
		"CREATE TABLE messages (id INTEGER PRIMARY KEY, file INTEGER NOT NULL, role TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL)",
	);
	db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
	db.run("INSERT INTO meta (key, value) VALUES ('synced_at', ?)", [Date.now()]);
	db.close();
	return store;
}

// The rebuild empties the index: reported fresh, search would answer from nothing until the next sync.
it("reports a store it rebuilt for entry ids as not fresh", () => {
	writeStoreWithoutEntryIds();
	expect(isTranscriptIndexFresh(60_000)).toBe(false);
});

// An older binary still writes rows without an entry id into the rebuilt store; a failed insert would stop its sync.
it("accepts a message row without an entry id in a store it rebuilt", () => {
	const store = writeStoreWithoutEntryIds();
	// Any open of the store rebuilds it.
	isTranscriptIndexFresh(60_000);
	closeTranscriptIndex();
	const db = new Database(store);
	try {
		db.run("INSERT INTO messages (file, role, at, text) VALUES (1, 'user', 0, 'from an older binary')");
		expect(db.query("SELECT entry, text FROM messages").all()).toEqual([{ entry: "", text: "from an older binary" }]);
	} finally {
		db.close();
	}
});

// An older binary indexes the lines it reads without their entry ids. A record a later sync reads must still reach
// such a message, or `archive.search` keeps finding the text an elide pass removed.
it("applies a record to a message an older binary indexed without its entry id", async () => {
	const file = path.join(bucket, "2024-01-01T00-00-00-000Z_s1.jsonl");
	await Bun.write(file, header("s1") + line(message("user", "deploy the widget")));
	await syncTranscriptIndex();
	const reply = message("assistant", [{ type: "text", text: "HEAVYMARK output" }]);
	await fs.promises.appendFile(file, line(reply));
	// The older binary's sync of the new line: a row without the entry id, and the file indexed through it.
	closeTranscriptIndex();
	const size = (await fs.promises.stat(file)).size;
	const db = new Database(getTranscriptIndexDbPath());
	try {
		db.run("INSERT INTO messages (file, role, at, text) SELECT id, 'assistant', 0, 'HEAVYMARK output' FROM files");
		db.run("UPDATE files SET indexed = ?, messages = messages + 1", [size]);
	} finally {
		db.close();
	}
	expect(sessionsMatching("heavymark")).toEqual(["s1"]);

	await fs.promises.appendFile(
		file,
		line({
			type: "custom",
			customType: "entry_patch",
			id: "p1",
			parentId: reply.id,
			timestamp: "2024-01-01T00:00:02.000Z",
			data: { patches: [{ entryId: reply.id, message: { content: [{ type: "text", text: "ELIDEDMARK" }] } }] },
		}),
	);
	await syncTranscriptIndex();
	expect({ heavy: sessionsMatching("heavymark"), elided: sessionsMatching("elidedmark") }).toEqual({
		heavy: [],
		elided: ["s1"],
	});
	expect(sessionsMatching("widget")).toEqual(["s1"]);
}, 30_000);
