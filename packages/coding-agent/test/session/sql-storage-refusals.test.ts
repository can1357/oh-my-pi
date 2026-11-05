/**
 * Features built on session files on disk, under file storage and under
 * `session.storage: sql`. Each row drives the feature's real entry point: on
 * file storage it runs past the storage check, and on SQL storage it refuses
 * with a message that names the storage and the reason. Commands that start
 * outside the root command must read the configured storage first, or they
 * see an empty file tree instead of the stored sessions.
 */
import { SQL } from "bun";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import * as stats from "@oh-my-pi/omp-stats";
import * as cleanse from "@oh-my-pi/pi-coding-agent/cleanse/index";
import type { CleanseCommandResult } from "@oh-my-pi/pi-coding-agent/cleanse/types";
import { GC_AUTO_COMPRESS_LOG, scheduleGcAutoCompress } from "@oh-my-pi/pi-coding-agent/cli/gc-auto-compress";
import * as gcCompress from "@oh-my-pi/pi-coding-agent/cli/gc-compress";
import Cleanse from "@oh-my-pi/pi-coding-agent/commands/cleanse";
import Complete from "@oh-my-pi/pi-coding-agent/commands/complete";
import Compress from "@oh-my-pi/pi-coding-agent/commands/compress";
import Session from "@oh-my-pi/pi-coding-agent/commands/session";
import Stats from "@oh-my-pi/pi-coding-agent/commands/stats";
import * as compress from "@oh-my-pi/pi-coding-agent/compress/index";
import type { CompressResult } from "@oh-my-pi/pi-coding-agent/compress/types";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { stopStatsDashboard } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/stats-dashboard";
import * as activityClient from "@oh-my-pi/pi-coding-agent/stats/activity-client";
import * as ternPage from "@oh-my-pi/pi-coding-agent/tools/browser/tern/user-page";
import * as openUtils from "@oh-my-pi/pi-coding-agent/utils/open";
import { getAgentDir, postmortem, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import type { Component, OverlayHandle, OverlayOptions } from "@oh-my-pi/pi-tui";
import * as theme from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import { rejectionOf } from "../helpers/rejection";

type Kind = "file" | "sql";

interface Fixture {
	kind: Kind;
	dir: TempDir;
	agentDir: string;
	cwd: string;
	storage: SessionStorage;
	/** Connection-string file `session.sql.dsnFile` names; SQL fixtures only. */
	dsnFile: string | undefined;
	sessionFile: string;
	sessionId: string;
}

const CLI_ENTRY = path.join(import.meta.dir, "..", "..", "src", "cli.ts");
const TEST_CONFIG = { bin: "omp", version: "0.0.0-test", commands: new Map() };
const SQL_REFUSAL = "is unavailable with session.storage: sql";
const STATS_REASON = "usage statistics are ingested from session files on disk";
const originalCwd = process.cwd();
const originalAgentDir = getAgentDir();
const originalEnv = {
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	OMP_SESSION_STORAGE: process.env.OMP_SESSION_STORAGE,
	OMP_SESSION_SQL_DSN_FILE: process.env.OMP_SESSION_SQL_DSN_FILE,
};
let previousStorage: SessionStorage;
let previousExitCode: typeof process.exitCode;
let fixture: Fixture | undefined;
const clients: SQL[] = [];

beforeEach(() => {
	previousStorage = defaultSessionStorage();
	previousExitCode = process.exitCode;
});

afterEach(async () => {
	vi.restoreAllMocks();
	process.chdir(originalCwd);
	process.exitCode = previousExitCode ?? 0;
	setAgentDir(originalAgentDir);
	for (const [name, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	setDefaultSessionStorage(previousStorage);
	for (const client of clients.splice(0)) await client.end();
	fixture?.dir.removeSync();
	fixture = undefined;
});

/**
 * A store holding one session for a project, selected the way a user selects
 * it (`OMP_SESSION_STORAGE`, and the connection-string file for SQL), with
 * the process in the project directory and the store installed as default.
 */
async function openFixture(kind: Kind): Promise<Fixture> {
	const dir = TempDir.createSync(`@omp-sql-refusals-${kind}-`);
	const agentDir = dir.join("agent");
	const cwd = dir.join("project");
	await Bun.write(path.join(cwd, ".keep"), "");
	setAgentDir(agentDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.OMP_SESSION_STORAGE = kind;
	let storage: SessionStorage;
	let dsnFile: string | undefined;
	if (kind === "file") {
		storage = new FileSessionStorage();
		delete process.env.OMP_SESSION_SQL_DSN_FILE;
	} else {
		const database = `sqlite:${dir.join("sessions.db")}`;
		dsnFile = dir.join("dsn");
		await Bun.write(dsnFile, `${database}\n`);
		process.env.OMP_SESSION_SQL_DSN_FILE = dsnFile;
		const client = new SQL(database);
		clients.push(client);
		storage = await SqlSessionStorage.create({ client });
	}
	const sessionId = `01a19bec-0000-7000-9000-00000000000${kind === "file" ? 1 : 2}`;
	const sessionFile = path.join(
		SessionManager.getDefaultSessionDir(cwd, undefined, storage),
		`2026-11-02T00-00-00-000Z_${sessionId}.jsonl`,
	);
	await storage.writeText(
		sessionFile,
		`${[
			{ type: "session", version: 3, id: sessionId, timestamp: "2026-11-02T00:00:00.000Z", cwd },
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-11-02T00:00:01.000Z",
				message: { role: "user", content: `stored in ${kind}`, timestamp: 1 },
			},
		]
			.map(entry => JSON.stringify(entry))
			.join("\n")}\n`,
	);
	await storage.drain();
	process.chdir(cwd);
	setDefaultSessionStorage(storage);
	fixture = { kind, dir, agentDir, cwd, storage, dsnFile, sessionFile, sessionId };
	return fixture;
}

function captureStderr(): () => string {
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	return () => stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
}

function captureStdout(): () => string {
	const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	return () => stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
}

for (const kind of ["file", "sql"] as const) {
	const refuses = kind === "sql";

	describe(`disk-only features on ${kind} storage`, () => {
		test(`omp stats ${refuses ? "refuses before ingesting session files" : "ingests and prints the summary"}`, async () => {
			await openFixture(kind);
			vi.spyOn(theme, "initTheme").mockResolvedValue();
			const sync = vi.spyOn(stats, "syncAllSessions").mockResolvedValue({ processed: 0, files: 0 });
			vi.spyOn(stats, "refreshRollups").mockResolvedValue();
			vi.spyOn(stats, "getTotalMessageCount").mockResolvedValue(0);
			const summary = vi.spyOn(stats, "printStatsSummary").mockResolvedValue();
			const stderr = captureStderr();

			await new Stats(["--summary"], TEST_CONFIG).run();

			if (refuses) {
				expect(stderr()).toContain(`omp stats ${SQL_REFUSAL}: ${STATS_REASON}`);
				expect(process.exitCode).toBe(1);
				expect(sync).not.toHaveBeenCalled();
			} else {
				expect(stderr()).not.toContain(SQL_REFUSAL);
				expect(summary).toHaveBeenCalledTimes(1);
			}
		});

		test(`/usage ${refuses ? "shows quotas but refuses the activity heatmap" : "loads the activity heatmap"}`, async () => {
			const fx = await openFixture(kind);
			await theme.initTheme(false);
			const activity = vi.spyOn(activityClient, "loadDailyActivity").mockImplementation(async push => {
				push([]);
			});
			const shown: Component[] = [];
			const ctx = createInteractiveModeContext({
				sessionManager: SessionManager.create(fx.cwd, path.dirname(fx.sessionFile), fx.storage),
				session: {
					model: undefined,
					getUsageReportingModelSelectors: () => [],
					fetchUsageReports: async () => null,
					modelRegistry: {
						authStorage: {
							credentials: { all: () => ({}) },
							usage: { providerFor: () => undefined },
							oauth: { identity: () => undefined },
						},
					},
				},
				ui: {
					showOverlay: (component: Component, _options?: OverlayOptions): OverlayHandle => {
						shown.push(component);
						return { hide: () => {}, setHidden: () => {}, isHidden: () => false };
					},
				},
			});

			// The dashboard starts its history load while it is built, so the outcome is known on return.
			new SelectorController(ctx).showUsageDashboard([{ provider: "anthropic", fetchedAt: Date.now(), limits: [] }]);

			// The dashboard opens either way: provider quotas do not come from session files.
			expect(shown).toHaveLength(1);
			const rendered = Bun.stripANSI(shown[0]?.render(160).join("\n") ?? "");
			if (refuses) {
				expect(rendered).toContain(`Usage history unavailable (/usage activity heatmap ${SQL_REFUSAL}`);
				expect(activity).not.toHaveBeenCalled();
			} else {
				expect(rendered).not.toContain("Usage history unavailable");
				expect(activity).toHaveBeenCalledTimes(1);
			}
		});

		test(`/trace ${refuses ? "refuses before starting the dashboard" : "opens the session trace"}`, async () => {
			const fx = await openFixture(kind);
			const server = vi
				.spyOn(stats, "startServer")
				.mockResolvedValue({ hostname: "127.0.0.1", port: 1, stop: () => {} });
			const errors: string[] = [];
			const statuses: string[] = [];
			const ctx = createInteractiveModeContext({
				sessionManager: SessionManager.create(fx.cwd, path.dirname(fx.sessionFile), fx.storage),
				session: { sessionFile: fx.sessionFile },
				showError: message => {
					errors.push(message);
				},
				showStatus: message => {
					statuses.push(message);
				},
			});
			const controller = new CommandController(ctx);
			vi.spyOn(controller, "openInBrowser").mockImplementation(() => {});

			await controller.handleTraceCommand();

			if (refuses) {
				expect(errors).toEqual([expect.stringContaining(`/trace ${SQL_REFUSAL}: ${STATS_REASON}`)]);
				expect(server).not.toHaveBeenCalled();
			} else {
				expect(errors).toEqual([]);
				expect(statuses).toEqual([`Trace: http://127.0.0.1:1/#/traces?s=${encodeURIComponent(fx.sessionFile)}`]);
			}
		});

		test(`/stats ${refuses ? "refuses before starting the dashboard" : "starts the dashboard"}`, async () => {
			const fx = await openFixture(kind);
			const server = vi
				.spyOn(stats, "startServer")
				.mockResolvedValue({ hostname: "127.0.0.1", port: 1, stop: () => {} });
			vi.spyOn(ternPage, "openTernPage").mockResolvedValue(null);
			vi.spyOn(openUtils, "openPath").mockImplementation(() => {});
			const errors: string[] = [];
			const ctx = createInteractiveModeContext({
				sessionManager: SessionManager.create(fx.cwd, path.dirname(fx.sessionFile), fx.storage),
				showError: message => {
					errors.push(message);
				},
			});

			try {
				await executeBuiltinSlashCommand("/stats", { ctx });
			} finally {
				stopStatsDashboard();
			}

			if (refuses) {
				expect(errors).toEqual([
					`Stats dashboard failed: /stats ${SQL_REFUSAL}: ${STATS_REASON}, and this store keeps sessions as database rows the stats ingester never reads`,
				]);
				expect(server).not.toHaveBeenCalled();
			} else {
				expect(errors).toEqual([]);
				expect(server).toHaveBeenCalledTimes(1);
			}
		});

		test(`/join ${refuses ? "refuses before stopping any hosting" : "proceeds to the link"}`, async () => {
			await openFixture(kind);
			let stops = 0;
			const errors: string[] = [];
			const ctx = createInteractiveModeContext({
				collabController: {
					host: undefined,
					stop: async () => {
						stops += 1;
					},
				},
				showError: message => {
					errors.push(message);
				},
			});

			await executeBuiltinSlashCommand("/join not-a-collab-link", { ctx });

			if (refuses) {
				expect(errors).toEqual([
					expect.stringContaining(`/join ${SQL_REFUSAL}: collab replicas are local session files`),
				]);
				expect(stops).toBe(0);
			} else {
				// Past the storage check: pending starts are cancelled and the malformed link is what fails.
				expect(stops).toBe(1);
				expect(errors).toEqual([expect.stringMatching(/^Failed to join collab session: /)]);
				expect(errors.join("")).not.toContain(SQL_REFUSAL);
			}
		});

		test(`gc.autoCompress ${refuses ? "logs a refusal instead of launching" : "goes on to the volume check"}`, async () => {
			const fx = await openFixture(kind);
			const probe = vi.spyOn(gcCompress, "compressMethod").mockResolvedValue(undefined);

			expect(await scheduleGcAutoCompress(fx.agentDir)).toBeUndefined();

			const log = await Bun.file(path.join(fx.agentDir, GC_AUTO_COMPRESS_LOG)).text();
			if (refuses) {
				expect(log).toContain(`gc.autoCompress ${SQL_REFUSAL}: compression rewrites session files on disk`);
				expect(probe).not.toHaveBeenCalled();
			} else {
				expect(log).toContain("compress skipped: unsupported");
				expect(probe).toHaveBeenCalledTimes(1);
			}
		});

		for (const action of ["pack", "unpack", "moved"] as const) {
			test(`omp session ${action} ${refuses ? "refuses" : "goes on to its arguments"}`, async () => {
				await openFixture(kind);
				const stderr = captureStderr();

				const outcome = await new Session([action], TEST_CONFIG).run().then(
					() => undefined,
					(error: unknown) => error,
				);

				if (refuses) {
					expect(outcome).toBeUndefined();
					expect(stderr()).toContain(`omp session ${action} ${SQL_REFUSAL}`);
					expect(process.exitCode).toBe(1);
				} else {
					// The storage check passed: the missing argument is what stops it.
					expect(String(outcome)).toMatch(/Missing (session|archive)\. Usage: omp session/);
				}
			});
		}

		test(`omp session lease ${refuses ? "refuses" : "reports the probe"}`, async () => {
			await openFixture(kind);
			const stderr = captureStderr();
			const stdout = captureStdout();

			await new Session(["lease", "--json", "--", "no-such-session"], TEST_CONFIG).run();

			if (refuses) {
				expect(stderr()).toContain(`omp session lease ${SQL_REFUSAL}: SQL-stored sessions take no ownership lease`);
				expect(stdout()).toBe("");
			} else {
				expect(JSON.parse(stdout())).toEqual({ held: [], unknown: [] });
			}
		});

		test(`RPC get_session_lease ${refuses ? "answers with the refusal" : "reports the probe"}`, async () => {
			const fx = await openFixture(kind);
			const env: Record<string, string> = {
				HOME: fx.dir.join("home"),
				XDG_CONFIG_HOME: fx.dir.join("config"),
				XDG_DATA_HOME: fx.dir.join("data"),
				XDG_CACHE_HOME: fx.dir.join("cache"),
				PI_CODING_AGENT_DIR: fx.agentDir,
				PI_NO_TITLE: "1",
				// RPC mode needs a model to start; no request ever reaches the provider.
				ANTHROPIC_API_KEY: "test-key",
				OMP_SESSION_STORAGE: kind,
			};
			if (fx.dsnFile) env.OMP_SESSION_SQL_DSN_FILE = fx.dsnFile;
			const client = new RpcClient({
				command: [process.execPath, CLI_ENTRY],
				cwd: fx.cwd,
				env,
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				args: ["--no-lsp", "--no-extensions", "--no-tools"],
			});
			try {
				await client.start();
				if (refuses) {
					expect(await rejectionOf(client.getSessionLease(["no-such-session"]))).toMatchObject({
						message: expect.stringContaining(
							`get_session_lease ${SQL_REFUSAL}: SQL-stored sessions take no ownership lease`,
						),
					});
				} else {
					expect(await client.getSessionLease(["no-such-session"])).toEqual({ held: [], unknown: [] });
				}
			} finally {
				await client.stop();
			}
		}, 120_000);
	});
}

describe("commands outside the root command read the configured storage", () => {
	// cleanse and compress create sessions, and completion lists them: none of
	// them is file-only, so each must see the SQL rows rather than refuse.
	test("cleanse, compress, and session completion see the SQL row, not the empty file tree", async () => {
		const fx = await openFixture("sql");
		// The process starts on the file store, as a command outside the root command does.
		setDefaultSessionStorage(new FileSessionStorage());
		vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
		const seen: string[] = [];
		vi.spyOn(cleanse, "runCleanseCommand").mockImplementation(async (): Promise<CleanseCommandResult> => {
			seen.push(await defaultSessionStorage().readText(fx.sessionFile));
			return { exitCode: 0, status: "clean", report: { checks: [], diagnostics: [], skipped: [] } };
		});
		vi.spyOn(compress, "runCompressCommand").mockImplementation(async (): Promise<CompressResult> => {
			seen.push(await defaultSessionStorage().readText(fx.sessionFile));
			return { exitCode: 0, files: [], sourceTokens: 0, draftTokens: 0 };
		});

		await new Cleanse(["--all"], TEST_CONFIG).run();
		setDefaultSessionStorage(new FileSessionStorage());
		await new Compress(["note.md"], TEST_CONFIG).run();
		setDefaultSessionStorage(new FileSessionStorage());
		const stdout = captureStdout();
		await new Complete(["sessions"], TEST_CONFIG).run();

		expect(seen).toEqual([expect.stringContaining("stored in sql"), expect.stringContaining("stored in sql")]);
		expect(stdout()).toBe(`${fx.sessionId}\tstored in sql\n`);
	});
});
