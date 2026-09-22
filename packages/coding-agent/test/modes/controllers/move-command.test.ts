import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createRecentAwareSource,
	getRecentWorkingDirectories,
	MAX_RECENT_DIRS,
} from "@oh-my-pi/pi-coding-agent/modes/move-directory-source";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { MoveDirectoryEntry } from "@oh-my-pi/pi-tui/overlays/move-overlay";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import * as sessionWorktree from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import { Container } from "@oh-my-pi/pi-tui";

function createMoveContext(sourceDir: string, settingsFlush?: () => Promise<void>) {
	const state = { cwd: sourceDir, movedTo: undefined as string | undefined, completedBtwVisible: true };
	const present = vi.fn();
	const applyCwdChange = vi.fn(async (cwd: string) => {
		expect(state.cwd).toBe(cwd);
		return true;
	});
	const moveSession = vi.fn(async (cwd: string) => {
		state.cwd = cwd;
		state.movedTo = cwd;
	});
	const sessionDir = `${sourceDir}/.sessions`;
	const captureState = vi.fn(() => ({ cwd: state.cwd, sessionDir, movedTo: state.movedTo }));
	const restoreState = vi.fn((snapshot: { cwd: string }) => {
		state.cwd = snapshot.cwd;
	});
	const rollbackMove = vi.fn(async (snapshot: { cwd: string }) => {
		state.cwd = snapshot.cwd;
		state.movedTo = snapshot.cwd;
		restoreState(snapshot);
	});
	const shutdown = vi.fn(async () => {});
	const withBtwSessionMove = vi.fn(async (operation: () => Promise<boolean>) => {
		const moved = await operation();
		if (moved) state.completedBtwVisible = false;
		return moved;
	});
	const ctx = {
		session: { isStreaming: false, moveSession },
		sessionManager: {
			getCwd: () => state.cwd,
			captureState,
			restoreState,
			rollbackMove,
			dropSession: vi.fn(async () => {}),
		},
		settings: {
			flush: vi.fn(settingsFlush ?? (async () => {})),
		},
		showHookCustom: vi.fn(),
		showHookConfirm: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		applyCwdChange,
		withBtwSessionMove,
		updateEditorBorderColor: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		statusContainer: new Container(),
		present,
		shutdown,
	} as unknown as InteractiveModeContext;
	return { ctx, state, present, captureState, restoreState, rollbackMove, shutdown, sessionDir, withBtwSessionMove };
}

describe("CommandController /move", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	afterEach(() => vi.restoreAllMocks());

	it("does not create a checkout when the BTW gate rejects a worktree command", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-gate-"));
		try {
			const { ctx, state } = createMoveContext(sourceDir);
			const target = path.join(sourceDir, "checkout");
			vi.spyOn(sessionWorktree, "createSessionWorktree").mockImplementation(async () => {
				await fs.mkdir(target);
				return { path: target, branch: "feature" };
			});
			ctx.withBtwSessionMove = vi.fn(async () => false);
			await new CommandController(ctx).handleWorktreeCommand("feature");

			expect(await fs.readdir(sourceDir)).toEqual([]);
			expect(state.cwd).toBe(sourceDir);
			expect(state.completedBtwVisible).toBe(true);
			expect(ctx.session.moveSession).not.toHaveBeenCalled();
			expect(ctx.present).not.toHaveBeenCalled();
			expect(ctx.statusContainer.children).toHaveLength(0);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("holds one migration gate through worktree creation, relocation and source cleanup", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-lifecycle-"));
		const creating = Promise.withResolvers<void>();
		const created = Promise.withResolvers<void>();
		const relocating = Promise.withResolvers<void>();
		const relocated = Promise.withResolvers<void>();
		let command: Promise<void> | undefined;
		try {
			const { ctx, state } = createMoveContext(sourceDir);
			const target = path.join(sourceDir, "checkout");
			let held = false;
			let commits = 0;
			ctx.withBtwSessionMove = async operation => {
				if (held) throw new Error("Nested migration gate");
				held = true;
				try {
					const moved = await operation();
					if (moved) commits++;
					return moved;
				} finally {
					held = false;
				}
			};
			vi.spyOn(sessionWorktree, "createSessionWorktree").mockImplementation(async () => {
				expect(held).toBe(true);
				creating.resolve();
				await created.promise;
				await fs.mkdir(target);
				return { path: target, branch: "feature" };
			});
			ctx.session.moveSession = async cwd => {
				expect(held).toBe(true);
				relocating.resolve();
				await relocated.promise;
				state.cwd = cwd;
			};
			const cleanup = vi.spyOn(sessionWorktree, "cleanSourceCheckoutIfConfigured").mockImplementation(async () => {
				expect(held).toBe(true);
				expect(state.cwd).toBe(target);
				return { cleaned: false };
			});
			command = new CommandController(ctx).handleWorktreeCommand("feature");
			await creating.promise;
			expect(held).toBe(true);
			expect(commits).toBe(0);
			created.resolve();
			await relocating.promise;
			expect(held).toBe(true);
			expect(state.cwd).toBe(sourceDir);
			expect(cleanup).not.toHaveBeenCalled();
			relocated.resolve();
			await command;
			expect(held).toBe(false);
			expect(commits).toBe(1);
			expect(state.cwd).toBe(target);
			expect(ctx.present).toHaveBeenCalled();
			expect(ctx.statusContainer.children).toHaveLength(0);
		} finally {
			created.resolve();
			relocated.resolve();
			await command;
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("releases the gate without relocating when worktree creation fails", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-failure-"));
		try {
			const { ctx, state, withBtwSessionMove } = createMoveContext(sourceDir);
			vi.spyOn(sessionWorktree, "createSessionWorktree").mockRejectedValue(new Error("Branch already exists"));
			await new CommandController(ctx).handleWorktreeCommand("feature");

			expect(await withBtwSessionMove.mock.results[0]?.value).toBe(false);
			expect(state.cwd).toBe(sourceDir);
			expect(state.completedBtwVisible).toBe(true);
			expect(ctx.session.moveSession).not.toHaveBeenCalled();
			expect(ctx.statusContainer.children).toHaveLength(0);
			expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("Branch already exists"));
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("relocates the active session before re-scoping cwd-derived state", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, state, present } = createMoveContext(sourceDir);
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(state.movedTo).toBe(targetDir);
			expect(state.completedBtwVisible).toBe(false);
			expect(ctx.sessionManager.dropSession).not.toHaveBeenCalled();
			expect(ctx.applyCwdChange).toHaveBeenCalledWith(targetDir);
			expect(ctx.updateEditorBorderColor).toHaveBeenCalled();
			expect(ctx.reloadTodos).toHaveBeenCalled();
			expect(ctx.ui.requestRender).toHaveBeenCalledWith();
			expect(present).toHaveBeenCalled();
			expect(ctx.showError).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("restores captured manager state when cwd application fails", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, state, captureState, restoreState, rollbackMove, shutdown, withBtwSessionMove } =
				createMoveContext(sourceDir);
			let applyCount = 0;
			ctx.applyCwdChange = vi.fn(async () => {
				applyCount += 1;
				return applyCount > 1;
			});
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(ctx.session.moveSession).toHaveBeenCalledTimes(1);
			expect(rollbackMove).toHaveBeenCalledWith(captureState.mock.results[0]?.value);
			expect(state.cwd).toBe(sourceDir);
			expect(state.completedBtwVisible).toBe(true);
			expect(await withBtwSessionMove.mock.results[0]?.value).toBe(false);
			expect(restoreState).toHaveBeenCalledWith(captureState.mock.results[0]?.value);
			expect(shutdown).not.toHaveBeenCalled();
			expect(ctx.updateEditorBorderColor).not.toHaveBeenCalled();
			expect(ctx.reloadTodos).not.toHaveBeenCalled();
			expect(ctx.ui.requestRender).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});
	it("shuts down when rollback and workspace realignment both fail", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, shutdown, rollbackMove } = createMoveContext(sourceDir);
			let applyCount = 0;
			ctx.applyCwdChange = vi.fn(async () => {
				applyCount += 1;
				if (applyCount === 1) throw new Error("target setup failed");
				return false;
			});
			rollbackMove.mockRejectedValueOnce(new Error("rollback denied"));
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(shutdown).toHaveBeenCalledTimes(1);
			expect(ctx.present).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});
	it("stops recovery after aligning with the moved session", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, shutdown, rollbackMove } = createMoveContext(sourceDir);
			ctx.applyCwdChange = vi
				.fn()
				.mockRejectedValueOnce(new Error("target setup failed"))
				.mockResolvedValueOnce(true)
				.mockResolvedValueOnce(true);
			rollbackMove.mockRejectedValueOnce(new Error("rollback denied"));
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(ctx.applyCwdChange).toHaveBeenCalledTimes(2);
			expect(ctx.applyCwdChange).toHaveBeenNthCalledWith(1, targetDir);
			expect(ctx.applyCwdChange).toHaveBeenNthCalledWith(2, targetDir);
			expect(shutdown).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("does not prompt or create a move target when pending settings flush fails", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = path.join(sourceDir, "destination");
		try {
			const { ctx, state, withBtwSessionMove } = createMoveContext(sourceDir, async () => {
				throw new Error("disk full");
			});
			ctx.showHookConfirm = vi.fn(async () => true);
			const mkdir = vi.spyOn(fs, "mkdir");
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
			expect(ctx.showHookConfirm).not.toHaveBeenCalled();
			expect(mkdir).not.toHaveBeenCalled();
			expect(await fs.readdir(sourceDir)).toEqual([]);
			expect(ctx.session.moveSession).not.toHaveBeenCalled();
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(withBtwSessionMove).not.toHaveBeenCalled();
			expect(state.completedBtwVisible).toBe(true);
			expect(state.movedTo).toBeUndefined();
			expect(state.cwd).toBe(sourceDir);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it.each(["cancelled picker", "empty path", "missing parent", "declined creation", "streaming"] as const)(
		"preserves the session and BTW state when /move is cancelled or rejected on %s",
		async rejection => {
			const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
			try {
				const { ctx, state, withBtwSessionMove } = createMoveContext(sourceDir);
				const targetDir = path.join(sourceDir, "destination");
				let targetPath: string | undefined = targetDir;
				switch (rejection) {
					case "cancelled picker":
						targetPath = undefined;
						break;
					case "empty path":
						targetPath = '""';
						break;
					case "missing parent":
						targetPath = path.join(targetDir, "nested");
						break;
					case "declined creation":
						ctx.showHookConfirm = vi.fn(async () => false);
						break;
					case "streaming":
						Object.defineProperty(ctx.session, "isStreaming", { value: true });
						break;
				}
				const controller = new CommandController(ctx);

				await controller.handleMoveCommand(targetPath);

				if (rejection === "declined creation") {
					expect(withBtwSessionMove).toHaveBeenCalledTimes(1);
					expect(await withBtwSessionMove.mock.results[0]?.value).toBe(false);
				} else {
					expect(withBtwSessionMove).not.toHaveBeenCalled();
				}
				expect(ctx.session.moveSession).not.toHaveBeenCalled();
				expect(ctx.applyCwdChange).not.toHaveBeenCalled();
				expect(state.cwd).toBe(sourceDir);
				expect(state.movedTo).toBeUndefined();
				expect(state.completedBtwVisible).toBe(true);
				expect(ctx.present).not.toHaveBeenCalled();
				await expect(fs.stat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				await fs.rm(sourceDir, { recursive: true, force: true });
			}
		},
	);

	it("does not prompt or create a move target when the BTW migration gate refuses", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-gate-"));
		try {
			const { ctx, state } = createMoveContext(sourceDir);
			const targetDir = path.join(sourceDir, "destination");
			ctx.showHookConfirm = vi.fn(async () => true);
			ctx.withBtwSessionMove = vi.fn(async () => false);
			const mkdir = vi.spyOn(fs, "mkdir");

			await new CommandController(ctx).handleMoveCommand(targetDir);

			expect(ctx.withBtwSessionMove).toHaveBeenCalledTimes(1);
			expect(ctx.showHookConfirm).not.toHaveBeenCalled();
			expect(mkdir).not.toHaveBeenCalled();
			expect(await fs.readdir(sourceDir)).toEqual([]);
			expect(ctx.session.moveSession).not.toHaveBeenCalled();
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(state.cwd).toBe(sourceDir);
			expect(state.movedTo).toBeUndefined();
			expect(state.completedBtwVisible).toBe(true);
			expect(ctx.present).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it.each([true, false])(
		"holds the move gate across creation confirmation and only commits an accepted move (confirmed=%s)",
		async confirmed => {
			const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-lifecycle-"));
			const confirming = Promise.withResolvers<void>();
			const confirmation = Promise.withResolvers<boolean>();
			const creating = Promise.withResolvers<void>();
			const created = Promise.withResolvers<void>();
			const relocating = Promise.withResolvers<void>();
			const relocated = Promise.withResolvers<void>();
			let command: Promise<void> | undefined;
			try {
				const { ctx, state } = createMoveContext(sourceDir);
				const targetDir = path.join(sourceDir, "destination");
				const sourceFile = path.join(sourceDir, "session.jsonl");
				const targetFile = path.join(targetDir, "session.jsonl");
				await Bun.write(sourceFile, "session data\n");
				let held = false;
				let commits = 0;
				ctx.withBtwSessionMove = vi.fn(async operation => {
					if (held) throw new Error("Nested migration gate");
					held = true;
					try {
						const moved = await operation();
						if (moved) {
							commits++;
							state.completedBtwVisible = false;
						}
						return moved;
					} finally {
						held = false;
					}
				});
				ctx.showHookConfirm = vi.fn(async () => {
					confirming.resolve();
					return confirmation.promise;
				});
				const originalMkdir = fs.mkdir;
				const mkdir = vi.spyOn(fs, "mkdir").mockImplementation(async (directory, options): Promise<undefined> => {
					creating.resolve();
					await created.promise;
					await originalMkdir(directory, options);
					return undefined;
				});
				ctx.session.moveSession = vi.fn(async cwd => {
					relocating.resolve();
					await relocated.promise;
					await fs.rename(sourceFile, targetFile);
					state.cwd = cwd;
					state.movedTo = cwd;
				});
				command = new CommandController(ctx).handleMoveCommand(targetDir);
				await confirming.promise;
				expect(held).toBe(true);
				expect(commits).toBe(0);
				expect(state.completedBtwVisible).toBe(true);
				expect(mkdir).not.toHaveBeenCalled();
				expect(await fs.readdir(sourceDir)).toEqual(["session.jsonl"]);
				confirmation.resolve(confirmed);
				if (confirmed) {
					await creating.promise;
					expect(held).toBe(true);
					expect(commits).toBe(0);
					expect(ctx.session.moveSession).not.toHaveBeenCalled();
					created.resolve();
					await relocating.promise;
					expect((await fs.stat(targetDir)).isDirectory()).toBe(true);
					expect(held).toBe(true);
					expect(commits).toBe(0);
					expect(state.cwd).toBe(sourceDir);
					relocated.resolve();
				}
				await command;

				expect(held).toBe(false);
				expect(ctx.withBtwSessionMove).toHaveBeenCalledTimes(1);
				expect(ctx.showHookConfirm).toHaveBeenCalledTimes(1);
				expect(mkdir).toHaveBeenCalledTimes(confirmed ? 1 : 0);
				expect(ctx.session.moveSession).toHaveBeenCalledTimes(confirmed ? 1 : 0);
				expect(commits).toBe(confirmed ? 1 : 0);
				expect(state.completedBtwVisible).toBe(!confirmed);
				expect(state.cwd).toBe(confirmed ? targetDir : sourceDir);
				if (confirmed) {
					expect(await Bun.file(targetFile).text()).toBe("session data\n");
					expect(await Bun.file(sourceFile).exists()).toBe(false);
					expect(ctx.present).toHaveBeenCalledTimes(1);
				} else {
					expect(await Bun.file(sourceFile).text()).toBe("session data\n");
					expect(await fs.readdir(sourceDir)).toEqual(["session.jsonl"]);
					expect(ctx.applyCwdChange).not.toHaveBeenCalled();
					expect(ctx.present).not.toHaveBeenCalled();
				}
			} finally {
				confirmation.resolve(false);
				created.resolve();
				relocated.resolve();
				await command;
				await fs.rm(sourceDir, { recursive: true, force: true });
			}
		},
	);

	it("does not relocate session files or cwd when the BTW migration gate refuses", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, state } = createMoveContext(sourceDir);
			const sourceFile = path.join(sourceDir, "session.jsonl");
			const targetFile = path.join(targetDir, "session.jsonl");
			await Bun.write(sourceFile, "session data\n");
			ctx.session.moveSession = vi.fn(async cwd => {
				await fs.rename(sourceFile, targetFile);
				state.cwd = cwd;
				state.movedTo = cwd;
			});
			ctx.withBtwSessionMove = vi.fn(async () => false);
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(await Bun.file(sourceFile).text()).toBe("session data\n");
			expect(await Bun.file(targetFile).exists()).toBe(false);
			expect(state.cwd).toBe(sourceDir);
			expect(state.movedTo).toBeUndefined();
			expect(state.completedBtwVisible).toBe(true);
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(ctx.present).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("preserves completed BTW state when moving the session fails", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, state, withBtwSessionMove } = createMoveContext(sourceDir);
			ctx.session.moveSession = vi.fn(async () => {
				throw new Error("session move denied");
			});
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(await withBtwSessionMove.mock.results[0]?.value).toBe(false);
			expect(state.completedBtwVisible).toBe(true);
			expect(state.cwd).toBe(sourceDir);
			expect(state.movedTo).toBeUndefined();
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(ctx.present).not.toHaveBeenCalled();
			expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("session move denied"));
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});
});

describe("getRecentWorkingDirectories", () => {
	function makeSession(cwd: string, modified: Date, id?: string): SessionInfo {
		return {
			path: `${cwd}/session.jsonl`,
			id: id ?? `session-${cwd}`,
			cwd,
			created: new Date(modified.getTime() - 60000),
			modified,
			messageCount: 1,
			size: 100,
			firstMessage: "test",
			allMessagesText: "test",
		};
	}

	/** In-memory dirExists: resolves paths before checking membership. */
	const dirExistsFor = (...existing: string[]) => {
		const resolved = new Set(existing.map(p => path.resolve(p)));
		return async (p: string) => resolved.has(p);
	};

	it("excludes current cwd from recent directories", async () => {
		const sessions = [
			makeSession("/proj/current", new Date("2026-09-18T12:00:00Z")),
			makeSession("/proj/other", new Date("2026-09-18T11:00:00Z")),
		];
		const recent = await getRecentWorkingDirectories(
			sessions,
			"/proj/current",
			dirExistsFor("/proj/current", "/proj/other"),
		);
		expect(recent).toEqual([path.resolve("/proj/other")]);
	});

	it("deduplicates sessions with the same cwd", async () => {
		const sessions = [
			makeSession("/proj/a", new Date("2026-09-18T12:00:00Z"), "s1"),
			makeSession("/proj/b", new Date("2026-09-18T11:00:00Z"), "s2"),
			makeSession("/proj/a", new Date("2026-09-18T10:00:00Z"), "s3"),
			makeSession("/proj/a", new Date("2026-09-18T09:00:00Z"), "s4"),
		];
		const recent = await getRecentWorkingDirectories(sessions, "/proj/cwd", dirExistsFor("/proj/a", "/proj/b"));
		expect(recent).toEqual([path.resolve("/proj/a"), path.resolve("/proj/b")]);
	});

	it("orders by modified time, not pinned-first order", async () => {
		// Simulate pinned-first: dirA is old but listed first.
		// True recency: B > C > A.
		const sessions = [
			makeSession("/proj/a", new Date("2026-09-16T10:00:00Z"), "pinned"),
			makeSession("/proj/b", new Date("2026-09-18T12:00:00Z"), "recent"),
			makeSession("/proj/c", new Date("2026-09-18T11:00:00Z"), "mid"),
		];
		const recent = await getRecentWorkingDirectories(
			sessions,
			"/proj/cwd",
			dirExistsFor("/proj/a", "/proj/b", "/proj/c"),
		);
		expect(recent).toEqual([path.resolve("/proj/b"), path.resolve("/proj/c"), path.resolve("/proj/a")]);
	});

	it("excludes non-existent directories", async () => {
		const sessions = [
			makeSession("/proj/ghost", new Date("2026-09-18T12:00:00Z")),
			makeSession("/proj/real", new Date("2026-09-18T11:00:00Z")),
		];
		const recent = await getRecentWorkingDirectories(sessions, "/proj/cwd", dirExistsFor("/proj/real"));
		expect(recent).toEqual([path.resolve("/proj/real")]);
	});

	it("scans until 8 valid unique dirs, not just 8 raw sessions", async () => {
		const dirs = Array.from({ length: 12 }, (_, i) => `/proj/d${i}`);
		// First 4 sessions are duplicates/invalid to test scanning past them.
		const sessions: SessionInfo[] = [
			makeSession(dirs[0]!, new Date("2026-09-18T12:00:00Z"), "s0"),
			makeSession(dirs[0]!, new Date("2026-09-18T11:30:00Z"), "s1"), // duplicate
			makeSession("/proj/cwd", new Date("2026-09-18T11:00:00Z"), "s2"), // current cwd
			makeSession("/proj/cwd/ghost", new Date("2026-09-18T10:30:00Z"), "s3"), // deleted
		];
		for (let i = 1; i <= 8; i++) {
			sessions.push(
				makeSession(dirs[i]!, new Date(`2026-09-18T${String(10 - i).padStart(2, "0")}:00:00Z`), `s${i + 4}`),
			);
		}
		const recent = await getRecentWorkingDirectories(
			sessions,
			"/proj/cwd",
			dirExistsFor(...dirs.filter((_, i) => i !== 12)),
		);
		// 8 valid unique dirs despite 4 wasted sessions at the top.
		expect(recent.length).toBe(MAX_RECENT_DIRS);
	});

	it("returns empty array when session list is empty", async () => {
		const recent = await getRecentWorkingDirectories([], "/proj/cwd", dirExistsFor());
		expect(recent).toEqual([]);
	});

	it("returns empty array when all sessions share current cwd", async () => {
		const sessions = [
			makeSession("/proj/cwd", new Date("2026-09-18T12:00:00Z"), "s1"),
			makeSession("/proj/cwd", new Date("2026-09-18T11:00:00Z"), "s2"),
		];
		const recent = await getRecentWorkingDirectories(sessions, "/proj/cwd", dirExistsFor("/proj/cwd"));
		expect(recent).toEqual([]);
	});
});

describe("createRecentAwareSource", () => {
	it("prepends recent dirs on empty prefix", () => {
		const source = createRecentAwareSource(["/path/A", "/path/B"]);
		const results = source.search("", "/cwd", 20) as MoveDirectoryEntry[];
		const recentResults = results.filter(r => r.label.startsWith("↺"));
		expect(recentResults.length).toBe(2);
		expect(recentResults[0]!.value).toBe("/path/A");
		expect(recentResults[0]!.label).toBe("↺ /path/A");
	});

	it("delegates to filesystem source on non-empty prefix", () => {
		const source = createRecentAwareSource(["/path/A"]);
		const results = source.search("some-prefix", "/cwd", 20) as MoveDirectoryEntry[];
		const recentResults = results.filter(r => r.label.startsWith("↺"));
		expect(recentResults.length).toBe(0);
	});

	it("returns filesystem results when no recent dirs provided", () => {
		const source = createRecentAwareSource([]);
		const results = source.search("", "/cwd", 20) as MoveDirectoryEntry[];
		const recentResults = results.filter(r => r.label.startsWith("↺"));
		expect(recentResults.length).toBe(0);
	});

	it("does not duplicate a recent dir that is also a cwd child", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-dedup-"));
		const child = path.join(cwd, "sub");
		await fs.mkdir(child);
		try {
			const source = createRecentAwareSource([child]);
			const results = source.search("", cwd, 20) as MoveDirectoryEntry[];
			// The child resolves to the same path whether reached via the recent
			// row or the filesystem child row — it must appear exactly once.
			const matches = results.filter(r => path.resolve(r.value) === path.resolve(child));
			expect(matches.length).toBe(1);
			expect(matches[0]!.label.startsWith("↺")).toBe(true);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("CommandController /move recent dirs integration", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	afterEach(() => vi.restoreAllMocks());

	it("does not load recent dirs for explicit /move <path>", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-recent-explicit-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-recent-target-"));
		try {
			const { ctx } = createMoveContext(sourceDir);
			const listAllSpy = vi.spyOn(SessionManager, "listAll").mockResolvedValue([]);

			await new CommandController(ctx).handleMoveCommand(targetDir);

			expect(listAllSpy).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("calls SessionManager.listAll when no path argument is given", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-recent-nopath-"));
		try {
			const { ctx } = createMoveContext(sourceDir);
			vi.spyOn(SessionManager, "listAll").mockResolvedValue([]);

			await new CommandController(ctx).handleMoveCommand(undefined);

			expect(SessionManager.listAll).toHaveBeenCalledTimes(1);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});
});
