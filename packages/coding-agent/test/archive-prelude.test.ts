import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ArchiveCall,
	ArchiveGrepHit,
	ArchiveMessage,
	ArchiveStat,
} from "@oh-my-pi/pi-coding-agent/archive/activity";
import type { ArchiveTranscript } from "@oh-my-pi/pi-coding-agent/archive/transcript";
import type {
	ArchiveProject,
	ArchivePrompt,
	ArchiveRecap,
	ArchiveSearchHit,
	ArchiveSession,
	ArchiveSessionDetail,
} from "@oh-my-pi/pi-coding-agent/archive/archive";
import { createArchivePrelude } from "@oh-my-pi/pi-coding-agent/archive/prelude-definition";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import {
	closeSessionIndex,
	recordSessionRecap,
	recordSessionTitle,
} from "@oh-my-pi/pi-coding-agent/session/session-index";
import { sessionDirForCwd } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage, setDefaultSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { syncTranscripts } from "@oh-my-pi/pi-coding-agent/daemon/modules/transcripts";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { makeAssistantMessage } from "./session-manager/helpers";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let root: string;
let app: string;
let lib: string;

/**
 * JSONL transcript of session `id`, created at `at` in `cwd`.
 * `reply` answers the prompt with that text, `answered` with a stock reply.
 */
function sessionContent(
	id: string,
	at: string,
	cwd: string,
	options: { prompt?: string; answered?: boolean; reply?: string; toolOutput?: string } = {},
): string {
	const later = new Date(new Date(at).getTime() + 1000).toISOString();
	const entries: unknown[] = [{ type: "session", version: 3, id, timestamp: at, cwd }];
	if (options.prompt) {
		entries.push({
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: at,
			message: { role: "user", content: options.prompt, timestamp: 1 },
		});
	}
	if (options.answered || options.reply) {
		const message = makeAssistantMessage();
		if (options.reply) message.content = [{ type: "text", text: options.reply }];
		entries.push({ type: "message", id: "a1", parentId: "u1", timestamp: later, message });
	}
	if (options.toolOutput) {
		entries.push({
			type: "message",
			id: "t1",
			parentId: "a1",
			timestamp: later,
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "text", text: options.toolOutput }],
				isError: false,
				timestamp: 1,
			},
		});
	}
	return `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
}

/** Writes a session file with mtime `at` and an id starting with `label`; returns the id. */
function writeSession(
	cwd: string,
	label: string,
	at: string,
	options: { prompt?: string; answered?: boolean; reply?: string; toolOutput?: string } = {},
): string {
	const time = new Date(at);
	const id = `${label}-${crypto.randomUUID()}`;
	const dir = sessionDirForCwd(cwd);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${time.getTime()}_${id}.jsonl`);
	fs.writeFileSync(file, sessionContent(id, at, cwd, options));
	fs.utimesSync(file, time, time);
	return id;
}

async function call<T>(params: Record<string, unknown>, cwd = app): Promise<T> {
	const session = { cwd, settings: Settings.isolated() } as unknown as ToolSession;
	const result = await createArchivePrelude(session).invoke(params, { session, toolCallId: "archive-test" });
	return result.details as T;
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-archive-"));
	app = path.join(root, "app");
	lib = path.join(root, "lib");
	HistoryStorage.close();
	closeSessionIndex();
	setAgentDir(path.join(root, "agent"));
});

afterEach(() => {
	HistoryStorage.close();
	closeSessionIndex();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(path.join(getConfigRootDir(), "agent"));
		delete process.env.PI_CODING_AGENT_DIR;
	}
	removeSyncWithRetries(root);
});

describe("archive prelude", () => {
	let oldApp: string;
	let newApp: string;
	let libSession: string;

	beforeEach(() => {
		oldApp = writeSession(app, "app-old", "2024-01-01T00:00:00.000Z", { prompt: "old work", answered: true });
		newApp = writeSession(app, "app-new", "2024-03-01T00:00:00.000Z", { prompt: "fix login", answered: true });
		writeSession(app, "app-empty", "2024-04-01T00:00:00.000Z");
		libSession = writeSession(lib, "lib", "2024-02-01T00:00:00.000Z", { prompt: "lib refactor", answered: true });
		writeSession(path.join(root, "idle"), "idle", "2024-05-01T00:00:00.000Z");
		recordSessionRecap(newApp, app, "first recap");
		recordSessionRecap(newApp, app, "second recap");
		recordSessionRecap(libSession, lib, "lib recap");
		const history = HistoryStorage.open();
		history.add("deploy the archive", app, newApp);
		history.add("archive cleanup", lib, libSession);
		history.add("unrelated", app, oldApp);
	});

	it("lists projects by last real activity, skipping projects with only empty sessions", async () => {
		const projects = await call<ArchiveProject[]>({ action: "projects" });
		expect(projects.map(project => [project.path, project.sessions, project.latest.id])).toEqual([
			[app, 3, newApp],
			[lib, 1, libSession],
		]);
		expect(projects[0].latest.recap).toBe("second recap");
	});

	it("scopes sessions to the current project unless asked for every project", async () => {
		const local = await call<ArchiveSession[]>({ action: "sessions" });
		// A missing recap stays a null-valued key so Python callers can index `row["recap"]`.
		expect(local.map(session => [session.id, session.recap])).toEqual([
			[newApp, "second recap"],
			[oldApp, null],
		]);
		const global = await call<ArchiveSession[]>({ action: "sessions", project: "*", limit: 2 });
		expect(global.map(session => session.id)).toEqual([newApp, libSession]);
		const other = await call<ArchiveSession[]>({ action: "sessions", project: "../lib" });
		expect(other.map(session => session.id)).toEqual([libSession]);
	});

	it("resolves a session by id prefix with its full recap journal and its own prompts", async () => {
		const detail = await call<ArchiveSessionDetail>({ action: "session", id: "app-new" });
		expect(detail.id).toBe(newApp);
		expect(detail.recaps.map(recap => recap.text)).toEqual(["first recap", "second recap"]);
		expect(detail.prompts.map(prompt => prompt.text)).toEqual(["deploy the archive"]);
		await expect(call({ action: "session", id: "app-" })).rejects.toThrow("matches 3 sessions");
	});

	it("reads and searches prompt history within the requested project", async () => {
		const texts = (prompts: ArchivePrompt[]) => prompts.map(prompt => prompt.text);
		expect(texts(await call({ action: "prompts" }))).toEqual(["unrelated", "deploy the archive"]);
		expect(texts(await call({ action: "prompts", query: "archive" }))).toEqual(["deploy the archive"]);
		expect(texts(await call({ action: "prompts", query: "archive", project: "*" }))).toEqual([
			"archive cleanup",
			"deploy the archive",
		]);
		// Terms match word prefixes only.
		expect(texts(await call({ action: "prompts", query: "arch", project: lib }))).toEqual(["archive cleanup"]);
		expect(texts(await call({ action: "prompts", query: "chiv", project: lib }))).toEqual([]);
	});

	it("searches session titles, recaps, and transcripts, newest session first", async () => {
		const bench = writeSession(app, "app-bench", "2024-02-15T00:00:00.000Z", {
			prompt: "run the edit benchmark",
			reply: "The typescript-edit-benchmark finished: 41 of 50 passed.",
			toolOutput: "secret tool payload",
		});
		recordSessionTitle(oldApp, "Archive retention policy");
		recordSessionTitle(libSession, "archive internals");
		// The test runner never reaches the user's daemon, so this indexes on a worker thread here.
		expect((await syncTranscripts()).outcome).toBe("synced");
		const search = (params: Record<string, unknown>) => call<ArchiveSearchHit[]>({ action: "search", ...params });
		const found = (hits: ArchiveSearchHit[]) =>
			hits.map(hit => [hit.id, hit.matches.map(match => [match.source, match.text])]);

		// The lib session's title matches too, but lives outside the current project.
		expect(found(await search({ query: "archive" }))).toEqual([[oldApp, [["title", "Archive retention policy"]]]]);
		expect(found(await search({ query: "archive", project: "*" }))).toEqual([
			[libSession, [["title", "archive internals"]]],
			[oldApp, [["title", "Archive retention policy"]]],
		]);
		expect(found(await search({ query: "edit benchmark" }))).toEqual([
			[
				bench,
				[
					["assistant", "The typescript-edit-benchmark finished: 41 of 50 passed."],
					["user", "run the edit benchmark"],
				],
			],
		]);
		expect(found(await search({ query: "second recap" }))).toEqual([[newApp, [["recap", "second recap"]]]]);
		// Tool output is not indexed.
		expect(await search({ query: "secret payload" })).toEqual([]);
		// Every word must occur in one text, not spread across a session's sources.
		expect(await search({ query: "login second" })).toEqual([]);
	});

	it("lists recaps newest first within scope", async () => {
		const recaps = (list: ArchiveRecap[]) => list.map(recap => recap.text);
		expect(recaps(await call({ action: "recaps" }))).toEqual(["second recap", "first recap"]);
		expect(recaps(await call({ action: "recaps", project: "*", limit: 2 }))).toEqual(["lib recap", "second recap"]);
	});

	it("rejects misspelled options instead of falling back to the default scope", async () => {
		await expect(call({ action: "sessions", projects: "*" })).rejects.toThrow("invalid arguments");
	});

	it("narrows listings to a time window", async () => {
		const ids = (sessions: ArchiveSession[]) => sessions.map(session => session.id);
		expect(ids(await call({ action: "sessions", since: "2024-02-15" }))).toEqual([newApp]);
		expect(ids(await call({ action: "sessions", until: "2024-02-01" }))).toEqual([oldApp]);
		expect(ids(await call({ action: "sessions", project: "*", since: "2024-01-15", until: "2024-02-15" }))).toEqual([
			libSession,
		]);
		// Prompts and recaps carry their recording time: now.
		expect(await call<ArchivePrompt[]>({ action: "prompts", until: "2000-01-01" })).toEqual([]);
		expect((await call<ArchivePrompt[]>({ action: "prompts", since: "1h" })).length).toBe(2);
		expect(await call<ArchiveRecap[]>({ action: "recaps", until: "2000-01-01" })).toEqual([]);
		await expect(call({ action: "sessions", since: "yesterday-ish" })).rejects.toThrow("must be an age");
		await expect(call({ action: "sessions", since: "2024-03-01", until: "2024-02-01" })).rejects.toThrow(
			"since must be before until",
		);
	});
});

describe("archive activity", () => {
	const at = (minute: number) => `2024-06-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
	let nextEntry = 0;
	const entry = (time: string, message: Record<string, unknown>) => ({
		type: "message",
		id: `e${nextEntry++}`,
		parentId: null,
		timestamp: time,
		runtime: { version: "19.1.1" },
		message: { timestamp: 1, ...message },
	});
	const user = (time: string, text: string) => entry(time, { role: "user", content: text });
	const assistant = (time: string, content: unknown[]) =>
		entry(time, { role: "assistant", content, model: "model-a", provider: "test", api: "test" });
	const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
		type: "toolCall",
		id,
		name,
		arguments: args,
	});
	const toolResult = (time: string, callId: string, tool: string, text: string, isError = false) =>
		entry(time, {
			role: "toolResult",
			toolCallId: callId,
			toolName: tool,
			content: [{ type: "text", text }],
			isError,
		});

	/** Writes a transcript at `file` whose mtime is its last entry's time. */
	function writeTranscript(file: string, id: string, cwd: string, entries: { timestamp: string }[]): string {
		const header = { type: "session", version: 3, id, timestamp: entries[0]?.timestamp ?? at(0), cwd };
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${[header, ...entries].map(line => JSON.stringify(line)).join("\n")}\n`);
		const mtime = new Date(entries.at(-1)?.timestamp ?? at(0));
		fs.utimesSync(file, mtime, mtime);
		return file;
	}

	/** A top-level session file of `cwd`. */
	function sessionFile(cwd: string, id: string): string {
		return path.join(sessionDirForCwd(cwd), `2024-06-01T10-00-00-000Z_${id}.jsonl`);
	}

	/** A subagent transcript `key` ("Scout", "Scout/Helper") of a session file. */
	function subagentFile(session: string, key: string): string {
		return path.join(session.slice(0, -".jsonl".length), `${key}.jsonl`);
	}

	const callIds = (calls: ArchiveCall[]) => calls.map(found => found.callId);

	let sessionId: string;
	let mainFile: string;

	beforeEach(async () => {
		sessionId = `act-${crypto.randomUUID()}`;
		mainFile = writeTranscript(sessionFile(app, sessionId), sessionId, app, [
			user(at(0), "clean the build"),
			assistant(at(1), [
				{ type: "thinking", thinking: "the builtin sed lacks -z" },
				{ type: "text", text: "Running sed." },
				toolCall("c1", "bash", { command: "/usr/bin/sed -z s/a/b/ build.log", timeout: 5 }),
			]),
			toolResult(at(2), "c1", "bash", "sed: illegal option -- z", true),
			assistant(at(4), [toolCall("c2", "read", { path: "src/build.ts" })]),
			toolResult(at(5), "c2", "read", `${"x".repeat(3000)}TAIL`),
			user(at(8), "now the tests"),
			assistant(at(9), [toolCall("c3", "bash", { command: "bun test" })]),
			toolResult(at(10), "c3", "bash", "ok"),
		]);
		writeTranscript(subagentFile(mainFile, "Scout"), "scout", app, [
			user(at(2), "look around"),
			assistant(at(3), [toolCall("s1", "bash", { command: "ls" })]),
			toolResult(at(3), "s1", "bash", "README.md", true),
		]);
		writeTranscript(subagentFile(mainFile, "Scout/Helper"), "helper", app, [
			assistant(at(6), [toolCall("h1", "grep", { pattern: "TODO" })]),
		]);
		const libFile = writeTranscript(sessionFile(lib, `lib-${crypto.randomUUID()}`), "lib", lib, [
			assistant(at(30), [toolCall("l0", "bash", { command: "make" })]),
		]);
		writeTranscript(subagentFile(libFile, "Scout"), "lib-scout", lib, [
			assistant(at(31), [toolCall("l1", "bash", { command: "make check" })]),
		]);
		// The test runner never reaches the user's daemon, so this indexes on a worker thread here.
		expect((await syncTranscripts()).outcome).toBe("synced");
	});

	it("lists tool calls with their results and the reasoning before them", async () => {
		const calls = await call<ArchiveCall[]>({ action: "calls" });
		expect(calls.map(found => [found.callId, found.tool, found.isError, found.session, found.agent])).toEqual([
			["c3", "bash", false, sessionId, null],
			["c2", "read", false, sessionId, null],
			["c1", "bash", true, sessionId, null],
		]);
		const [tests, read, sed] = calls;
		expect(sed.args).toEqual({ command: "/usr/bin/sed -z s/a/b/ build.log", timeout: 5 });
		expect(sed.result).toBe("sed: illegal option -- z");
		expect([sed.model, sed.version, sed.file]).toEqual(["model-a", "19.1.1", mainFile]);
		expect(sed.reasoning).toBe("the builtin sed lacks -z\n\nRunning sed.");
		// A message without its own thinking links to the reasoning before it, until the user speaks again.
		expect(read.reasoning).toBe(sed.reasoning);
		expect(tests.reasoning).toBeNull();
		// Long results keep their ends; `resultChars` counts the whole.
		expect(read.resultChars).toBe(3004);
		expect(read.result?.length).toBeLessThan(3004);
		expect(read.result?.endsWith("TAIL")).toBe(true);
	});

	it("filters calls by tool, argument and result regexes, failure, and window", async () => {
		expect(callIds(await call({ action: "calls", tool: "bash" }))).toEqual(["c3", "c1"]);
		expect(callIds(await call({ action: "calls", tool: ["read", "grep"] }))).toEqual(["c2"]);
		expect(callIds(await call({ action: "calls", match: "^/usr/bin/sed\\b" }))).toEqual(["c1"]);
		expect(callIds(await call({ action: "calls", result: "ILLEGAL OPTION", flags: "i" }))).toEqual(["c1"]);
		expect(callIds(await call({ action: "calls", error: true }))).toEqual(["c1"]);
		expect(callIds(await call({ action: "calls", error: false }))).toEqual(["c3", "c2"]);
		expect(callIds(await call({ action: "calls", since: at(3), until: at(6) }))).toEqual(["c2"]);
		expect(callIds(await call({ action: "calls", limit: 1 }))).toEqual(["c3"]);
		// Look-around falls back to PCRE2, as in the grep tool.
		expect(callIds(await call({ action: "calls", match: "(?<=/usr/bin/)sed\\b" }))).toEqual(["c1"]);
		await expect(call({ action: "calls", match: "x", flags: "g" })).rejects.toThrow("flags may hold only");
	});

	it("keeps a call still awaiting its result out of failure filters, past a half-written line", async () => {
		const id = `live-${crypto.randomUUID()}`;
		const file = writeTranscript(sessionFile(app, id), id, app, [
			assistant(at(20), [toolCall("live", "bash", { command: "sleep 9" })]),
		]);
		// A live session's last line may still be mid-write.
		fs.appendFileSync(file, JSON.stringify(toolResult(at(21), "live", "bash", "slept")).slice(0, 40));
		const calls = await call<ArchiveCall[]>({ action: "calls", since: at(20) });
		expect(calls.map(found => [found.callId, found.result, found.isError])).toEqual([["live", null, null]]);
		expect(await call<ArchiveCall[]>({ action: "calls", since: at(20), error: false })).toEqual([]);
		expect(await call<ArchiveCall[]>({ action: "calls", since: at(20), error: true })).toEqual([]);
	});

	it("includes subagent transcripts only when asked, and only of sessions in scope", async () => {
		const agents = (calls: ArchiveCall[]) => calls.map(found => [found.callId, found.agent]);
		expect(agents(await call({ action: "calls", subagents: true }))).toEqual([
			["c3", null],
			["h1", "Scout/Helper"],
			["c2", null],
			["s1", "Scout"],
			["c1", null],
		]);
		expect(callIds(await call({ action: "calls", project: "*", subagents: true, since: at(30) }))).toEqual([
			"l1",
			"l0",
		]);
		// A window the session is not active in leaves out its subagents too, whatever their own times.
		expect(await call<ArchiveCall[]>({ action: "calls", subagents: true, until: at(0) })).toEqual([]);
	});

	it("greps thinking, replies, arguments, and results; word search still skips thinking", async () => {
		const found = (hits: ArchiveGrepHit[]) => hits.map(hit => [hit.source, hit.tool, hit.match]);
		expect(found(await call({ action: "grep", pattern: "builtin \\w+" }))).toEqual([
			["thinking", null, "builtin sed"],
		]);
		// A result hit carries the result's time, after its call's.
		expect(found(await call({ action: "grep", pattern: "sed", sources: ["args", "result"] }))).toEqual([
			["result", "bash", "sed"],
			["args", "bash", "sed"],
		]);
		expect(await call<ArchiveGrepHit[]>({ action: "grep", pattern: "sed", sources: ["args"], tool: "read" })).toEqual(
			[],
		);
		expect(found(await call({ action: "grep", pattern: "README", subagents: true }))).toEqual([
			["result", "bash", "README"],
		]);
		expect(await call<ArchiveSearchHit[]>({ action: "search", query: "builtin" })).toEqual([]);
	});

	it("counts calls and errors by tool, session, and day", async () => {
		const counts = (stats: ArchiveStat[]) => stats.map(stat => [stat.key, stat.calls, stat.errors]);
		expect(counts(await call({ action: "stats" }))).toEqual([
			["bash", 2, 1],
			["read", 1, 0],
		]);
		expect(counts(await call({ action: "stats", by: "session", subagents: true }))).toEqual([[sessionId, 5, 2]]);
		expect(counts(await call({ action: "stats", by: "tool", error: true, subagents: true }))).toEqual([
			["bash", 2, 2],
		]);
		const [day] = await call<ArchiveStat[]>({ action: "stats", by: "day" });
		const local = new Date(at(1));
		const month = String(local.getMonth() + 1).padStart(2, "0");
		expect(day.key).toBe(`${local.getFullYear()}-${month}-${String(local.getDate()).padStart(2, "0")}`);
	});

	it("reads one transcript's newest records whole, oldest first", async () => {
		const results = await call<ArchiveMessage[]>({ action: "messages", id: sessionId, kinds: ["result"] });
		expect(results.map(message => [message.callId, message.isError])).toEqual([
			["c1", true],
			["c2", false],
			["c3", false],
		]);
		expect(results[1].text).toBe(`${"x".repeat(3000)}TAIL`);
		const newest = await call<ArchiveMessage[]>({ action: "messages", id: sessionId, limit: 2 });
		expect(newest.map(message => [message.kind, message.tool])).toEqual([
			["call", "bash"],
			["result", "bash"],
		]);
		const scout = await call<ArchiveMessage[]>({ action: "messages", id: subagentFile(mainFile, "Scout") });
		expect(scout.map(message => `${message.kind}`)).toEqual(["user", "call", "result"]);
	});

	it("renders a transcript whole when it fits, and terser as the budget shrinks", async () => {
		const whole = await call<ArchiveTranscript>({ action: "transcript", id: sessionId, budget: 100_000 });
		expect(whole.detail).toEqual({ user: "full", assistant: "full", thinking: "full", call: "full", result: "full" });
		expect(whole.text).toContain(`${"x".repeat(3000)}TAIL`);
		expect(whole.text).toContain('"command":"/usr/bin/sed -z s/a/b/ build.log"');

		const tight = await call<ArchiveTranscript>({ action: "transcript", id: sessionId, budget: 500 });
		expect(tight.text.length).toBeLessThanOrEqual(500);
		expect(tight.omitted).toBe(0);
		expect(tight.detail.result).toBe("omit");
		expect(tight.text).not.toContain("xxxxxxxxxx");
		expect(tight.text).toContain("clean the build");
		expect(tight.text).toContain("now the tests");
		// The failed sed call keeps its outcome even with results omitted.
		expect(tight.text).toMatch(/bash[^\n]*✗24/);
	});

	it("groups back-to-back lookups per tool, merging their paths by shared prefix", async () => {
		const id = `look-${crypto.randomUUID()}`;
		writeTranscript(sessionFile(app, id), id, app, [
			user(at(40), "explore"),
			assistant(at(41), [
				toolCall("r1", "read", { path: "src/a/x.ts:1-20" }),
				toolCall("r2", "read", { path: "src/a/y.ts" }),
				toolCall("g1", "grep", { pattern: "foo", path: "src" }),
				toolCall("r3", "read", { path: "src/b/z.ts" }),
				toolCall("r4", "read", { path: "src/a/x.ts:40-60" }),
				toolCall("b1", "bash", { command: "bun test" }),
				toolCall("r5", "read", { path: "src/c.ts" }),
				toolCall("b2", "bash", { command: "bun lint" }),
			]),
			toolResult(at(42), "r1", "read", "x".repeat(20)),
			toolResult(at(42), "r2", "read", "missing", true),
			toolResult(at(42), "g1", "grep", "hit"),
			toolResult(at(42), "r3", "read", "z"),
			toolResult(at(42), "r4", "read", "x"),
			toolResult(at(42), "b1", "bash", "ok"),
			toolResult(at(42), "r5", "read", "c"),
			toolResult(at(42), "b2", "bash", "fail", true),
		]);
		const normal = await call<ArchiveTranscript>({
			action: "transcript",
			id,
			detail: { call: "normal", result: "omit" },
		});
		// Lookups group only back to back; other calls keep their own lines.
		expect(normal.text).toContain(
			"call read ×4: src/{a/{x.ts, y.ts}, b/z.ts} · ✓29 (1 failed)\ncall grep: `foo` · ✓3\ncall bash: bun test · ✓2\ncall read: src/c.ts · ✓1\ncall bash: bun lint · ✗4",
		);
		// A brief run counts every call per tool.
		const brief = await call<ArchiveTranscript>({
			action: "transcript",
			id,
			detail: { call: "brief", result: "omit" },
		});
		expect(brief.text).toContain("calls: read ×5 ✓30 (1 failed), grep ✓3, bash ×2 ✓6 (1 failed)");
	});

	describe("on a long session", () => {
		let id: string;

		beforeEach(() => {
			id = `long-${crypto.randomUUID()}`;
			const entries: { timestamp: string }[] = [];
			for (let turn = 1; turn <= 12; turn++) {
				entries.push(
					user(at(turn * 3), `task ${turn}: ${"please ".repeat(30)}`),
					assistant(at(turn * 3 + 1), [
						{ type: "thinking", thinking: `ponder ${turn} `.repeat(40) },
						{
							type: "text",
							text: `Done ${turn}.\n\`\`\`ts\nconst secret${turn} = 1;\n\`\`\`\n<note>hidden${turn}</note> wrap-up`,
						},
						toolCall(`t${turn}`, "bash", { command: `run ${turn}` }),
					]),
					toolResult(at(turn * 3 + 2), `t${turn}`, "bash", "y".repeat(500)),
				);
			}
			writeTranscript(sessionFile(app, id), id, app, entries);
		});

		it("compacts every kind, then drops from the middle, keeping both ends", async () => {
			const view = await call<ArchiveTranscript>({ action: "transcript", id, budget: 1200 });
			expect(view.text.length).toBeLessThanOrEqual(1200);
			expect(view.detail).toEqual({
				user: "brief",
				assistant: "brief",
				thinking: "omit",
				call: "brief",
				result: "omit",
			});
			expect(view.omitted).toBeGreaterThan(0);
			expect(view.text).toMatch(/^#1 · .*task 1:/m);
			expect(view.text).toMatch(/^#12 · .*task 12:/m);
			expect(view.text).toMatch(/\[… \d+ records dropped, turns \d+–\d+\]/);
		});

		it("zooms into selected turns at pinned detail", async () => {
			const last = await call<ArchiveTranscript>({
				action: "transcript",
				id,
				turns: -1,
				detail: { result: "full" },
			});
			expect([last.turns, last.records, last.omitted]).toEqual([12, 5, 0]);
			expect(last.text).toStartWith("Transcript · turn 12 of 12");
			expect(last.text).not.toContain("#11");
			expect(last.text).toContain("y".repeat(500));
			expect(last.text).toContain("const secret12 = 1;");

			const brief = await call<ArchiveTranscript>({ action: "transcript", id, turns: [1, 2], detail: "brief" });
			expect(brief.text).toStartWith("Transcript · turns 1–2 of 12");
			expect(brief.text).toContain("call bash ✓500\nresult: yyy");
			expect(brief.text).toMatch(/^thinking: ponder 1 .*chars omitted/m);
			// Code and paired tags give way to placeholders.
			expect(brief.text).toContain("assistant: Done 1. [code, 1 line] <note/> wrap-up");
			expect(brief.text).not.toContain("secret1");
			expect(brief.text).not.toContain("hidden1");

			const recent = await call<ArchiveTranscript>({ action: "transcript", id, since: at(36) });
			expect(recent.text).toStartWith("Transcript · turn 12 of 12");
		});
	});
});

describe("archive prelude under session.storage: sql", () => {
	it("opens a session it lists by that session's id prefix", async () => {
		// What main.ts installs for `session.storage: sql`: the transcript lives only in the table.
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		setDefaultSessionStorage(storage);
		try {
			const at = "2024-06-01T00:00:00.000Z";
			const id = `sql-${crypto.randomUUID()}`;
			const file = path.join(sessionDirForCwd(app), `${new Date(at).getTime()}_${id}.jsonl`);
			await storage.writeText(file, sessionContent(id, at, app, { prompt: "sql work", answered: true }));

			const listed = await call<ArchiveSession[]>({ action: "sessions" });
			expect(listed.map(session => session.id)).toEqual([id]);
			const detail = await call<ArchiveSessionDetail>({ action: "session", id: id.slice(0, 12) });
			expect([detail.id, detail.file]).toEqual([id, file]);
		} finally {
			setDefaultSessionStorage(new FileSessionStorage());
			await client.end();
		}
	});
});
