import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ArchiveProject,
	ArchivePrompt,
	ArchiveRecap,
	ArchiveSession,
	ArchiveSessionDetail,
} from "@oh-my-pi/pi-coding-agent/archive/archive";
import { createArchivePrelude } from "@oh-my-pi/pi-coding-agent/archive/prelude-definition";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { recordSessionRecap, resetSessionIndexForTests } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { sessionDirForCwd } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage, setDefaultSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { makeAssistantMessage } from "./session-manager/helpers";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let root: string;
let app: string;
let lib: string;

/** JSONL transcript of session `id`, created at `at` in `cwd`. */
function sessionContent(
	id: string,
	at: string,
	cwd: string,
	options: { prompt?: string; answered?: boolean } = {},
): string {
	const entries: unknown[] = [{ type: "session", version: 3, id, timestamp: at, cwd }];
	if (options.prompt) {
		entries.push({
			type: "message",
			id: "u1",
			parentId: null,
			message: { role: "user", content: options.prompt, timestamp: 1 },
		});
	}
	if (options.answered) {
		entries.push({ type: "message", id: "a1", parentId: "u1", message: makeAssistantMessage() });
	}
	return `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
}

/** Writes a session file with mtime `at` and an id starting with `label`; returns the id. */
function writeSession(
	cwd: string,
	label: string,
	at: string,
	options: { prompt?: string; answered?: boolean } = {},
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
	resetSessionIndexForTests();
	setAgentDir(path.join(root, "agent"));
});

afterEach(() => {
	HistoryStorage.close();
	resetSessionIndexForTests();
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
		expect(local.map(session => [session.id, session.recap])).toEqual([
			[newApp, "second recap"],
			[oldApp, undefined],
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
		// Infix tokens miss the FTS prefix index and exercise the substring path.
		expect(texts(await call({ action: "prompts", query: "chiv", project: lib }))).toEqual(["archive cleanup"]);
	});

	it("lists recaps newest first within scope", async () => {
		const recaps = (list: ArchiveRecap[]) => list.map(recap => recap.text);
		expect(recaps(await call({ action: "recaps" }))).toEqual(["second recap", "first recap"]);
		expect(recaps(await call({ action: "recaps", project: "*", limit: 2 }))).toEqual(["lib recap", "second recap"]);
	});

	it("rejects misspelled options instead of falling back to the default scope", async () => {
		await expect(call({ action: "sessions", projects: "*" })).rejects.toThrow("invalid arguments");
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
