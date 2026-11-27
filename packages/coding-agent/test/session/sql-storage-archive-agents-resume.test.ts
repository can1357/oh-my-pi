/**
 * Features that once read only the session files on disk, run under every
 * session storage: `archive.search`, the archive's message counts and its
 * listing, `agent://<pid>` and `agent://<pid>/<id>` for another instance's
 * agents, and resuming a session whose recorded folder is gone. Under
 * `session.storage: sql` the transcript is a table row, so a disk read finds
 * nothing, and another process's rows show only after a refresh. The
 * transcript index per store is in `sql-transcript-index-per-store.test.ts`.
 *
 * Runs against file storage and SQLite always, and against PostgreSQL and
 * MySQL when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a
 * throwaway database. Every SQL test uses its own table and drops it when done.
 */
import { $, SQL } from "bun";
import { beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArchiveSearchHit, ArchiveSession } from "@oh-my-pi/pi-coding-agent/archive/archive";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { syncTranscripts } from "@oh-my-pi/pi-coding-agent/daemon/modules/transcripts";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import * as mesh from "@oh-my-pi/pi-coding-agent/irc/mesh";
import { createSessionManager, runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { sessionDirForCwd, writeTerminalBreadcrumb } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import {
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { createSessionWorktree } from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { setProjectDir } from "@oh-my-pi/pi-utils";
import {
	AT,
	archive,
	BACKENDS,
	header,
	longTranscript,
	message,
	SQL_BACKENDS,
	storeSession,
	useSqlSessionTestEnv,
} from "../helpers/sql-session-archive";
import { makeAssistantMessage } from "../session-manager/helpers";

const env = useSqlSessionTestEnv("@omp-sql-archive-agents-resume-");

describe("the session archive over the session storage", () => {
	it.each(BACKENDS)(
		"archive.search finds a session the %s storage holds by its transcript, and a line added after a sync",
		async backend => {
			const { storage } = await env.installBackend(backend);
			const project = env.tempDir.join("project");
			const later = "2026-03-01T00:00:01.000Z";
			const id = `search-${crypto.randomUUID()}`;
			const content =
				header(id, project, AT) +
				message("u1", null, AT, "user", "plan the quarterly migration") +
				message("a1", "u1", later, "assistant", "The quarterly migration runs on Friday.");
			const file = await storeSession(storage, project, id, AT, content);
			const found = (hits: ArchiveSearchHit[]) =>
				hits.map(hit => [hit.id, hit.matches.map(m => [m.source, m.text])]);

			expect(await syncTranscripts()).toEqual({ outcome: "synced", files: 1, messages: 2 });
			expect(found(await archive({ action: "search", query: "quarterly migration" }, project))).toEqual([
				[
					id,
					[
						["assistant", "The quarterly migration runs on Friday."],
						["user", "plan the quarterly migration"],
					],
				],
			]);

			// The next sync reads on from where the last one stopped.
			await storage.writeText(file, content + message("u2", "a1", later, "user", "also rotate the signing keys"));
			expect(await syncTranscripts()).toEqual({ outcome: "synced", files: 1, messages: 1 });
			expect(found(await archive({ action: "search", query: "signing keys" }, project))).toEqual([
				[id, [["user", "also rotate the signing keys"]]],
			]);
		},
	);

	it.each(BACKENDS)("counts every message of a long session the %s storage holds", async backend => {
		const { storage } = await env.installBackend(backend);
		const project = env.tempDir.join("project");
		const id = `count-${crypto.randomUUID()}`;
		// 60 messages, far past the 4 KiB prefix a listing parses.
		let content = header(id, project, AT);
		let parent: string | null = null;
		for (let turn = 0; turn < 30; turn++) {
			content += message(`u${turn}`, parent, AT, "user", `question ${turn}: ${"why ".repeat(20)}`);
			content += message(`a${turn}`, `u${turn}`, AT, "assistant", `answer ${turn}: ${"because ".repeat(15)}`);
			parent = `a${turn}`;
		}
		await storeSession(storage, project, id, AT, content);

		const sessions = await archive<ArchiveSession[]>({ action: "sessions" }, project);
		expect(sessions.map(session => [session.id, session.messages])).toEqual([[id, 60]]);
	});

	it.each(SQL_BACKENDS)(
		"lists and counts a %s-stored transcript several read windows long without ever reading it whole",
		async backend => {
			const { storage } = await env.installBackend(backend);
			const project = env.tempDir.join("project");
			const id = `windows-${crypto.randomUUID()}`;
			const { content, messages } = longTranscript(id, project);
			const file = await storeSession(storage, project, id, AT, content);
			const whole = Buffer.byteLength(content, "utf-8");
			const readWhole = vi.spyOn(storage, "readText");
			const readFrom = storage.readTextFrom!.bind(storage);
			const windows: number[] = [];
			vi.spyOn(storage, "readTextFrom").mockImplementation(async (key, offset, maxBytes) => {
				const read = await readFrom(key, offset, maxBytes);
				if (key === file) windows.push(Buffer.byteLength(read.text, "utf-8"));
				return read;
			});

			const sessions = await archive<ArchiveSession[]>({ action: "sessions" }, project);

			expect(sessions.map(session => [session.id, session.messages])).toEqual([[id, messages]]);
			expect(readWhole.mock.calls.filter(([key]) => key === file)).toEqual([]);
			expect(windows.length).toBeGreaterThan(1);
			expect(Math.max(...windows)).toBeLessThan(whole);
		},
	);

	it("lists a SQLite session whose first prompt outgrows the listing's prefix without reading it whole", async () => {
		const { storage } = await env.installBackend("sqlite");
		const project = env.tempDir.join("project");
		const manager = SessionManager.create(project, undefined, storage);
		// A pasted log longer than the 4 KiB the listing reads first, then long replies.
		manager.appendMessage({ role: "user", content: `please review this log: ${"x".repeat(6000)}`, timestamp: 1 });
		for (let i = 0; i < 24; i++) {
			manager.appendMessage({
				...makeAssistantMessage(),
				content: [{ type: "text", text: `reply ${i} ${"y".repeat(100_000)}` }],
			});
			manager.appendMessage({ role: "user", content: `turn ${i}`, timestamp: 2 + i });
		}
		await manager.flush();
		const file = manager.getSessionFile()!;
		await manager.close();
		await storage.refresh?.();
		const readWhole = vi.spyOn(storage, "readText");

		const archived = await archive<ArchiveSession[]>({ action: "sessions" }, project);
		closeSessionIndex();
		const picked = await SessionManager.list(project, undefined, storage);

		expect(archived.map(session => session.id)).toEqual([manager.getSessionId()]);
		expect(picked.map(session => session.path)).toEqual([file]);
		expect(readWhole.mock.calls.filter(([key]) => key === file)).toEqual([]);
	});
});

describe("agent://<pid> over the session storage", () => {
	/** The peer instance `pid`, whose main session is `sessionFile`, as the agent mesh reports it. */
	function meshPeer(pid: number, sessionFile: string): void {
		spyOn(mesh, "agentMesh").mockReturnValue({
			peer: (asked: number) => (asked === pid ? { pid, status: "idle", sessionFile, agents: [] } : undefined),
			peers: () => [],
		} as never);
	}

	it.each(BACKENDS)(
		"reads another instance's subagent from the transcript its own %s client wrote after this store loaded",
		async backend => {
			const { connect } = await env.installBackend(backend);
			// The peer instance writes through its own client, after this process's store loaded.
			const peer = await connect();
			const project = env.tempDir.join("project");
			const peerSession = await storeSession(
				peer,
				project,
				`peer-${crypto.randomUUID()}`,
				AT,
				header("peer-main", project, AT),
			);
			// The peer's roster no longer lists the subagent: only its transcript is left.
			const transcript = path.join(peerSession.slice(0, -".jsonl".length), "Worker.jsonl");
			peer.ensureDirSync(path.dirname(transcript));
			await peer.writeText(
				transcript,
				header("worker", project, AT) +
					message("u1", null, AT, "user", "find the race") +
					message("a1", "u1", AT, "assistant", "The race is in the flush path."),
			);
			const pid = process.pid + 1;
			meshPeer(pid, peerSession);

			const resource = await new AgentProtocolHandler().resolve(parseInternalUrl(`agent://${pid}/Worker`), {
				settings: Settings.isolated({ "task.crossInstance": true }),
			});
			expect(resource.content).toContain("The race is in the flush path.");
			expect(resource.notes).toEqual([
				"No published output; progress from session file (read-only) (not registered)",
			]);
		},
	);

	it.each(BACKENDS)(
		"reads another instance's main agent from the session its own %s client wrote after this store loaded",
		async backend => {
			const { connect } = await env.installBackend(backend);
			const peer = await connect();
			const project = env.tempDir.join("project");
			const peerSession = await storeSession(
				peer,
				project,
				`peer-${crypto.randomUUID()}`,
				AT,
				header("peer-main", project, AT) +
					message("u1", null, AT, "user", "main question") +
					message("a1", "u1", AT, "assistant", "Main answer from the peer."),
			);
			const pid = process.pid + 2;
			meshPeer(pid, peerSession);

			const resource = await new AgentProtocolHandler().resolve(parseInternalUrl(`agent://${pid}`), {
				settings: Settings.isolated({ "task.crossInstance": true }),
			});
			expect(resource.content).toContain("Main answer from the peer.");
		},
	);
});

describe.skipIf(process.platform === "win32")("resuming a session whose folder is gone", () => {
	const GIT_ENV = {
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
	};
	let repo: string;

	beforeEach(async () => {
		Object.assign(process.env, GIT_ENV, { OMP_WORKTREE_DIR: env.tempDir.join("wt-base") });
		repo = env.tempDir.join("repo");
		fs.mkdirSync(repo, { recursive: true });
		await $`git init -q && git commit -q --allow-empty -m init`.cwd(repo).quiet();
	});

	/** A session written in a `/wt` worktree that `omp worktree clear` then removed; `writer` keeps it open. */
	async function strandedSession(
		storage: SessionStorage,
	): Promise<{ writer: SessionManager; file: string; id: string }> {
		const { path: worktree } = await createSessionWorktree(repo, Settings.isolated(), "wt/gone");
		const writer = SessionManager.create(worktree, undefined, storage);
		writer.appendMessage({ role: "user", content: "work in the worktree", timestamp: 1 });
		writer.appendMessage(makeAssistantMessage());
		await writer.flush();
		await $`git worktree remove --force ${worktree} && git worktree prune`.cwd(repo).quiet();
		return { writer, file: writer.getSessionFile()!, id: writer.getSessionId() };
	}

	function textsOf(entries: FileEntry[]): string[] {
		return entries.flatMap(entry =>
			entry.type === "message" && entry.message.role === "user" && typeof entry.message.content === "string"
				? [entry.message.content]
				: [],
		);
	}

	it("--resume moves a removed worktree's session into the checkout without asking under file storage", async () => {
		const { storage } = await env.installBackend("file");
		const { writer, file, id } = await strandedSession(storage);
		await writer.close();
		const asked: string[] = [];

		const resumed = await createSessionManager(
			parseArgs(["--resume", id.slice(0, 13)]),
			repo,
			Settings.isolated(),
			async session => {
				asked.push(session.id);
				return "accepted";
			},
		);
		try {
			expect(asked).toEqual([]);
			expect(path.dirname(resumed!.getSessionFile()!)).toBe(SessionManager.getDefaultSessionDir(repo));
			expect(fs.existsSync(file)).toBe(false);
		} finally {
			await resumed?.close();
		}
	});

	it.each(SQL_BACKENDS)(
		"--resume leaves a removed worktree's session where %s stores it while another process writes it",
		async backend => {
			const { storage, connect } = await env.installBackend(backend);
			// The omp that was running in the worktree, with its own client of the store.
			const { writer, file, id } = await strandedSession(await connect());
			const asked: string[] = [];

			const resumed = await createSessionManager(
				parseArgs(["--resume", id.slice(0, 13)]),
				repo,
				Settings.isolated(),
				async session => {
					asked.push(session.id);
					return "accepted";
				},
			);
			try {
				expect(resumed!.getSessionFile()).toBe(file);
				expect(asked).toEqual([]);
				// That process writes on, and the resumed session reads what it wrote.
				writer.appendMessage({ role: "user", content: "the writer went on", timestamp: 2 });
				await writer.flush();
				await storage.refresh?.();
				expect(textsOf(await loadEntriesFromFile(resumed!.getSessionFile()!, storage))).toEqual([
					"work in the worktree",
					"the writer went on",
				]);
			} finally {
				await resumed?.close();
				await writer.close();
			}
		},
	);

	it("the start-up resume picker opens a removed worktree's session where SQLite stores it", async () => {
		// What `session.storage: sql` with a SQLite connection file installs at start.
		const database = env.tempDir.join("picker.db");
		const dsnFile = env.tempDir.join("session.dsn");
		fs.writeFileSync(dsnFile, `sqlite:${database}`);
		Object.assign(process.env, { OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: dsnFile });
		const client = new SQL(`sqlite:${database}`);
		env.clients.push(client);
		const { writer, file } = await strandedSession(await SqlSessionStorage.create({ client }));
		await writer.close();
		setProjectDir(repo);
		const opened: string[] = [];
		const relocated: string[] = [];
		class Chosen extends Error {}
		vi.spyOn(SessionManager, "openRelocated").mockImplementation(async sessionPath => {
			relocated.push(sessionPath);
			throw new Chosen();
		});
		const open = SessionManager.open.bind(SessionManager);
		vi.spyOn(SessionManager, "open").mockImplementation(async (sessionPath, ...rest) => {
			if (sessionPath !== file) return open(sessionPath, ...rest);
			opened.push(sessionPath);
			throw new Chosen();
		});
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code ?? 0})`);
		}) as typeof process.exit);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const authStorage = await AuthStorage.create(env.tempDir.join("auth.db"));
		const parsed = parseArgs(["--resume", "--print"]);
		Object.assign(parsed, { noExtensions: true, noSkills: true, noRules: true, noTools: true, noLsp: true });

		try {
			await expect(
				runRootCommand(parsed, ["--resume", "--print"], {
					discoverAuthStorage: async () => authStorage,
					settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
					selectSession: async () => ({ path: file }) as SessionInfo,
				}),
			).rejects.toBeInstanceOf(Chosen);
		} finally {
			authStorage.close();
		}
		expect({ opened, relocated }).toEqual({ opened: [file], relocated: [] });
	}, 30_000);

	it.each(SQL_BACKENDS)(
		"the in-session resume picker resumes a removed worktree's session where %s stores it",
		async backend => {
			const { storage, connect } = await env.installBackend(backend);
			const { writer, file } = await strandedSession(await connect());
			await writer.close();
			await storage.refresh?.();
			const relocated: string[] = [];
			vi.spyOn(SessionManager, "openRelocated").mockImplementation(async sessionPath => {
				relocated.push(sessionPath);
				throw new Error("moved");
			});
			const switchSession = vi.fn(async (_sessionPath: string) => false);
			const settings = Settings.isolated();
			vi.spyOn(settings, "flush").mockImplementation(async () => {});
			const ctx = {
				session: { switchSession },
				sessionManager: {
					getCwd: () => repo,
					getSessionDir: () => SessionManager.getDefaultSessionDir(repo),
					getSessionFile: () => undefined,
					getStorage: () => storage,
				},
				settings,
				prepareSessionSwitch: vi.fn(async () => {}),
				resetObserverRegistry: vi.fn(),
				showError: vi.fn(),
			} as unknown as InteractiveModeContext;

			await new SelectorController(ctx).handleResumeSession(file);

			expect({ switched: switchSession.mock.calls.map(([sessionPath]) => sessionPath), relocated }).toEqual({
				switched: [file],
				relocated: [],
			});
		},
	);

	it.each(SQL_BACKENDS)(
		"--continue after the project folder was renamed continues the session where %s stores it",
		async backend => {
			process.env.TMUX_PANE = "%sql-continue-rename";
			const { storage, connect } = await env.installBackend(backend);
			const before = env.tempDir.join("project-before");
			const after = env.tempDir.join("project-after");
			fs.mkdirSync(before);
			const writer = SessionManager.create(before, undefined, await connect());
			writer.appendMessage({ role: "user", content: "work before the rename", timestamp: 1 });
			writer.appendMessage(makeAssistantMessage());
			await writer.flush();
			const file = writer.getSessionFile()!;
			writeTerminalBreadcrumb(before, file);
			// `mv`: the same directory at a new path, the evidence of a rename `--continue` looks for.
			fs.renameSync(before, after);
			// A launch's store starts with what other clients committed before it.
			await storage.refresh?.();

			const resumed = await SessionManager.continueRecent(after, undefined, storage);
			try {
				expect(resumed.getSessionFile()).toBe(file);
				writer.appendMessage({ role: "user", content: "the writer went on", timestamp: 2 });
				await writer.flush();
				await storage.refresh?.();
				expect(textsOf(await loadEntriesFromFile(file, storage))).toEqual([
					"work before the rename",
					"the writer went on",
				]);
			} finally {
				await resumed.close();
				await writer.close();
			}
		},
	);

	it.each(SQL_BACKENDS)(
		"--continue resumes the terminal's last session when another %s client wrote it after this store loaded",
		async backend => {
			process.env.TMUX_PANE = "%sql-continue-breadcrumb";
			const { storage, connect } = await env.installBackend(backend);
			const project = env.tempDir.join("project");
			fs.mkdirSync(project);
			// Another omp process ran this terminal's last session, then another terminal's newer one.
			const other = await connect();
			const turn = (text: string) =>
				message("u1", null, AT, "user", text) + message("a1", "u1", AT, "assistant", "noted");
			const file = await storeSession(
				other,
				project,
				`last-${crypto.randomUUID()}`,
				AT,
				header("last-session", project, AT) + turn("this terminal"),
			);
			await storeSession(
				other,
				project,
				`newer-${crypto.randomUUID()}`,
				"2026-03-02T00:00:00.000Z",
				header("newer-session", project, AT) + turn("another terminal"),
			);
			writeTerminalBreadcrumb(project, file);

			const resumed = await SessionManager.continueRecent(project, undefined, storage);
			try {
				expect(resumed.getSessionFile()).toBe(file);
			} finally {
				await resumed.close();
			}
		},
	);

	it.each(SQL_BACKENDS)(
		"--continue looks the terminal's last session up in the %s store it was given, not in the process default",
		async backend => {
			process.env.TMUX_PANE = "%sql-continue-given-store";
			// An SDK host that resumes from its own store while the process default stays file storage.
			setDefaultSessionStorage(new FileSessionStorage());
			const storage = await env.backendOpener(backend)();
			const project = env.tempDir.join("project");
			fs.mkdirSync(project);
			const turn = message("u1", null, AT, "user", "last turn") + message("a1", "u1", AT, "assistant", "noted");
			const file = await storeSession(
				storage,
				project,
				"given-store",
				AT,
				header("given-store", project, AT) + turn,
			);
			// Another terminal's newer session, which a pick by time would take instead.
			const newer = "2026-03-02T00:00:00.000Z";
			await storeSession(storage, project, "given-newer", newer, header("given-newer", project, newer) + turn);
			writeTerminalBreadcrumb(project, file);

			const resumed = await SessionManager.continueRecent(project, undefined, storage);
			try {
				expect(resumed.getSessionFile()).toBe(file);
			} finally {
				await resumed.close();
			}
		},
	);

	it.each(SQL_BACKENDS)(
		"--resume <id> from a renamed folder offers the move of a %s-stored session, and accepting files it there",
		async backend => {
			const { storage } = await env.installBackend(backend);
			const before = env.tempDir.join("project-before");
			const after = env.tempDir.join("project-after");
			fs.mkdirSync(before);
			const writer = SessionManager.create(before, undefined, storage);
			writer.appendMessage({ role: "user", content: "work before the rename", timestamp: 1 });
			writer.appendMessage(makeAssistantMessage());
			await writer.flush();
			const file = writer.getSessionFile()!;
			const id = writer.getSessionId();
			await writer.close();
			fs.renameSync(before, after);
			setProjectDir(after);
			const asked: string[] = [];

			const resumed = await createSessionManager(
				parseArgs(["--resume", id.slice(0, 13)]),
				after,
				Settings.isolated(),
				async session => {
					asked.push(session.id);
					return "accepted";
				},
			);
			try {
				expect(asked).toEqual([id]);
				expect(path.dirname(resumed!.getSessionFile()!)).toBe(sessionDirForCwd(after));
				expect(storage.existsSync(file)).toBe(false);
			} finally {
				await resumed?.close();
			}
		},
	);
});
