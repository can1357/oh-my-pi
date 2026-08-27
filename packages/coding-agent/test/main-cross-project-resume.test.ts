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
import { createSessionManager, runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import * as sessionListingModule from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectDir, normalizePathForComparison, setProjectDir } from "@oh-my-pi/pi-utils";

function buildArgs(resume: string, sessionDir?: string): Args {
	return {
		resume,
		sessionDir,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
	};
}

function buildGlobalMatch(cwd: string): { session: SessionInfo; scope: "global" } {
	return {
		scope: "global",
		session: {
			path: `${cwd}/019e84ed-b4cc-7000-9c87-5afe6df992c1.jsonl`,
			id: "019e84ed-b4cc-7000-9c87-5afe6df992c1",
			cwd,
			title: "in-other-project",
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			size: 0,
			firstMessage: "",
			allMessagesText: "",
		},
	};
}

const stubSettings = { get: () => undefined } as unknown as Settings;

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
		const movePrompt = vi.fn(async () => "declined" as const);

		const result = await createSessionManager(buildArgs("019e84ed"), "/current/project", stubSettings, movePrompt);

		if (!result) throw new Error("Expected resumed session manager");
		try {
			expect(result.getSessionFile()).toBe(match.session.path);
			expect(result.getCwd()).toBe(existingProject);
		} finally {
			await result.close();
		}
		expect(movePrompt).not.toHaveBeenCalled();
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

	it("uses the destination cwd and preloads its plugin roots before session creation", async () => {
		const match = buildGlobalMatch(resumedProject);
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(match);
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const reloadForCwd = vi.spyOn(settings, "reloadForCwd");
		// The switch must warm the destination roots via the shared preload helper
		// (clearPluginRootsAndCaches only fires an unawaited re-warm), so record the
		// cwds it is invoked with.
		const preloadedCwds: (string | undefined)[] = [];
		vi.spyOn(pluginHelpers, "preloadPluginRoots").mockImplementation(async (_home, cwd) => {
			preloadedCwds.push(cwd);
		});
		const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		const rawArgs = ["--cwd", launchProject, "--resume", "019e84ed", "--print"];
		const parsed = parseArgs(rawArgs);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		let resumedManager: SessionManager | undefined;
		let preloadedDestinationAtCreation = false;
		let sessionOptionsCwd: string | undefined;

		try {
			await runRootCommand(parsed, rawArgs, {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					if (!options) throw new Error("Expected session options");
					resumedManager = options.sessionManager;
					sessionOptionsCwd = options.cwd;
					// Awaited during the switch, so by session creation the destination
					// preload has already been requested for the resumed project.
					preloadedDestinationAtCreation = preloadedCwds.includes(resumedProject);
					throw new Error("stop after session options");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after session options") throw error;
		} finally {
			authStorage.close();
			await resumedManager?.close();
		}

		expect(getProjectDir()).toBe(resumedProject);
		// process.cwd() reports the physical path (/private/var/... on macOS) while
		// the fixture path keeps the /var symlink form — compare canonicalized.
		expect(normalizePathForComparison(process.cwd())).toBe(normalizePathForComparison(resumedProject));
		expect(reloadForCwd).toHaveBeenCalledWith(resumedProject);
		expect(resumedManager?.getCwd()).toBe(resumedProject);
		expect(parsed.cwd).toBe(resumedProject);
		expect(sessionOptionsCwd).toBe(resumedProject);
		expect(preloadedDestinationAtCreation).toBe(true);
	}, 15_000);

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

	it("offers move (not fork) and returns undefined when the user declines", async () => {
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(missingProject));
		expect(fs.existsSync(missingProject)).toBe(false);

		const result = await createSessionManager(
			buildArgs("019e84ed"),
			"/current/project",
			stubSettings,
			async () => "declined" as const,
		);

		expect(result).toBeUndefined();
	});

	it("throws the move-specific error when unavailable in non-interactive mode", async () => {
		const originalIsTTY = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		try {
			vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(missingProject));

			await expect(createSessionManager(buildArgs("019e84ed"), "/current/project", stubSettings)).rejects.toThrow(
				`Session "019e84ed" belongs to a directory that no longer exists (${missingProject}); run interactively to move it into the current project.`,
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

		const movePrompt = vi.fn(async () => "accepted" as const);
		const result = await createSessionManager(
			buildArgs(resumePrefix, explicitSessionDir),
			currentProject,
			stubSettings,
			movePrompt,
		);

		if (!result) throw new Error("Expected moved session manager");
		try {
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
			await result.close();
		}
		expect(movePrompt).toHaveBeenCalledTimes(1);
	});
});
