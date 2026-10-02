/**
 * Workspace helpers: the working directory comes from the session file's own
 * `session` record (via omp's SessionManager), path helpers, and the live
 * session listing that rides along with `/sessions`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionPresence } from "@oh-my-pi/pi-coding-agent/session/session-presence";
import type { TelegramBridgeContext } from "@oh-my-pi/pi-coding-agent/telegram/context";
import {
	createWorkspace,
	expandHome,
	sessionCwdOf,
	sessionIdOf,
	shortId,
} from "@oh-my-pi/pi-coding-agent/telegram/workspace";
import type { TopicEntry } from "@oh-my-pi/pi-coding-agent/telegram/types";

const dirs: string[] = [];

function sessionFile(name: string, lines: unknown[]): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-session-"));
	dirs.push(dir);
	const file = path.join(dir, `${name}.jsonl`);
	fs.writeFileSync(
		file,
		`${lines.map(line => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`,
	);
	return file;
}

const HEADER = (cwd: string) => ({
	type: "session",
	version: 3,
	id: "01a00000-0000-7000-8000-000000000000",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd,
	title: "Fake session",
	titleSource: "auto",
});
const MESSAGE = {
	type: "message",
	id: "ff000000",
	parentId: null,
	timestamp: "2026-01-01T00:00:01.000Z",
	message: { role: "user", content: [{ type: "text", text: "conversation" }] },
};

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("session files", () => {
	it("reads the working directory from the session record and ignores later conversation", () => {
		const talk = Array.from({ length: 400 }, () => MESSAGE);
		const file = sessionFile("one", [HEADER("/tmp/fake/tree"), { type: "title", title: "Fake" }, ...talk]);
		expect(sessionCwdOf(file)).resolves.toBe("/tmp/fake/tree");
		expect(sessionIdOf(file)).toBe("one");
		expect(shortId("01a00000-0000-7000-8000-000000000000")).toBe("01a00000");
	});

	it("returns null without a session record, with an empty directory, and for a missing file", async () => {
		expect(await sessionCwdOf(sessionFile("two", [{ type: "title", title: "Fake" }, MESSAGE]))).toBeNull();
		expect(await sessionCwdOf(sessionFile("three", [HEADER(""), MESSAGE]))).toBeNull();
		expect(await sessionCwdOf(path.join(os.tmpdir(), "definitely-missing.jsonl"))).toBeNull();
		expect(await sessionCwdOf(sessionFile("four", ["not json"]))).toBeNull();
	});

	it("expands a home directory and leaves absolute paths alone", () => {
		expect(expandHome("~", "/home/dev")).toBe("/home/dev");
		expect(expandHome("~/tree", "/home/dev")).toBe(path.join("/home/dev", "tree"));
		expect(expandHome("/absolute/tree", "/home/dev")).toBe("/absolute/tree");
	});
});

function workspaceCtx(input: { presence?: SessionPresence[]; broken?: boolean; entries?: TopicEntry[] }): {
	ctx: TelegramBridgeContext;
	sent: string[];
} {
	const sent: string[] = [];
	const entries = input.entries ?? [];
	const ctx = {
		livePresence: async () => {
			if (input.broken === true) throw new Error("presence directory unreadable");
			return input.presence ?? [];
		},
		registry: { bySessionFile: (file: string) => entries.find(entry => entry.sessionFile === file) ?? null },
		log: () => {},
		notify: async (_threadId: number | null, markdown: string) => {
			sent.push(markdown);
			return true;
		},
	} as unknown as TelegramBridgeContext;
	return { ctx, sent };
}

const presence = (overrides: Partial<SessionPresence> = {}): SessionPresence => ({
	pid: 4242,
	kind: "interactive",
	sessionId: "abc12345",
	sessionFile: "/work/one/session.jsonl",
	cwd: "/work/one",
	sessionName: "Card tree",
	startedAt: 0,
	updatedAt: 0,
	...overrides,
});

describe("live session listing", () => {
	it("lists interactive sessions of other processes that have no topic", async () => {
		const { ctx } = workspaceCtx({
			presence: [
				presence(),
				presence({ pid: 5, kind: "telegram", sessionFile: "/work/two.jsonl", sessionId: "zzz" }),
			],
		});
		const text = await createWorkspace(ctx).liveText();
		expect(text).toContain("abc12345");
		expect(text).toContain("Card tree");
		expect(text).toContain("`/work/one`");
		expect(text).not.toContain("zzz");
	});

	it("hides a session that already has a topic and says so when there are none", async () => {
		const entry = {
			threadId: 7,
			name: "Fox",
			cwd: "/work/one",
			sessionFile: "/work/one/session.jsonl",
			sessionId: "abc12345",
			status: "idle",
			createdAt: 1,
			updatedAt: 1,
		} satisfies TopicEntry;
		const { ctx } = workspaceCtx({ presence: [presence()], entries: [entry] });
		expect(await createWorkspace(ctx).liveText()).toBe("No live omp sessions without a topic.");
	});

	it("reports an unreadable presence instead of pretending there are no sessions", async () => {
		const { ctx } = workspaceCtx({ broken: true });
		expect(await createWorkspace(ctx).liveText()).toContain("Could not read the machine's live sessions");
	});
});
