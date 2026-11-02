import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as sessionWorktree from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import * as worktreeHook from "@oh-my-pi/pi-coding-agent/utils/worktree-hook";
import { type Component, Container, Text } from "@oh-my-pi/pi-tui";
import { BorderedLoader } from "@oh-my-pi/pi-tui/overlays/bordered-loader";
import { TempDir } from "@oh-my-pi/pi-utils";

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
	const editor = new Container();
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const ctx = {
		session: { isStreaming: false, moveSession, refreshSkillsAndCommands: vi.fn(async () => {}) },
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
		ui: {
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
			setFocus: vi.fn(),
			getFocused: vi.fn(() => editor),
		},
		statusContainer: new Container(),
		editor,
		editorContainer,
		present,
		shutdown,
	} as unknown as InteractiveModeContext;
	const selectors = new SelectorController(ctx);
	ctx.showSelector = create => selectors.showSelector(create);
	return { ctx, state, present, captureState, restoreState, rollbackMove, shutdown, sessionDir, withBtwSessionMove };
}

/** A checkout into `target` that `/wt` can move into, with source cleanup stubbed out. */
function stubCheckout(sourceDir: string, target: string): void {
	vi.spyOn(sessionWorktree, "createSessionWorktree").mockImplementation(async () => {
		await fs.mkdir(target);
		return { path: target, branch: "feature", sourceCwd: sourceDir, baseCommit: "0", keptChanges: true };
	});
	vi.spyOn(sessionWorktree, "cleanSourceCheckoutIfConfigured").mockResolvedValue({ cleaned: false });
}

describe("CommandController /move", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("does not create a checkout when the BTW gate rejects a worktree command", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-gate-"));
		try {
			const { ctx, state } = createMoveContext(sourceDir);
			const target = path.join(sourceDir, "checkout");
			vi.spyOn(sessionWorktree, "createSessionWorktree").mockImplementation(async () => {
				await fs.mkdir(target);
				return { path: target, branch: "feature", sourceCwd: sourceDir, baseCommit: "0", keptChanges: true };
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

	it("holds one migration gate through worktree creation, relocation, source cleanup and the hook", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-lifecycle-"));
		const creating = Promise.withResolvers<void>();
		const created = Promise.withResolvers<void>();
		const relocating = Promise.withResolvers<void>();
		const relocated = Promise.withResolvers<void>();
		let command: Promise<unknown> | undefined;
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
				return { path: target, branch: "feature", sourceCwd: sourceDir, baseCommit: "0", keptChanges: true };
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
			let hookSaw: { held: boolean; cwd: string } | undefined;
			vi.spyOn(worktreeHook, "runPostCheckoutHook").mockImplementation(async () => {
				hookSaw = { held, cwd: state.cwd };
				return { status: "ok" };
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
			expect(hookSaw).toEqual({ held: true, cwd: target });
			expect(ctx.statusContainer.children).toHaveLength(0);
		} finally {
			created.resolve();
			relocated.resolve();
			await command;
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("still reports the move and the source cleanup when the rescan after the hook fails", async () => {
		await using temp = await TempDir.create("@omp-wt-rescan-fails-");
		const { ctx } = createMoveContext(temp.path());
		stubCheckout(temp.path(), path.join(temp.path(), "checkout"));
		vi.spyOn(sessionWorktree, "cleanSourceCheckoutIfConfigured").mockResolvedValue({
			cleaned: false,
			errorMessage: "index.lock exists",
		});
		vi.spyOn(worktreeHook, "runPostCheckoutHook").mockResolvedValue({ status: "ok" });
		// A loader error that quotes a long source line, control characters included.
		ctx.session.refreshSkillsAndCommands = vi.fn(async () => {
			throw new Error(`bad \x1b[31mskill\x1b[0m\nfile ${"x".repeat(500)}`);
		});
		const created = await new CommandController(ctx).handleWorktreeCommand("feature");

		expect(created).toBeDefined();
		// Cleaned, and cut at 100 columns as a whole.
		expect(ctx.showWarning).toHaveBeenCalledWith(
			`Worktree created, but skill and command rescan failed: bad skill file ${"x".repeat(29)}…`,
		);
		expect(ctx.showWarning).toHaveBeenCalledWith(
			"Worktree created, but cleaning source checkout failed: index.lock exists",
		);
		expect(ctx.present).toHaveBeenCalled();
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

	it("lets Esc on the delayed hook loader abort only the hook's signal", async () => {
		await using temp = await TempDir.create("@omp-wt-hook-loader-");
		const { ctx, state } = createMoveContext(temp.path());
		const target = path.join(temp.path(), "checkout");
		const seen: {
			slotAtHookStart?: Component[];
			loader?: Component;
			abortedBeforeEsc?: boolean;
			abortedAfterEsc?: boolean;
		} = {};
		vi.useFakeTimers();
		stubCheckout(temp.path(), target);
		vi.spyOn(worktreeHook, "runPostCheckoutHook").mockImplementation(async (_root, _head, options) => {
			seen.slotAtHookStart = [...ctx.editorContainer.children];
			vi.advanceTimersByTime(1_000);
			seen.loader = ctx.editorContainer.children[0];
			seen.abortedBeforeEsc = options?.signal?.aborted;
			seen.loader?.handleInput?.("\x1b");
			seen.abortedAfterEsc = options?.signal?.aborted;
			return { status: "cancelled" };
		});
		await new CommandController(ctx).handleWorktreeCommand("feature");

		expect(seen.slotAtHookStart).toEqual([ctx.editor]);
		expect(seen.loader).toBeInstanceOf(BorderedLoader);
		expect(ctx.ui.setFocus).toHaveBeenCalledWith(seen.loader);
		expect(seen.abortedBeforeEsc).toBe(false);
		expect(seen.abortedAfterEsc).toBe(true);
		expect(ctx.showWarning).toHaveBeenCalledWith("Worktree created, but post-checkout hook cancelled");
		// The session moved, and a cancelled hook may already have added skills or commands.
		expect(ctx.session.refreshSkillsAndCommands).toHaveBeenCalled();
		expect(state.cwd).toBe(target);
		expect(ctx.editorContainer.children).toEqual([ctx.editor]);
		expect(ctx.ui.setFocus).toHaveBeenLastCalledWith(ctx.editor);
	});

	it("never shows the hook loader once the command has finished", async () => {
		await using temp = await TempDir.create("@omp-wt-fast-hook-");
		const { ctx } = createMoveContext(temp.path());
		vi.useFakeTimers();
		stubCheckout(temp.path(), path.join(temp.path(), "checkout"));
		vi.spyOn(worktreeHook, "runPostCheckoutHook").mockResolvedValue({ status: "ok" });
		await new CommandController(ctx).handleWorktreeCommand("feature");
		vi.advanceTimersByTime(1_000);

		expect(ctx.editorContainer.children).toEqual([ctx.editor]);
		expect(ctx.ui.setFocus).not.toHaveBeenCalledWith(expect.any(BorderedLoader));
	});

	it("leaves the keyboard with a selector opened while the checkout ran instead of showing the hook loader", async () => {
		await using temp = await TempDir.create("@omp-wt-loader-skipped-");
		const { ctx } = createMoveContext(temp.path());
		vi.spyOn(ctx.ui, "getFocused").mockReturnValue(new Text("selector", 0, 0));
		vi.useFakeTimers();
		stubCheckout(temp.path(), path.join(temp.path(), "checkout"));
		vi.spyOn(worktreeHook, "runPostCheckoutHook").mockImplementation(async () => {
			vi.advanceTimersByTime(1_000);
			return { status: "ok" };
		});
		await new CommandController(ctx).handleWorktreeCommand("feature");

		expect(ctx.ui.setFocus).not.toHaveBeenCalledWith(expect.any(BorderedLoader));
	});

	it("leaves a dialog that replaced the hook loader in place and focused, and stops the loader", async () => {
		await using temp = await TempDir.create("@omp-wt-dialog-");
		const { ctx } = createMoveContext(temp.path());
		// Not a Container: `toEqual` can't tell an empty one from the context's editor.
		const dialog = new Text("dialog", 0, 0);
		vi.useFakeTimers();
		stubCheckout(temp.path(), path.join(temp.path(), "checkout"));
		vi.spyOn(worktreeHook, "runPostCheckoutHook").mockImplementation(async () => {
			vi.advanceTimersByTime(1_000);
			ctx.editorContainer.clear();
			ctx.editorContainer.addChild(dialog);
			ctx.ui.setFocus(dialog);
			return { status: "ok" };
		});
		await new CommandController(ctx).handleWorktreeCommand("feature");

		expect(ctx.editorContainer.children).toEqual([dialog]);
		expect(ctx.ui.setFocus).toHaveBeenLastCalledWith(dialog);
		ctx.ui.requestComponentRender = vi.fn();
		vi.advanceTimersByTime(1_000);
		expect(ctx.ui.requestComponentRender).not.toHaveBeenCalled();
	});

	it("gives the editor back when a selector opened over the hook loader closes after the hook finished", async () => {
		await using temp = await TempDir.create("@omp-wt-covered-loader-");
		const { ctx } = createMoveContext(temp.path());
		const history = new Text("history", 0, 0);
		let closeHistory: (() => void) | undefined;
		vi.useFakeTimers();
		stubCheckout(temp.path(), path.join(temp.path(), "checkout"));
		vi.spyOn(worktreeHook, "runPostCheckoutHook").mockImplementation(async () => {
			vi.advanceTimersByTime(1_000);
			// Ctrl+R's history search opens over the loader the way every selector does.
			ctx.showSelector(done => {
				closeHistory = done;
				return { component: history, focus: history };
			});
			return { status: "ok" };
		});
		await new CommandController(ctx).handleWorktreeCommand("feature");
		expect(ctx.editorContainer.children).toEqual([history]);
		if (!closeHistory) throw new Error("history search never opened");
		closeHistory();

		expect(ctx.editorContainer.children).toEqual([ctx.editor]);
		expect(ctx.ui.setFocus).toHaveBeenLastCalledWith(ctx.editor);
	});

	it("still runs the hook, without cleaning the source, and repaints once its loader is gone when the session can't move", async () => {
		await using temp = await TempDir.create("@omp-wt-move-fails-");
		const { ctx, state } = createMoveContext(temp.path());
		const target = path.join(temp.path(), "checkout");
		vi.useFakeTimers();
		stubCheckout(temp.path(), target);
		ctx.session.moveSession = vi.fn(async () => {
			throw new Error("session move denied");
		});
		const slotAtRender: Component[][] = [];
		ctx.ui.requestRender = vi.fn(() => {
			slotAtRender.push([...ctx.editorContainer.children]);
		});
		// A hook that outlives the loader delay; nothing renders after it when the move failed.
		const hook = vi.spyOn(worktreeHook, "runPostCheckoutHook").mockImplementation(async () => {
			vi.advanceTimersByTime(1_000);
			return { status: "ok" };
		});
		const created = await new CommandController(ctx).handleWorktreeCommand("feature");

		expect(created).toBeUndefined();
		expect(state.cwd).toBe(temp.path());
		expect(ctx.showError).toHaveBeenCalledWith("Move failed: session move denied");
		expect(hook).toHaveBeenCalledWith(target, "0", expect.anything());
		expect(sessionWorktree.cleanSourceCheckoutIfConfigured).not.toHaveBeenCalled();
		expect(ctx.session.refreshSkillsAndCommands).not.toHaveBeenCalled();
		expect(slotAtRender.some(slot => slot[0] instanceof BorderedLoader)).toBe(true);
		expect(slotAtRender.at(-1)).toEqual([ctx.editor]);
	});

	it("rescans, without cleaning the source, when a failed rollback leaves the session in the worktree", async () => {
		await using temp = await TempDir.create("@omp-wt-rollback-fails-");
		const { ctx, state, rollbackMove } = createMoveContext(temp.path());
		const target = path.join(temp.path(), "checkout");
		stubCheckout(temp.path(), target);
		// The worktree can't become the process cwd (`applyCwdChange` returns false before touching the session's
		// cwd), the rollback fails, and the workspace re-aligns to where the session is.
		ctx.applyCwdChange = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
		rollbackMove.mockRejectedValueOnce(new Error("rollback denied"));
		vi.spyOn(worktreeHook, "runPostCheckoutHook").mockResolvedValue({ status: "ok" });
		const created = await new CommandController(ctx).handleWorktreeCommand("feature");

		expect(created).toBeUndefined();
		expect(state.cwd).toBe(target);
		expect(ctx.session.refreshSkillsAndCommands).toHaveBeenCalled();
		expect(sessionWorktree.cleanSourceCheckoutIfConfigured).not.toHaveBeenCalled();
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
