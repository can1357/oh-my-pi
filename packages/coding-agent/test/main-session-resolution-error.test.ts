/**
 * Regression for #2084: `createSessionManager` must reject with
 * `SessionResolutionError` (and a usage hint) when `--resume` / `--fork` are
 * given a non-existent session id, so `runRootCommand` can convert it into a
 * clean stderr message + non-zero exit instead of letting it surface as
 * `[Uncaught Exception]`.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { type Args, parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager, SessionResolutionError, writeStartupNotice } from "@oh-my-pi/pi-coding-agent/main";
import {
	collectPendingToolCalls,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { configureSessionBoundaryRoot } from "@oh-my-pi/pi-coding-agent/session/session-boundary";
import * as sessionIndexModule from "@oh-my-pi/pi-coding-agent/session/session-index";
import * as sessionListingModule from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile, loadSessionFile, readSessionHeaderId } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { ForkSourceNotFoundError, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

function buildResumeArgs(resume: string, sessionDir?: string): Args {
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

function buildContinueArgs(message: string, sessionDir?: string): Args {
	return {
		continue: true,
		sessionDir,
		messages: [message],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
		invalidFlagValues: [],
	};
}
function buildForkArgs(fork: string, noSession = false, sessionDir?: string): Args {
	return {
		fork,
		noSession: noSession || undefined,
		sessionDir,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
		invalidFlagValues: [],
	};
}

const stubSettings = Settings.isolated();

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);
const ORIGINAL_STDERR_WRITE = process.stderr.write.bind(process.stderr);

function captureProcessOutput(): { read: () => { stdout: string; stderr: string }; restore: () => void } {
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stderr.write;
	return {
		read: () => ({ stdout, stderr }),
		restore: () => {
			process.stdout.write = ORIGINAL_STDOUT_WRITE;
			process.stderr.write = ORIGINAL_STDERR_WRITE;
		},
	};
}

describe("writeStartupNotice", () => {
	it("writes notices to stdout outside JSON mode", () => {
		const capture = captureProcessOutput();
		try {
			writeStartupNotice({}, "hello\n");
			expect(capture.read()).toEqual({ stdout: "hello\n", stderr: "" });
		} finally {
			capture.restore();
		}
	});

	it("keeps JSON mode stdout clean by writing notices to stderr", () => {
		const capture = captureProcessOutput();
		try {
			writeStartupNotice({ mode: "json" }, "hello\n");
			expect(capture.read()).toEqual({ stdout: "", stderr: "hello\n" });
		} finally {
			capture.restore();
		}
	});
});

describe("createSessionManager — missing session (#2084)", () => {
	it("rejects --resume with SessionResolutionError carrying a usage hint", async () => {
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(undefined);
		try {
			await expect(
				createSessionManager(
					buildResumeArgs("019ea530-0000-7000-0000-000000000000"),
					"/current/project",
					stubSettings,
				),
			).rejects.toMatchObject({
				name: "SessionResolutionError",
				message: 'Session "019ea530-0000-7000-0000-000000000000" not found.',
				hint: expect.stringContaining("omp --resume"),
			});

			// Confirm it's the exported class so `runRootCommand`'s `instanceof` check works.
			const caught = await createSessionManager(
				buildResumeArgs("019ea530-0000-7000-0000-000000000000"),
				"/current/project",
				stubSettings,
			).catch((err: unknown) => err);
			expect(caught).toBeInstanceOf(SessionResolutionError);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("rejects --resume with unknown id instead of falling back to latest persisted session", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-resume-unknown-id-"));
		const sessionDir = path.join(cwd, "sessions");
		const missingId = "019ea530-ffff-7000-8000-000000000000";
		try {
			const latest = SessionManager.create(cwd, sessionDir);
			latest.appendMessage({ role: "user", content: "newer persisted session", timestamp: Date.now() });
			await latest.rewriteEntries();
			const latestSessionId = latest.getSessionId();
			expect(latestSessionId).not.toBe(missingId);

			await expect(
				createSessionManager(buildResumeArgs(missingId, sessionDir), cwd, stubSettings),
			).rejects.toMatchObject({
				name: "SessionResolutionError",
				message: `Session "${missingId}" not found.`,
				hint: expect.stringContaining("omp --resume"),
			});
		} finally {
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects --continue followed by an unknown session id instead of falling back to latest", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-continue-unknown-id-"));
		const sessionDir = path.join(cwd, "sessions");
		const missingId = "019ea530-ffff-7000-8000-000000000000";
		try {
			const latest = SessionManager.create(cwd, sessionDir);
			latest.appendMessage({ role: "user", content: "latest should not be resumed", timestamp: Date.now() });
			await latest.rewriteEntries();
			expect(latest.getSessionId()).not.toBe(missingId);

			await expect(
				createSessionManager(buildContinueArgs(missingId, sessionDir), cwd, stubSettings),
			).rejects.toMatchObject({
				name: "SessionResolutionError",
				message: `Session "${missingId}" not found.`,
				hint: expect.stringContaining("omp --resume"),
			});
		} finally {
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects --fork with SessionResolutionError carrying a usage hint", async () => {
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(undefined);
		try {
			await expect(
				createSessionManager(
					buildForkArgs("019ea530-0000-7000-0000-000000000000"),
					"/current/project",
					stubSettings,
				),
			).rejects.toMatchObject({
				name: "SessionResolutionError",
				message: 'Session "019ea530-0000-7000-0000-000000000000" not found.',
				hint: expect.stringContaining("omp --resume"),
			});
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("rejects --fork combined with --no-session as a SessionResolutionError (no hint)", async () => {
		await expect(
			createSessionManager(buildForkArgs("019ea530", true), "/current/project", stubSettings),
		).rejects.toMatchObject({
			name: "SessionResolutionError",
			message: "--fork requires session persistence",
			hint: undefined,
		});
	});
	it.each(["path", "selector"] as const)(
		"preserves an unknown started-tool outcome in a CLI --fork via %s",
		async route => {
			const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-fork-live-tail-"));
			const sessionDir = path.join(cwd, "sessions");
			const source = path.join(sessionDir, "source.jsonl");
			const id = "019ea530-0000-7000-0000-000000000000";
			const timestamp = new Date().toISOString();
			const sourceEntries = [
				{ type: "session", version: 3, id, timestamp, cwd },
				{
					type: "message",
					id: "m1",
					parentId: null,
					timestamp,
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "toolu_live", name: "bash", arguments: { command: "sleep 40" } }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude",
						stopReason: "toolUse",
						timestamp: Date.now(),
						usage: {
							input: 10,
							output: 5,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 15,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				},
				{
					type: "custom",
					id: "m2",
					parentId: "m1",
					timestamp,
					customType: TOOL_EXECUTION_START_CUSTOM_TYPE,
					data: { toolCallId: "toolu_live", toolName: "bash", startedAt: timestamp },
				},
			];
			const sourceText = `${sourceEntries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
			await Bun.write(source, sourceText);
			if (route === "selector") {
				vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue({
					session: {
						id,
						path: source,
						cwd,
						title: "live parent",
						created: new Date(0),
						modified: new Date(0),
						messageCount: 1,
						size: 0,
						firstMessage: "",
						allMessagesText: "",
					},
					scope: "local",
				});
			}
			try {
				const forked = await createSessionManager(
					buildForkArgs(route === "path" ? source : id, false, sessionDir),
					cwd,
					stubSettings,
				);
				if (!forked) throw new Error("Expected a persisted fork");
				const branch = forked.getBranch();
				expect(branch.some(entry => entry.type === "message" && entry.message.role === "assistant")).toBe(true);
				expect(collectPendingToolCalls(branch)).toEqual([]);
				expect(await Bun.file(source).text()).toBe(sourceText);

				const resultEntry = branch.find(
					entry =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === "toolu_live",
				);
				if (resultEntry?.type !== "message" || resultEntry.message.role !== "toolResult") {
					throw new Error("expected the unknown tool result");
				}
				expect(resultEntry.message.isError).toBe(true);
				expect(resultEntry.message).not.toHaveProperty("details");
				expect(
					resultEntry.message.content.some(
						block => block.type === "text" && block.text.includes("may still be running this tool"),
					),
				).toBe(true);

				const forkFile = forked.getSessionFile();
				if (!forkFile) throw new Error("Expected a persisted fork file");
				const persistedEntries = await loadEntriesFromFile(forkFile);
				const forkHeader = persistedEntries.find(entry => entry.type === "session");
				expect(forkHeader?.parentSession).toBe(id);
				const persistedResult = persistedEntries.find(
					entry =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === "toolu_live",
				);
				if (persistedResult?.type !== "message" || persistedResult.message.role !== "toolResult") {
					throw new Error("expected the unknown result to be persisted");
				}
				expect(persistedResult.message.isError).toBe(true);
				expect(persistedResult.message).not.toHaveProperty("details");
			} finally {
				vi.restoreAllMocks();
				await fsp.rm(cwd, { recursive: true, force: true });
			}
		},
	);

	it("rejects --fork with missing path without writing a session (#11491)", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-fork-missing-path-"));
		const sessionDir = path.join(cwd, "sessions");
		const missingPath = path.join(cwd, "ghost-zz9q.jsonl");
		try {
			await expect(
				createSessionManager(buildForkArgs(missingPath, false, sessionDir), cwd, stubSettings),
			).rejects.toMatchObject({
				name: "SessionResolutionError",
				message: `Session "${missingPath}" not found.`,
				hint: expect.stringContaining("omp --resume"),
			});
			await expect(fsp.readdir(sessionDir)).resolves.toEqual([]);
		} finally {
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("forkFrom rejects a missing source without writing a session (#11491)", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-fork-missing-path-"));
		const sessionDir = path.join(cwd, "sessions");
		const missingPath = path.join(cwd, "ghost-zz9q.jsonl");
		try {
			const caught = await SessionManager.forkFrom(missingPath, cwd, sessionDir).catch((err: unknown) => err);
			expect(caught).toBeInstanceOf(ForkSourceNotFoundError);
			expect(caught).toMatchObject({
				message: `Session "${missingPath}" not found.`,
			});
			await expect(fsp.readdir(sessionDir)).resolves.toEqual([]);
		} finally {
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("forkFrom rejects a vanished source on the streaming path (#11491)", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-fork-missing-path-"));
		const sessionDir = path.join(cwd, "sessions");
		const missingPath = path.join(cwd, "ghost-zz9q.jsonl");
		const storage = new FileSessionStorage();
		const realStatSync = storage.statSync.bind(storage);
		vi.spyOn(storage, "statSync").mockImplementation(((filePath: string) =>
			filePath === missingPath
				? { size: 8 * 1024 * 1024, mtimeMs: Date.now(), mtime: new Date() }
				: realStatSync(filePath)) as typeof storage.statSync);
		try {
			const caught = await SessionManager.forkFrom(missingPath, cwd, sessionDir, storage).catch(
				(err: unknown) => err,
			);
			expect(caught).toBeInstanceOf(ForkSourceNotFoundError);
			await expect(fsp.readdir(sessionDir)).resolves.toEqual([]);
		} finally {
			vi.restoreAllMocks();
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects --fork <id> when resolved session vanished before forkFrom reads it (#11491)", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-fork-vanished-id-"));
		const sessionDir = path.join(cwd, "sessions");
		const vanishedPath = path.join(cwd, "vanished.jsonl");
		const forkId = "019ea530-0000-7000-0000-000000000000";
		const session: sessionListingModule.SessionInfo = {
			id: forkId,
			path: vanishedPath,
			cwd,
			title: "vanished",
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			size: 0,
			firstMessage: "",
			allMessagesText: "",
		};
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue({
			session,
			scope: "local",
		});
		try {
			await expect(
				createSessionManager(buildForkArgs(forkId, false, sessionDir), cwd, stubSettings),
			).rejects.toMatchObject({
				name: "SessionResolutionError",
				message: `Session "${forkId}" not found.`,
				hint: expect.stringContaining("omp --resume"),
			});
			await expect(fsp.readdir(sessionDir)).resolves.toEqual([]);
		} finally {
			vi.restoreAllMocks();
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects --fork with ENOTDIR path without writing a session (#11491)", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-fork-enotdir-"));
		const sessionDir = path.join(cwd, "sessions");
		const regularFile = path.join(cwd, "file.txt");
		await Bun.write(regularFile, "not a directory");
		const enotdirChild = path.join(regularFile, "child.jsonl");
		try {
			await expect(
				createSessionManager(buildForkArgs(enotdirChild, false, sessionDir), cwd, stubSettings),
			).rejects.toMatchObject({
				name: "SessionResolutionError",
				message: `Session "${enotdirChild}" not found.`,
				hint: expect.stringContaining("omp --resume"),
			});
			await expect(fsp.readdir(sessionDir)).resolves.toEqual([]);
		} finally {
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	// Windows reports a path through a regular file as ENOENT, never ENOTDIR.
	it.skipIf(process.platform === "win32")(
		"propagates ENOTDIR on ordinary session loads when throwIfMissing is false (#11491)",
		async () => {
			const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-enotdir-ordinary-"));
			const regularFile = path.join(cwd, "file.txt");
			await Bun.write(regularFile, "not a directory");
			const enotdirChild = path.join(regularFile, "child.jsonl");
			try {
				await expect(loadSessionFile(enotdirChild)).rejects.toMatchObject({
					code: "ENOTDIR",
				});
			} finally {
				await fsp.rm(cwd, { recursive: true, force: true });
			}
		},
	);

	it("rejects --resume combined with --no-session instead of silently discarding it (#12008)", async () => {
		await expect(
			createSessionManager({ ...buildResumeArgs("019ea530"), noSession: true }, "/current/project", stubSettings),
		).rejects.toMatchObject({
			name: "SessionResolutionError",
			message: "--resume requires session persistence",
			hint: undefined,
		});
	});

	it("defers --resume + --no-session rejection while extension flag ownership is unresolved", async () => {
		const manager = await createSessionManager(
			{ ...buildResumeArgs("019ea530"), noSession: true },
			"/current/project",
			stubSettings,
			async () => "unavailable",
			{ nativeFlagOwnership: "preliminary" },
		);

		expect(manager?.getEntries()).toEqual([]);
	});

	it("rejects the --resume picker (no value) combined with --no-session (#12008)", async () => {
		await expect(
			createSessionManager(
				{ ...buildResumeArgs("019ea530"), resume: true, noSession: true },
				"/current/project",
				stubSettings,
			),
		).rejects.toMatchObject({
			name: "SessionResolutionError",
			message: "--resume requires session persistence",
		});
	});

	it("rejects --continue combined with --no-session (#12008)", async () => {
		await expect(
			createSessionManager(
				{ ...buildContinueArgs("hello there"), noSession: true },
				"/current/project",
				stubSettings,
			),
		).rejects.toMatchObject({
			name: "SessionResolutionError",
			message: "--continue requires session persistence",
		});
	});
});

describe("session boundary before transcript loading", () => {
	it.each(["cli", "environment", "config"] as const)(
		"rejects foreign initial resume/fork before reads with %s policy and correct precedence",
		async source => {
			const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-boundary-"));
			const root = path.join(cwd, "owned");
			const foreign = path.join(cwd, "2026-11-13T00-00-00-000Z_foreign.jsonl");
			await fsp.mkdir(root);
			await fsp.writeFile(foreign, `${JSON.stringify({ type: "session", id: "foreign", cwd })}\n`);
			await fsp.writeFile(path.join(cwd, "2026-11-13T00-00-01-000Z_sibling.jsonl"),
				`${JSON.stringify({ type: "session", id: "sibling", cwd, continuationOf: "foreign" })}\n`);
			const release = configureSessionBoundaryRoot();
			const previousEnv = process.env.OMP_SESSION_BOUNDARY_ROOT;
			if (source === "config") delete process.env.OMP_SESSION_BOUNDARY_ROOT;
			else process.env.OMP_SESSION_BOUNDARY_ROOT = source === "cli" ? cwd : root;
			const configured = Settings.isolated({ sessionBoundaryRoot: source === "config" ? root : cwd });
			const read = vi.spyOn(FileSessionStorage.prototype, "readText");
			const slices = vi.spyOn(FileSessionStorage.prototype, "readTextSlices");
			try {
				for (const route of ["resume", "fork"]) {
					const args = parseArgs([
						"--session-dir", root,
						...(source === "cli" ? ["--session-boundary-root", root] : []),
						`--${route}`, foreign,
					]);
					await expect(createSessionManager(args, cwd, configured)).rejects.toThrow("outside session boundary");
				}
				expect(read).not.toHaveBeenCalled();
				expect(slices).not.toHaveBeenCalled();
			} finally {
				vi.restoreAllMocks();
				release();
				if (previousEnv === undefined) delete process.env.OMP_SESSION_BOUNDARY_ROOT;
				else process.env.OMP_SESSION_BOUNDARY_ROOT = previousEnv;
				await fsp.rm(cwd, { recursive: true, force: true });
			}
		},
	);

	it("excludes foreign continuation prefixes and indexed picker rows before reads", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-boundary-listing-"));
		const root = path.join(cwd, "owned");
		await fsp.mkdir(root);
		const owned = path.join(root, "2026-11-13T00-00-00-000Z_owned.jsonl");
		const foreignDir = path.join(cwd, "foreign");
		await fsp.mkdir(foreignDir);
		const foreign = path.join(foreignDir, "2026-11-13T00-00-01-000Z_foreign.jsonl");
		const alias = path.join(root, path.basename(foreign));
		await fsp.writeFile(owned, `${JSON.stringify({
			type: "session", version: 3, id: "owned", cwd, timestamp: "2026-11-13T00:00:00.000Z",
		})}\n`);
		await fsp.appendFile(owned, `${JSON.stringify({
			type: "message", id: "owned-turn", timestamp: "2026-11-13T00:00:00.001Z",
			message: { role: "user", content: "Owned prompt", timestamp: Date.now() },
		})}\n`);
		await fsp.writeFile(foreign, `${JSON.stringify({
			type: "session", version: 3, id: "foreign", cwd, continuationOf: "owned",
			timestamp: "2026-11-13T00:00:01.000Z",
		})}\n`);
		await fsp.symlink(foreign, alias);
		const release = configureSessionBoundaryRoot(root);
		const slices = vi.spyOn(FileSessionStorage.prototype, "readTextSlices");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		setAgentDir(path.join(cwd, "agent"));
		sessionIndexModule.recordSessionTitle("owned", "Owned title");
		sessionIndexModule.recordSessionTitle("foreign", "Foreign private title");
		try {
			const storage = new FileSessionStorage();
			expect(sessionIndexModule.lookupSessionTitle("foreign")).toBe("Foreign private title");
			expect(await sessionListingModule.findSessionContinuation(owned, storage)).toBeUndefined();
			const listing = await sessionListingModule.listSessionsForPicker(root, storage, new Set());
			expect(listing.sessions.map(session => session.id)).toEqual(["owned"]);
			expect((await listing.complete).map(session => session.id)).toEqual(["owned"]);
			const all = await sessionListingModule.listAllSessionsForPicker(storage, new Set(), cwd);
			expect(all.sessions.map(session => session.id)).toEqual(["owned"]);
			expect((await all.complete).map(session => session.id)).toEqual(["owned"]);
			const outside = await sessionListingModule.listSessionsForPicker(foreignDir, storage, new Set());
			expect(outside.sessions).toEqual([]);
			expect(await outside.complete).toEqual([]);
			expect(await sessionListingModule.getRecentSessions(foreignDir, 4, storage)).toEqual([]);
			expect((await sessionListingModule.getRecentSessions(root, 4, storage)).map(session => session.path))
				.toEqual([owned]);
			expect(slices.mock.calls.every(([file]) => file !== foreign && file !== alias)).toBe(true);
		} finally {
			vi.restoreAllMocks();
			sessionIndexModule.closeSessionIndex();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			__resetDirsFromEnvForTests();
			release();
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("latches inherited environment for SDK opens before main or SDK bootstrap", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-boundary-env-"));
		const foreign = path.join(cwd, "foreign.jsonl");
		await fsp.writeFile(foreign, `${JSON.stringify({ type: "session", id: "foreign", cwd })}\n`);
		const release = configureSessionBoundaryRoot();
		const previousEnv = process.env.OMP_SESSION_BOUNDARY_ROOT;
		process.env.OMP_SESSION_BOUNDARY_ROOT = path.join(cwd, "owned");
		const read = vi.spyOn(FileSessionStorage.prototype, "readText");
		try {
			await expect(SessionManager.open(foreign)).rejects.toThrow("outside session boundary");
			delete process.env.OMP_SESSION_BOUNDARY_ROOT;
			await expect(SessionManager.open(foreign)).rejects.toThrow("outside session boundary");
			expect(read).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			release();
			if (previousEnv === undefined) delete process.env.OMP_SESSION_BOUNDARY_ROOT;
			else process.env.OMP_SESSION_BOUNDARY_ROOT = previousEnv;
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects missing and blank CLI roots rather than disabling the boundary", () => {
		for (const args of [[], [""], ["--resume", "secret.jsonl"]]) {
			expect(() => parseArgs(["--session-boundary-root", ...args])).toThrow("requires a path");
		}
	});

	it("rejects SDK opens, forks and switches through symlinked ancestors before reading", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-boundary-link-"));
		const root = path.join(cwd, "owned");
		const foreignDir = path.join(cwd, "foreign");
		await fsp.mkdir(root);
		await fsp.mkdir(foreignDir);
		const foreign = path.join(foreignDir, "secret.jsonl");
		await fsp.writeFile(foreign, `${JSON.stringify({ type: "session", id: "foreign", cwd })}\n`);
		await fsp.symlink(foreignDir, path.join(root, "escape"), "dir");
		await fsp.symlink(foreign, path.join(root, "file.jsonl"));
		const release = configureSessionBoundaryRoot(root);
		const manager = SessionManager.create(cwd, root);
		const read = vi.spyOn(FileSessionStorage.prototype, "readText");
		try {
			for (const source of [
				foreign,
				path.join(root, "file.jsonl"),
				path.join(root, "escape", "secret.jsonl"),
				path.join(root, "escape", "missing", "secret.jsonl"),
			]) {
				await expect(SessionManager.open(source, root)).rejects.toThrow("outside session boundary");
				await expect(SessionManager.forkFrom(source, cwd, root)).rejects.toThrow("outside session boundary");
				await expect(manager.setSessionFile(source)).rejects.toThrow("outside session boundary");
			}
			expect(read).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			await manager.close();
			release();
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects symlink-parent traversal in initial opens, SDK APIs and header readers before reading", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-boundary-parent-"));
		const root = path.join(cwd, "owned");
		const foreign = path.join(cwd, "foreign");
		await fsp.mkdir(root);
		await fsp.mkdir(path.join(foreign, "subdir"), { recursive: true });
		for (const [dir, id] of [[root, "owned"], [foreign, "foreign"]]) {
			await fsp.writeFile(path.join(dir, "secret.jsonl"), `${JSON.stringify({ type: "session", id, cwd })}\n`);
		}
		const link = path.join(root, "link");
		await fsp.symlink(path.join(foreign, "subdir"), link, "dir");
		// Do not use path.join: that would erase the traversal this regression exercises.
		const source = `${link}${path.sep}..${path.sep}secret.jsonl`;
		const release = configureSessionBoundaryRoot(root);
		const read = vi.spyOn(FileSessionStorage.prototype, "readText");
		const open = vi.spyOn(fsp, "open");
		try {
			for (const args of [buildResumeArgs(source, root), buildForkArgs(source, false, root)]) {
				await expect(createSessionManager(args, cwd, stubSettings)).rejects.toThrow("parent traversal");
			}
			await expect(SessionManager.open(source, root)).rejects.toThrow("parent traversal");
			await expect(SessionManager.forkFrom(source, cwd, root)).rejects.toThrow("parent traversal");
			await expect(readSessionHeaderId(source)).rejects.toThrow("parent traversal");
			expect(read).not.toHaveBeenCalled();
			expect(open).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			release();
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("keeps same-root resume, continue, fork and nested child journals working", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-boundary-owned-"));
		const root = path.join(cwd, "owned");
		const release = configureSessionBoundaryRoot(root);
		const managers: SessionManager[] = [];
		try {
			const original = SessionManager.create(cwd, root);
			managers.push(original);
			original.appendMessage({ role: "user", content: "owned history", timestamp: Date.now() });
			await original.setSessionName("owned history", "user");
			await original.rewriteEntries();
			const source = original.getSessionFile()!;
			await original.close();
			const alias = path.join(cwd, "owned-alias");
			await fsp.symlink(root, alias, "dir");
			const resumed = await createSessionManager(buildResumeArgs(path.join(alias, path.basename(source)), root), cwd, stubSettings);
			managers.push(resumed!);
			expect(resumed!.getSessionId()).toBe(original.getSessionId());
			await resumed!.close();
			const continued = await SessionManager.continueRecent(cwd, root);
			managers.push(continued);
			expect(continued.getSessionId()).toBe(original.getSessionId());
			await continued.close();
			const children = path.join(root, "parent", "children");
			const forked = await SessionManager.forkFrom(source, cwd, children, undefined, {
				sessionFile: path.join(children, "child.jsonl"),
				suppressBreadcrumb: true,
			});
			managers.push(forked);
			expect(forked.getEntries().some(entry => entry.type === "message" && entry.message.role === "user")).toBe(true);
			await forked.close();
			const child = await SessionManager.open(forked.getSessionFile()!);
			managers.push(child);
			expect(child.getSessionId()).toBe(forked.getSessionId());
		} finally {
			for (const manager of managers) await manager.close();
			release();
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});
});
