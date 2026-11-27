import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncTranscripts } from "@oh-my-pi/pi-coding-agent/daemon/modules/transcripts";
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

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
	"skips a session file this user cannot read, so the index stays fresh sync after sync",
	async () => {
		fs.writeFileSync(
			path.join(bucket, "2024-01-01T00-00-00-000Z_ok.jsonl"),
			header("ok") + line(message("user", "readable widget")),
		);
		const locked = path.join(bucket, "2024-01-02T00-00-00-000Z_locked.jsonl");
		fs.writeFileSync(locked, header("locked") + line(message("user", "locked widget")));
		fs.chmodSync(locked, 0o000);
		try {
			const passes: Array<[string, boolean]> = [];
			for (let i = 0; i < 3; i++) {
				const { outcome } = await syncTranscriptIndex();
				passes.push([outcome, isTranscriptIndexFresh(60_000)]);
			}
			expect(passes).toEqual([
				["synced", true],
				["synced", true],
				["synced", true],
			]);
			expect(sessionsMatching("widget")).toEqual(["ok"]);
		} finally {
			fs.chmodSync(locked, 0o600);
		}
	},
);

it("never opens or syncs the user's index from a test that chose no agent directory", async () => {
	// The agent dir a test that set none would resolve: the user's own.
	const user = path.join(root, "user-agent");
	setAgentDir(user);
	delete process.env.PI_CODING_AGENT_DIR;
	fs.mkdirSync(path.join(getSessionsDir(), "--proj--"), { recursive: true });
	fs.writeFileSync(
		path.join(getSessionsDir(), "--proj--", "2024-01-01T00-00-00-000Z_s1.jsonl"),
		header("s1") + line(message("user", "private widget")),
	);

	// Neither a direct sync nor the archive's sync of the JSONL tree (on a worker of this process).
	expect(await syncTranscriptIndex()).toEqual({ outcome: "unavailable", files: 0, messages: 0 });
	expect(await syncTranscripts()).toEqual({ outcome: "unavailable", files: 0, messages: 0 });
	expect(isTranscriptIndexFresh(60_000)).toBe(false);
	expect(fs.existsSync(getTranscriptIndexDbPath())).toBe(false);

	// The same calls once the test has chosen that directory open and sync it.
	process.env.PI_CODING_AGENT_DIR = user;
	expect(await syncTranscripts()).toEqual({ outcome: "synced", files: 1, messages: 1 });
	expect(fs.existsSync(getTranscriptIndexDbPath())).toBe(true);
	expect(await syncTranscriptIndex()).toEqual({ outcome: "synced", files: 0, messages: 0 });
});
