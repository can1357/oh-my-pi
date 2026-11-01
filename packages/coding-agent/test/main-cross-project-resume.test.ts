/**
 * Regression: `--resume <id>` must open a cross-project session in its recorded
 * cwd instead of prompting to fork it into the launch directory.
 *
 * Also covers the moved/renamed-worktree path: when the matched session's
 * recorded directory no longer exists, `--resume <id>` offers to *move*
 * (re-root) the session rather than opening against a missing directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Args, parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import * as modelResolverModule from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as pluginHelpers from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { createSessionManager, runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import * as sessionListingModule from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	__resetDirsFromEnvForTests,
	getProjectDir,
	normalizePathForComparison,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalPiProfile = process.env.PI_PROFILE;
const originalOmpProfile = process.env.OMP_PROFILE;
let agentDirRoot: string | undefined;

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

beforeEach(async () => {
	agentDirRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-xproj-agent-dir-"));
	setAgentDir(path.join(agentDirRoot, "agent"));
});

afterEach(async () => {
	// `runRootCommand` registers the CLI's extension roots (`--no-extensions` → explicit-only) process-wide.
	clearOmpExtensionCliRoots();
	restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
	restoreEnv("PI_PROFILE", originalPiProfile);
	restoreEnv("OMP_PROFILE", originalOmpProfile);
	__resetDirsFromEnvForTests();
	if (agentDirRoot) {
		await fsp.rm(agentDirRoot, { recursive: true, force: true });
	}
});

function buildArgs(resume: string, sessionDir?: string): Args {
	return {
		resume,
		sessionDir,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
		invalidFlagValues: [],
	};
}

type RepositoryMetadata = {
	sessionWorktreeRoot: string;
	primaryWorktreeRoot: string;
};

type RecoverySessionInfo = SessionInfo & {
	repository?: RepositoryMetadata;
};

function buildGlobalMatch(
	cwd: string,
	options: { path?: string; repository?: RepositoryMetadata } = {},
): { session: RecoverySessionInfo; scope: "global" } {
	return {
		scope: "global",
		session: {
			path: options.path ?? path.join(cwd, "019e84ed-b4cc-7000-9c87-5afe6df992c1.jsonl"),
			id: "019e84ed-b4cc-7000-9c87-5afe6df992c1",
			cwd,
			title: "in-other-project",
			created: new Date(0),
			modified: new Date(0),
			messageCount: 1,
			size: 0,
			firstMessage: "prior work",
			allMessagesText: "prior work",
			repository: options.repository,
		},
	};
}

const stubSettings = { get: () => undefined } as unknown as Settings;

async function writeRecoverySession(session: RecoverySessionInfo): Promise<void> {
	await fsp.mkdir(path.dirname(session.path), { recursive: true });
	await Bun.write(
		session.path,
		[
			JSON.stringify({
				type: "session",
				id: session.id,
				cwd: session.cwd,
				timestamp: new Date(0).toISOString(),
				repository: session.repository,
			}),
			JSON.stringify({
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: { role: "assistant", content: "prior work" },
			}),
			"",
		].join("\n"),
	);
}

async function createStartupRecoveryFixture(
	root: string,
	options: { primary?: boolean } = {},
): Promise<{
	launchProject: string;
	savedPrimary: string;
	missingCwd: string;
	sessionDir: string;
	match: { session: RecoverySessionInfo; scope: "global" };
}> {
	const launchProject = path.join(root, "launch");
	const savedPrimary = path.join(root, "primary");
	const missingCwd = path.join(root, "deleted-worktree");
	const sessionDir = path.join(root, "sessions");
	await fsp.mkdir(launchProject, { recursive: true });
	if (options.primary !== false) await fsp.mkdir(savedPrimary, { recursive: true });
	await fsp.mkdir(sessionDir, { recursive: true });
	const match = buildGlobalMatch(missingCwd, {
		path: path.join(sessionDir, "019e84ed-b4cc-7000-9c87-5afe6df992c1.jsonl"),
		repository: {
			sessionWorktreeRoot: missingCwd,
			primaryWorktreeRoot: savedPrimary,
		},
	});
	await writeRecoverySession(match.session);
	return { launchProject, savedPrimary, missingCwd, sessionDir, match };
}

describe("createSessionManager — cross-project --resume", () => {
	let existingProject: string;

	beforeEach(async () => {
		existingProject = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-xproj-"));
		const match = buildGlobalMatch(existingProject);
		await Bun.write(
			match.session.path,
			`${JSON.stringify({
				type: "session",
				id: match.session.id,
				cwd: existingProject,
				timestamp: new Date(0).toISOString(),
			})}\n`,
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(existingProject, { recursive: true, force: true });
	});

	it("opens the existing journal in its recorded cwd without a relocation prompt", async () => {
		const match = buildGlobalMatch(existingProject);
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(match);

		const result = await createSessionManager(buildArgs("019e84ed"), "/current/project", stubSettings);

		if (!result) throw new Error("Expected resumed session manager");
		try {
			expect(result.getSessionFile()).toBe(match.session.path);
			expect(result.getCwd()).toBe(existingProject);
		} finally {
			await result.close();
		}
	});
});

describe("SessionManager.open — recorded cwd adoption", () => {
	it("keeps the launch cwd when the recorded cwd cannot be probed", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-xproj-denied-"));
		const launchProject = path.join(root, "launch");
		const deniedProject = path.join(root, "denied");
		await fsp.mkdir(launchProject);
		const match = buildGlobalMatch(deniedProject);
		await Bun.write(
			match.session.path,
			`${JSON.stringify({
				type: "session",
				id: match.session.id,
				cwd: deniedProject,
				timestamp: new Date(0).toISOString(),
			})}\n`,
		);
		const realStat = fs.promises.stat.bind(fs.promises) as (
			path: fs.PathLike,
			options?: fs.StatOptions,
		) => Promise<fs.Stats>;
		const stat = vi.spyOn(fs.promises, "stat").mockImplementation((async (
			target: fs.PathLike,
			options?: fs.StatOptions,
		) => {
			if (normalizePathForComparison(String(target)) === normalizePathForComparison(deniedProject)) {
				throw Object.assign(new Error("operation not permitted"), { code: "EACCES" });
			}
			return realStat(target, options);
		}) as typeof fs.promises.stat);
		try {
			const manager = await SessionManager.open(match.session.path, undefined, undefined, {
				initialCwd: launchProject,
			});
			try {
				expect(manager.getCwd()).toBe(launchProject);
			} finally {
				await manager.close();
			}
		} finally {
			stat.mockRestore();
			await fsp.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps the launch cwd when the recorded cwd denies search permission", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-xproj-noexec-"));
		const launchProject = path.join(root, "launch");
		const deniedProject = path.join(root, "denied");
		await fsp.mkdir(launchProject);
		await fsp.mkdir(deniedProject);
		const match = buildGlobalMatch(deniedProject);
		await Bun.write(
			match.session.path,
			`${JSON.stringify({
				type: "session",
				id: match.session.id,
				cwd: deniedProject,
				timestamp: new Date(0).toISOString(),
			})}\n`,
		);
		const realAccess = fs.promises.access.bind(fs.promises);
		const access = vi.spyOn(fs.promises, "access").mockImplementation(async (target, mode) => {
			if (normalizePathForComparison(String(target)) === normalizePathForComparison(deniedProject)) {
				throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			}
			return realAccess(target, mode);
		});

		try {
			const manager = await SessionManager.open(match.session.path, undefined, undefined, {
				initialCwd: launchProject,
			});
			try {
				expect(manager.getCwd()).toBe(launchProject);
			} finally {
				await manager.close();
			}
		} finally {
			access.mockRestore();
			await fsp.rm(root, { recursive: true, force: true });
		}
	});
});

describe("runRootCommand — cross-project --resume", () => {
	let root: string;
	let launchProject: string;
	let resumedProject: string;
	let originalProject: string;

	beforeEach(async () => {
		originalProject = getProjectDir();
		root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-xproj-root-"));
		launchProject = path.join(root, "launch");
		resumedProject = path.join(root, "resumed");
		await Promise.all([fsp.mkdir(launchProject), fsp.mkdir(resumedProject)]);
		const match = buildGlobalMatch(resumedProject);
		await Bun.write(
			match.session.path,
			`${JSON.stringify({
				type: "session",
				id: match.session.id,
				cwd: resumedProject,
				timestamp: new Date(0).toISOString(),
			})}\n`,
		);
		setProjectDir(launchProject);
	});

	afterEach(async () => {
		setProjectDir(originalProject);
		vi.restoreAllMocks();
		await fsp.rm(root, { recursive: true, force: true });
	});

	it("surfaces a recorded-cwd access error instead of falling back to launch", async () => {
		const match = buildGlobalMatch(resumedProject);
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(match);
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const realAccess = fs.promises.access.bind(fs.promises);
		const access = vi.spyOn(fs.promises, "access").mockImplementation(async (target, mode) => {
			if (path.basename(String(target)) === "resumed") {
				throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			}
			return realAccess(target, mode);
		});
		const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		const rawArgs = ["--cwd", launchProject, "--resume", "019e84ed", "--print"];
		const parsed = parseArgs(rawArgs);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		const exitCodes: number[] = [];
		const stderr: string[] = [];
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
			throw new StartupProcessExitSignal(code ?? 0);
		}) as typeof process.exit);
		const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
			stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stderr.write);
		try {
			await expect(
				runRootCommand(parsed, rawArgs, {
					discoverAuthStorage: async () => authStorage,
					settings,
				}),
			).rejects.toBeInstanceOf(StartupProcessExitSignal);
		} finally {
			access.mockRestore();
			exit.mockRestore();
			stderrWrite.mockRestore();
			authStorage.close();
		}
		expect(exitCodes).toEqual([1]);
		expect(stderr.join("")).toContain("Could not inspect session");
		expect(getProjectDir()).toBe(launchProject);
	});

	it("reports destination rescope failure and rolls back project state", async () => {
		const match = buildGlobalMatch(resumedProject);
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(match);
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const reloadForCwd = vi.spyOn(settings, "reloadForCwd").mockImplementation(async cwd => {
			if (normalizePathForComparison(cwd) === normalizePathForComparison(resumedProject)) {
				throw new Error("destination config unreadable");
			}
		});
		vi.spyOn(pluginHelpers, "preloadPluginRoots").mockResolvedValue(undefined);
		const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		const parsed = parseArgs(["--resume", "019e84ed", "--print"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		const exitCodes: number[] = [];
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
			throw new StartupProcessExitSignal(code ?? 0);
		}) as typeof process.exit);
		try {
			await expect(
				runRootCommand(parsed, ["--resume", "019e84ed", "--print"], {
					discoverAuthStorage: async () => authStorage,
					settings,
				}),
			).rejects.toBeInstanceOf(StartupProcessExitSignal);
		} finally {
			reloadForCwd.mockRestore();
			exit.mockRestore();
			authStorage.close();
		}
		expect(exitCodes).toEqual([1]);
		expect(getProjectDir()).toBe(launchProject);
		expect(settings.getCwd()).toBe(launchProject);
	});

	it("reports resumed-cwd switch failure without silent fallback", async () => {
		const match = buildGlobalMatch(resumedProject);
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(match);
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		const originalChdir = process.chdir.bind(process);
		const chdir = vi.spyOn(process, "chdir").mockImplementation(dir => {
			if (normalizePathForComparison(dir) === normalizePathForComparison(resumedProject)) {
				throw new Error("operation not permitted");
			}
			originalChdir(dir);
		});
		const parsed = parseArgs(["--resume", "019e84ed", "--print"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		const exitCodes: number[] = [];
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
			throw new StartupProcessExitSignal(code ?? 0);
		}) as typeof process.exit);
		try {
			await expect(
				runRootCommand(parsed, ["--resume", "019e84ed", "--print"], {
					discoverAuthStorage: async () => authStorage,
					settings,
				}),
			).rejects.toBeInstanceOf(StartupProcessExitSignal);
		} finally {
			chdir.mockRestore();
			exit.mockRestore();
			authStorage.close();
		}
		expect(exitCodes).toEqual([1]);
		expect(getProjectDir()).toBe(launchProject);
		expect(settings.getCwd()).toBe(launchProject);
	});

	it("re-resolves the model scope from the resumed project's enabledModels after the switch", async () => {
		const match = buildGlobalMatch(resumedProject);
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(match);
		// enabledModels scoped only to the resumed project: the launch scope
		// yields no patterns, so any resolveModelScope call proves the recompute
		// ran against the destination settings rather than the launch directory.
		const settings = Settings.isolated({
			"marketplace.autoUpdate": "off",
			enabledModels: [{ paths: [resumedProject], models: ["model-resumed"] }],
		});
		const resolveModelScope = vi
			.spyOn(modelResolverModule, "resolveModelScope")
			.mockResolvedValue([{ model: { id: "model-resumed" } } as modelResolverModule.ScopedModel]);
		const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		const parsed = parseArgs(["--resume", "019e84ed", "--print"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		let resumedManager: SessionManager | undefined;

		try {
			await runRootCommand(parsed, ["--resume", "019e84ed", "--print"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					if (!options) throw new Error("Expected session options");
					resumedManager = options.sessionManager;
					throw new Error("stop after session options");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after session options") throw error;
		} finally {
			authStorage.close();
			await resumedManager?.close();
		}

		// Launch scope had no patterns, so the only resolution is the post-switch
		// one; the pre-fix code never recomputed and would not call it at all.
		expect(resolveModelScope).toHaveBeenCalledTimes(1);
		expect(resolveModelScope.mock.calls[0]?.[0]).toEqual(["model-resumed"]);
	}, 15_000);
});

describe("createSessionManager — cross-project --resume relocation (moved worktree)", () => {
	let missingRoot: string;
	let missingProject: string;

	beforeEach(async () => {
		missingRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-moved-xproj-"));
		missingProject = path.join(missingRoot, "worktree-gone");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(missingRoot, { recursive: true, force: true });
	});

	it("returns undefined when fallback directory selection is cancelled", async () => {
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(missingProject));
		expect(fs.existsSync(missingProject)).toBe(false);
		const selectDirectory = vi.fn(async () => undefined);
		const result = await createSessionManager(buildArgs("019e84ed"), "/current/project", stubSettings, {
			interactive: true,
			selectDirectory,
		});
		expect(result).toBeUndefined();
		expect(selectDirectory).toHaveBeenCalledTimes(1);
	});

	it("throws an actionable error when unavailable in non-interactive mode", async () => {
		const originalIsTTY = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		try {
			vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(missingProject));

			await expect(createSessionManager(buildArgs("019e84ed"), "/current/project", stubSettings)).rejects.toThrow(
				`Session "019e84ed" belongs to a directory that no longer exists (${missingProject}); select an existing directory interactively to resume it.`,
			);
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
		}
	});

	it("moves a local explicit-session-dir match whose recorded cwd is gone", async () => {
		const currentProject = path.join(missingRoot, "current-project");
		const explicitSessionDir = path.join(missingRoot, "sessions");
		await fsp.mkdir(currentProject, { recursive: true });

		const moved = SessionManager.create(missingProject, explicitSessionDir);
		moved.appendMessage({ role: "user", content: "before local move", timestamp: 1 });
		await moved.flush();
		await moved.ensureOnDisk();
		const oldFile = moved.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted session file");
		const resumePrefix = moved.getSessionId().slice(0, 8);
		const sessionInfo: SessionInfo = {
			path: oldFile,
			id: moved.getSessionId(),
			cwd: missingProject,
			title: "moved-local",
			created: new Date(0),
			modified: new Date(0),
			messageCount: 1,
			size: 0,
			firstMessage: "before local move",
			allMessagesText: "before local move",
		};
		await moved.close();
		expect(fs.existsSync(missingProject)).toBe(false);
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue({
			scope: "local",
			session: sessionInfo,
		});

		const selectDirectory = vi.fn(async () => currentProject);
		let result: SessionManager | undefined;
		try {
			result = await createSessionManager(
				buildArgs(resumePrefix, explicitSessionDir),
				currentProject,
				stubSettings,
				{ interactive: true, selectDirectory },
			);
			if (!result) throw new Error("Expected moved session manager");
			expect(result.getSessionFile()).toBe(oldFile);
			expect(result.getCwd()).toBe(path.resolve(currentProject));
			const entries = await loadEntriesFromFile(oldFile);
			const header = entries.find(
				(entry): entry is SessionHeader =>
					typeof entry === "object" &&
					entry !== null &&
					"type" in entry &&
					(entry as { type: unknown }).type === "session",
			);
			expect(header?.cwd).toBe(path.resolve(currentProject));
		} finally {
			await result?.close();
		}
		expect(selectDirectory).toHaveBeenCalledTimes(1);
	});
});
type StartupRecoveryDependencies = NonNullable<Parameters<typeof runRootCommand>[2]> & {
	selectDirectory?: (cwd: string) => Promise<string | undefined>;
};
class StartupProcessExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
		this.name = "StartupProcessExitSignal";
	}
}

class StartupSessionOptionsStop extends Error {
	constructor() {
		super("stop after session options");
	}
}

describe("startup resume recovery parity", () => {
	let recoveryRoot: string;
	let originalProject: string;

	beforeEach(async () => {
		recoveryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-startup-recovery-"));
		originalProject = getProjectDir();
	});

	afterEach(async () => {
		setProjectDir(originalProject);
		vi.restoreAllMocks();
		await fsp.rm(recoveryRoot, { recursive: true, force: true });
	});

	it("uses the saved primary worktree when resuming by explicit ID", async () => {
		const fixture = await createStartupRecoveryFixture(recoveryRoot);
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(fixture.match);

		const manager = await createSessionManager(
			buildArgs("019e84ed", fixture.sessionDir),
			fixture.launchProject,
			stubSettings,
		);
		if (!manager) throw new Error("Expected resumed session manager");
		try {
			expect(manager.getCwd()).toBe(fixture.savedPrimary);
		} finally {
			await manager.close();
		}
	});

	it("uses the saved primary worktree when resuming by absolute JSONL path", async () => {
		const fixture = await createStartupRecoveryFixture(recoveryRoot);

		const manager = await createSessionManager(
			buildArgs(fixture.match.session.path, fixture.sessionDir),
			fixture.launchProject,
			stubSettings,
		);
		try {
			expect(manager?.getCwd()).toBe(fixture.savedPrimary);
		} finally {
			await manager?.close();
		}
	});

	it("uses the saved primary worktree when resuming from the startup picker", async () => {
		const fixture = await createStartupRecoveryFixture(recoveryRoot);
		setProjectDir(fixture.launchProject);
		const authStorage = await AuthStorage.create(path.join(recoveryRoot, "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const parsed = parseArgs(["--resume", "--print"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = fixture.sessionDir;
		let resumedManager: SessionManager | undefined;

		try {
			await runRootCommand(parsed, ["--resume", "--print"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				selectSession: async () => fixture.match.session,
				createAgentSession: async options => {
					if (!options) throw new Error("Expected session options");
					resumedManager = options.sessionManager;
					throw new StartupSessionOptionsStop();
				},
			});
		} catch (error) {
			if (!(error instanceof StartupSessionOptionsStop)) throw error;
		} finally {
			authStorage.close();
			await resumedManager?.close();
		}

		expect(resumedManager?.getCwd()).toBe(fixture.savedPrimary);
	});

	it("uses an existing directory selected by the interactive recovery adapter", async () => {
		const fixture = await createStartupRecoveryFixture(recoveryRoot, { primary: false });
		const selectedDirectory = path.join(recoveryRoot, "selected");
		await fsp.mkdir(selectedDirectory);
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(fixture.match);
		setProjectDir(fixture.launchProject);
		const authStorage = await AuthStorage.create(path.join(recoveryRoot, "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const parsed = parseArgs(["--resume", "019e84ed"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = fixture.sessionDir;
		const originalIsTTY = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		const selectDirectory = vi.fn(async (_cwd: string) => selectedDirectory);
		let resumedManager: SessionManager | undefined;

		try {
			await runRootCommand(parsed, ["--resume", "019e84ed"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					if (!options) throw new Error("Expected session options");
					resumedManager = options.sessionManager;
					throw new StartupSessionOptionsStop();
				},
				selectDirectory,
			} as StartupRecoveryDependencies);
		} catch (error) {
			if (!(error instanceof StartupSessionOptionsStop)) throw error;
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
			authStorage.close();
			await resumedManager?.close();
		}

		expect(selectDirectory).toHaveBeenCalledTimes(1);
		expect(resumedManager?.getCwd()).toBe(selectedDirectory);
	});

	it("fails non-interactively with an actionable recovery error", async () => {
		const fixture = await createStartupRecoveryFixture(recoveryRoot, { primary: false });
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(fixture.match);
		setProjectDir(fixture.launchProject);
		const authStorage = await AuthStorage.create(path.join(recoveryRoot, "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const parsed = parseArgs(["--resume", "019e84ed", "--print"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = fixture.sessionDir;
		const stderr: string[] = [];
		const exitCodes: number[] = [];
		const originalIsTTY = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		// Under a TTY the real stdin is a pty that never reaches EOF; with isTTY
		// stubbed false, readPipedInput would drain it forever and keep the test
		// process alive after the suite.
		vi.spyOn(Bun, "stdin").mockReturnValue({ text: async () => "" } as never);
		vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array): boolean => {
			stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stderr.write);
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
			throw new StartupProcessExitSignal(code ?? 0);
		}) as typeof process.exit);
		const selectDirectory = vi.fn(async () => path.join(recoveryRoot, "not-used"));

		try {
			await expect(
				runRootCommand(parsed, ["--resume", "019e84ed", "--print"], {
					discoverAuthStorage: async () => authStorage,
					settings,
					selectDirectory,
				} as StartupRecoveryDependencies),
			).rejects.toBeInstanceOf(StartupProcessExitSignal);
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
			authStorage.close();
		}

		expect(exitCodes).toEqual([1]);
		expect(stderr.join("")).toContain("interactively");
		expect(stderr.join("")).toContain(fixture.missingCwd);
		expect(selectDirectory).not.toHaveBeenCalled();
		await expect(fsp.stat(fixture.match.session.path)).resolves.toBeTruthy();
	});
	it.each([
		["--print", ["--resume", "019e84ed", "--print"] as string[]],
		["rpc", ["--resume", "019e84ed", "--mode", "rpc"] as string[]],
	])("rejects missing recovery directory without prompting in terminal-backed %s mode", async (mode, rawArgs) => {
		const fixture = await createStartupRecoveryFixture(recoveryRoot, { primary: false });
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(fixture.match);
		setProjectDir(fixture.launchProject);
		const authStorage = await AuthStorage.create(path.join(recoveryRoot, "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const parsed = parseArgs(rawArgs);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = fixture.sessionDir;
		const stdout: string[] = [];
		const stderr: string[] = [];
		const exitCodes: number[] = [];
		const originalIsTTY = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array): boolean => {
			stdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stdout.write);
		vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array): boolean => {
			stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stderr.write);
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
			throw new StartupProcessExitSignal(code ?? 0);
		}) as typeof process.exit);
		const selectDirectory = vi.fn(async () => path.join(recoveryRoot, "not-used"));

		try {
			await expect(
				runRootCommand(parsed, rawArgs, {
					discoverAuthStorage: async () => authStorage,
					settings,
					selectDirectory,
				} as StartupRecoveryDependencies),
			).rejects.toBeInstanceOf(StartupProcessExitSignal);
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
			authStorage.close();
		}

		expect(exitCodes).toEqual([1]);
		expect(stderr.join("")).toContain("interactively");
		expect(stderr.join("")).toContain(fixture.missingCwd);
		expect(selectDirectory).not.toHaveBeenCalled();
		if (mode === "rpc") expect(stdout.join("")).not.toContain("Enter an existing directory");
	});

	it("reports the relocation when the resumed project cannot be adopted", async () => {
		const fixture = await createStartupRecoveryFixture(recoveryRoot);
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(fixture.match);
		setProjectDir(fixture.launchProject);
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		vi.spyOn(settings, "reloadForCwd").mockImplementation(async cwd => {
			if (normalizePathForComparison(cwd) === normalizePathForComparison(fixture.savedPrimary)) {
				throw new Error("destination config unreadable");
			}
		});
		const authStorage = await AuthStorage.create(path.join(recoveryRoot, "auth.db"));
		const parsed = parseArgs(["--resume", "019e84ed", "--print"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = fixture.sessionDir;
		const exitCodes: number[] = [];
		const stderr: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array): boolean => {
			stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stderr.write);
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
			throw new StartupProcessExitSignal(code ?? 0);
		}) as typeof process.exit);

		try {
			await expect(
				runRootCommand(parsed, ["--resume", "019e84ed", "--print"], {
					discoverAuthStorage: async () => authStorage,
					settings,
				}),
			).rejects.toBeInstanceOf(StartupProcessExitSignal);
		} finally {
			authStorage.close();
		}

		expect(exitCodes).toEqual([1]);
		const output = stderr.join("");
		expect(output).toContain("Could not switch to resumed project");
		expect(output).toContain(`The session was relocated from ${fixture.missingCwd} to ${fixture.savedPrimary}.`);
		const entries = await loadEntriesFromFile(fixture.match.session.path);
		const header = entries.find(
			(entry): entry is SessionHeader =>
				typeof entry === "object" && entry !== null && "type" in entry && entry.type === "session",
		);
		expect(header?.cwd).toBe(fixture.savedPrimary);
	});
});
