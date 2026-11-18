/**
 * `omp --resume <id>` of a session whose recorded directory no longer exists.
 *
 * The protocol modes (`--mode rpc`, `--mode rpc-ui`, `--mode acp`) own standard
 * input and standard output, so no question can be asked there: they open the
 * session where it is stored, with the launch directory as its working
 * directory, as `--resume <path>` does. Interactive mode still asks whether to
 * move the session, print mode without a terminal still fails, a session from a
 * removed worktree is still moved with no question, and the path, continue,
 * automatic-resume and fork routes never reach the question.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readlinePromises from "node:readline/promises";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { createSessionManager, runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import * as rpcInputModule from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-input";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSessionWorktree } from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import {
	__resetDirsFromEnvForTests,
	getProjectDir,
	isEnoent,
	isInteractiveHost,
	normalizePathForComparison,
	setAgentDir,
	setInteractiveHost,
	setProjectDir,
	TempDir,
} from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { restoreEnvValue } from "./helpers/settings-test-state";
import { makeAssistantMessage } from "./session-manager/helpers";

class ProcessExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
		this.name = "ProcessExitSignal";
	}
}

/** Thrown where startup hands its session to the mode runner: everything under test happened before. */
class StopSignal extends Error {
	constructor() {
		super("stop before the mode runner");
		this.name = "StopSignal";
	}
}

const QUIET_FLAGS = ["--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-lsp"];

/** Variables a test or `runRootCommand` sets; each is put back after every test. */
const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_PROFILE",
	"OMP_PROFILE",
	"PI_NO_PTY",
	"PI_NO_TITLE",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
	"OMP_WORKTREE_DIR",
] as const;

let tempDir: TempDir;
let root: string;
let originalEnv: Record<string, string | undefined>;
let originalProject: string;
let originalInteractiveHost: boolean;
let originalIsTTY: PropertyDescriptor | undefined;
/** What the move question gets as its answer, if it is asked at all. */
let answer: string;
let exitCodes: number[];
let stdoutWrites: string[];
let stderrWrites: string[];
const managers = new Set<SessionManager>();
let createInterface: Mock<typeof readlinePromises.createInterface>;
let openSpy: Mock<typeof SessionManager.open>;
let openRelocatedSpy: Mock<typeof SessionManager.openRelocated>;

beforeEach(() => {
	originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	originalProject = getProjectDir();
	originalInteractiveHost = isInteractiveHost();
	originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	tempDir = TempDir.createSync("@omp-resume-missing-cwd-");
	root = fs.realpathSync(tempDir.path());
	setAgentDir(path.join(root, "agent"));
	answer = "n";
	exitCodes = [];
	stdoutWrites = [];
	stderrWrites = [];

	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		exitCodes.push(code ?? 0);
		throw new ProcessExitSignal(code ?? 0);
	}) as typeof process.exit);
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdoutWrites.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderrWrites.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	});
	// Without a terminal, print and interactive startup read a piped prompt; the runner's stdin may never end.
	vi.spyOn(Bun.stdin, "text").mockResolvedValue("");
	// RPC startup claims stdin's single reader, which a test process can do only once.
	vi.spyOn(rpcInputModule, "claimRpcInput").mockImplementation(() => new ReadableStream<Uint8Array>());
	const fakeReadline = { question: async () => answer, close: () => {} } as unknown as readlinePromises.Interface;
	createInterface = vi.spyOn(readlinePromises, "createInterface").mockReturnValue(fakeReadline);
	openSpy = vi.spyOn(SessionManager, "open");
	openRelocatedSpy = vi.spyOn(SessionManager, "openRelocated");
});

afterEach(async () => {
	for (const result of openSpy.mock.results) {
		if (result.type !== "return") continue;
		const manager = await result.value.catch(() => undefined);
		if (manager) managers.add(manager);
	}
	for (const manager of managers) await manager.close().catch(() => undefined);
	managers.clear();
	vi.restoreAllMocks();
	if (originalIsTTY) Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
	else Reflect.deleteProperty(process.stdin, "isTTY");
	setInteractiveHost(originalInteractiveHost);
	themeModule.stopThemeWatcher();
	// `runRootCommand` registers the CLI's extension roots (`--no-extensions` → explicit-only) process-wide.
	clearOmpExtensionCliRoots();
	setProjectDir(originalProject);
	for (const key of ENV_KEYS) restoreEnvValue(key, originalEnv[key]);
	__resetDirsFromEnvForTests();
	await tempDir.remove();
});

function normalized(file: string | undefined): string | undefined {
	return file === undefined ? undefined : normalizePathForComparison(file);
}

/** The working directory a session file's header records. */
async function headerCwd(file: string | undefined): Promise<string | undefined> {
	if (!file) return undefined;
	const entries = await loadEntriesFromFile(file);
	return entries.find((entry): entry is SessionHeader => entry.type === "session")?.cwd;
}

/** Names of the session files directly in `dir`. */
async function sessionFiles(dir: string): Promise<string[]> {
	try {
		return (await fs.promises.readdir(dir)).filter(name => name.endsWith(".jsonl"));
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

/** A session with one answered turn, written to `cwd`'s session directory (or `sessionDir`) and left open. */
async function answeredManager(cwd: string, sessionDir?: string): Promise<SessionManager> {
	const manager = SessionManager.create(cwd, sessionDir);
	manager.appendMessage({ role: "user", content: `work in ${cwd}`, timestamp: 1 });
	manager.appendMessage(makeAssistantMessage());
	await manager.flush();
	return manager;
}

/** A session with one answered turn, written to `cwd`'s session directory (or `sessionDir`) and closed. */
async function answeredSession(cwd: string, sessionDir?: string): Promise<{ file: string; id: string }> {
	const manager = await answeredManager(cwd, sessionDir);
	const file = manager.getSessionFile();
	await manager.close();
	if (!file) throw new Error("Expected a persisted session file");
	return { file, id: manager.getSessionId() };
}

/** The manager `SessionManager.open` returned for `file`. */
async function openedManager(file: string): Promise<SessionManager | undefined> {
	const index = openSpy.mock.calls.findIndex(([opened]) => normalized(opened) === normalized(file));
	const result = openSpy.mock.results[index];
	return result?.type === "return" ? await result.value : undefined;
}

/** The manager `SessionManager.openRelocated` returned. */
async function relocatedManager(): Promise<SessionManager | undefined> {
	const result = openRelocatedSpy.mock.results[0];
	return result?.type === "return" ? await result.value : undefined;
}

interface CliRun {
	error: unknown;
	/** The session manager startup handed to `createAgentSession`. */
	manager: SessionManager | undefined;
}

/** Real CLI startup in-process, up to the mode runner, with `isTTY` as stdin's terminal flag. */
async function runCli(argv: string[], isTTY: boolean): Promise<CliRun> {
	Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
	const rawArgs = [...argv, ...QUIET_FLAGS];
	const parsed = parseArgs(rawArgs);
	const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
	const run: CliRun = { error: undefined, manager: undefined };
	try {
		await runRootCommand(parsed, rawArgs, {
			discoverAuthStorage: async () => authStorage,
			settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
			createAgentSession: async options => {
				run.manager = options?.sessionManager;
				if (run.manager) managers.add(run.manager);
				throw new StopSignal();
			},
			runAcpMode: async () => {
				throw new StopSignal();
			},
		});
	} catch (error) {
		run.error = error;
	} finally {
		authStorage.close();
	}
	return run;
}

describe("resume of a session whose directory is gone", () => {
	let launchDir: string;
	let goneDir: string;
	let storedPath: string;
	let storedId: string;

	beforeEach(async () => {
		launchDir = path.join(root, "launch");
		goneDir = path.join(root, "gone");
		await fs.promises.mkdir(launchDir);
		await fs.promises.mkdir(goneDir);
		// Filed in the gone directory's own session directory: neither a removed worktree nor the launch directory's.
		({ file: storedPath, id: storedId } = await answeredSession(goneDir));
		await fs.promises.rm(goneDir, { recursive: true, force: true });
		setProjectDir(launchDir);
	});

	for (const mode of ["rpc", "rpc-ui", "acp"] as const) {
		for (const isTTY of [true, false]) {
			it(`${mode} ${isTTY ? "with" : "without"} a terminal opens the stored session in place and asks nothing`, async () => {
				const run = await runCli(["--mode", mode, "--resume", storedId.slice(0, 8)], isTTY);

				expect(createInterface).not.toHaveBeenCalled();
				const stderr = stderrWrites.join("");
				// No exit and no missing-directory error; a failure shows both.
				expect({ exitCodes, stderr: stderr.includes("no longer exists") ? stderr : "" }).toEqual({
					exitCodes: [],
					stderr: "",
				});
				expect(run.error).toBeInstanceOf(StopSignal);
				// ACP builds its sessions per client request, so startup's manager is the one it opened.
				const manager = mode === "acp" ? await openedManager(storedPath) : run.manager;
				expect(normalized(manager?.getSessionFile())).toBe(normalized(storedPath));
				expect(normalized(manager?.getCwd())).toBe(normalized(launchDir));
				expect(openRelocatedSpy).not.toHaveBeenCalled();
				expect(normalized(await headerCwd(storedPath))).toBe(normalized(goneDir));
				expect(await sessionFiles(SessionManager.getDefaultSessionDir(launchDir))).toEqual([]);
				expect(stdoutWrites).toEqual([]);
			}, 15_000);
		}
	}

	it("interactive asks, and yes moves", async () => {
		answer = "y";
		const run = await runCli(["--resume", storedId.slice(0, 8)], true);

		expect(createInterface).toHaveBeenCalledTimes(1);
		expect(openRelocatedSpy).toHaveBeenCalledTimes(1);
		const moved = await relocatedManager();
		expect(normalized(await headerCwd(moved?.getSessionFile()))).toBe(normalized(launchDir));
		expect(run.error).toBeInstanceOf(StopSignal);
	}, 15_000);

	it("interactive asks, and no cancels", async () => {
		answer = "n";
		const run = await runCli(["--resume", storedId.slice(0, 8)], true);

		expect(run.error).toBeInstanceOf(ProcessExitSignal);
		expect(exitCodes).toEqual([0]);
		expect(stdoutWrites.join("")).toContain("Resume cancelled: session was not moved.");
		expect(normalized(await headerCwd(storedPath))).toBe(normalized(goneDir));
	}, 15_000);

	it("print mode without a terminal gets the run-interactively error", async () => {
		const run = await runCli(["--print", "--resume", storedId.slice(0, 8)], false);

		expect(run.error).toBeInstanceOf(ProcessExitSignal);
		expect(exitCodes).toEqual([1]);
		expect(stderrWrites.join("")).toContain("run interactively");
		expect(createInterface).not.toHaveBeenCalled();
	}, 15_000);

	describe("path, continue, automatic resume and fork never reach the decision", () => {
		/** `createSessionManager` for `argv` in the launch directory, with a decision that records each question. */
		async function resolveSession(argv: string[], settings = Settings.isolated()) {
			const decide = vi.fn(async () => "declined" as const);
			const manager = await createSessionManager(parseArgs(argv), launchDir, settings, decide);
			if (manager) managers.add(manager);
			return { decide, manager };
		}

		/** A session filed in the launch directory's session directory whose recorded directory is gone. */
		async function launchDirSessionWithGoneCwd(): Promise<string> {
			const elsewhere = path.join(root, "gone-too");
			await fs.promises.mkdir(elsewhere);
			const { file } = await answeredSession(elsewhere, SessionManager.getDefaultSessionDir(launchDir));
			await fs.promises.rm(elsewhere, { recursive: true, force: true });
			return file;
		}

		it("resume by path", async () => {
			const { decide, manager } = await resolveSession(["--resume", storedPath]);

			expect(decide).not.toHaveBeenCalled();
			expect(normalized(manager?.getSessionFile())).toBe(normalized(storedPath));
		}, 15_000);

		it("continue", async () => {
			const file = await launchDirSessionWithGoneCwd();
			const { decide, manager } = await resolveSession(["--continue"]);

			expect(decide).not.toHaveBeenCalled();
			expect(normalized(manager?.getSessionFile())).toBe(normalized(file));
		}, 15_000);

		it("automatic resume", async () => {
			const file = await launchDirSessionWithGoneCwd();
			const { decide, manager } = await resolveSession([], Settings.isolated({ autoResume: true }));

			expect(decide).not.toHaveBeenCalled();
			expect(normalized(manager?.getSessionFile())).toBe(normalized(file));
		}, 15_000);

		it("fork by id prefix", async () => {
			const { decide, manager } = await resolveSession(["--fork", storedId.slice(0, 8)]);

			expect(decide).not.toHaveBeenCalled();
			expect(manager?.getHeader()?.parentSession).toBe(storedId);
		}, 15_000);
	});
});

describe.skipIf(process.platform === "win32")(
	"a removed worktree is moved with no question, interactive and under rpc",
	() => {
		let repo: string;
		let sessionId: string;

		beforeEach(async () => {
			// Host git config (signing, hooks) must not reach the fixture repo; worktrees stay under the temp root.
			Object.assign(process.env, {
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_AUTHOR_NAME: "Test",
				GIT_AUTHOR_EMAIL: "test@example.com",
				GIT_COMMITTER_NAME: "Test",
				GIT_COMMITTER_EMAIL: "test@example.com",
				OMP_WORKTREE_DIR: path.join(root, "wt-base"),
			});
			repo = path.join(root, "repo");
			await fs.promises.mkdir(repo);
			await $`git init -q && git commit -q --allow-empty -m init`.cwd(repo).quiet();
			// `/wt` moves a session into a new worktree's session directory; `omp worktree clear` removes and prunes it.
			const manager = await answeredManager(repo);
			const { path: worktree } = await createSessionWorktree(repo, Settings.isolated(), "wt/gone");
			await manager.moveTo(worktree);
			await manager.close();
			sessionId = manager.getSessionId();
			await $`git worktree remove --force ${worktree} && git worktree prune`.cwd(repo).quiet();
			setProjectDir(repo);
		});

		/** Resumes the session by id from the checkout, with a terminal on stdin, and checks it moved there unasked. */
		async function expectMovedIntoCheckout(modeArgs: string[]): Promise<void> {
			const run = await runCli([...modeArgs, "--resume", sessionId.slice(0, 8)], true);

			expect(createInterface).not.toHaveBeenCalled();
			expect(openRelocatedSpy).toHaveBeenCalledTimes(1);
			const moved = await relocatedManager();
			expect(normalized(await headerCwd(moved?.getSessionFile()))).toBe(normalized(repo));
			expect(run.error).toBeInstanceOf(StopSignal);
		}

		it("interactive", async () => {
			await expectMovedIntoCheckout([]);
		}, 15_000);

		it("under rpc", async () => {
			await expectMovedIntoCheckout(["--mode", "rpc"]);
		}, 15_000);
	},
);
