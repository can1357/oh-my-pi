import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { BashPtyOptions, BashResult } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { KeyEvent } from "@oh-my-pi/pi-tui";
import type { InputEvent } from "@oh-my-pi/pi-tui/driver/contract";
import { printRows } from "../../../src/ui/print-rows";
import "../../../src/ui/styles/transcript/exec-run";
import { ExecRun, ExecRunBlock } from "../../../src/ui/transcript/exec-run";

/** A key as the driver reports it. */
function key(id: string, raw: string, text?: string): KeyEvent {
	return { id, kind: "press", raw, ...(text ? { text } : {}) } as KeyEvent;
}

function createCwdContext(sourceDir: string, isStreaming = false, showImages = true) {
	const state = {
		cwd: sourceDir,
		workspaceCwd: sourceDir,
		artifactCwd: sourceDir,
		executedCwds: [] as string[],
		completedBtwVisible: true,
		gateHeld: false,
	};
	const executeBash = vi.fn(
		async (
			command: string,
			_onChunk?: (chunk: string) => void,
			_options?: { pty?: BashPtyOptions },
		): Promise<BashResult> => {
			state.executedCwds.push(state.cwd);
			return {
				output: command === "pwd" ? `${state.cwd}\n` : "ok",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: state.cwd.length,
				outputLines: 1,
				outputBytes: state.cwd.length,
				workingDir: state.cwd,
			};
		},
	);
	/** Status line refreshes (the context meter reads the session again). */
	const statusRefresh = vi.fn();
	/** Every `!` run shown, and whether it waited for the turn to end. */
	const runs: { run: ExecRun; deferred: boolean }[] = [];
	const presentExecRun = vi.fn((run: ExecRun, options?: { deferred?: boolean }) => {
		runs.push({ run, deferred: options?.deferred === true });
		return { record: vi.fn() };
	});
	const ctx = {
		session: {
			isStreaming,
			executeBash,
			moveSession: vi.fn(async (cwd: string) => {
				state.cwd = cwd;
				state.artifactCwd = cwd;
			}),
		},
		sessionManager: {
			getCwd: () => state.cwd,
			captureState: vi.fn(() => ({ cwd: state.cwd, sessionDir: "/tmp/bash-sessions" })),
			restoreState: vi.fn((snapshot: { cwd: string }) => {
				state.cwd = snapshot.cwd;
			}),
			rollbackMove: vi.fn(async (snapshot: { cwd: string }) => {
				state.cwd = snapshot.cwd;
				state.artifactCwd = snapshot.cwd;
			}),
		},
		settings: Settings.isolated({ "terminal.showImages": showImages }),
		shell: { size: () => ({ columns: 80, rows: 24 }) },
		toolOutputExpanded: false,
		presentExecRun,
		showError: vi.fn(),
		showWarning: vi.fn(),
		applyCwdChange: vi.fn(async (cwd: string) => {
			expect(state.cwd).toBe(cwd);
			state.workspaceCwd = cwd;
			return true;
		}),
		withBtwSessionMove: vi.fn(async (operation: () => Promise<boolean>) => {
			if (state.gateHeld) throw new Error("Nested session move gate");
			state.gateHeld = true;
			try {
				const moved = await operation();
				if (moved) state.completedBtwVisible = false;
				return moved;
			} finally {
				state.gateHeld = false;
			}
		}),
		shutdown: vi.fn(async () => {}),
		updateEditorBorderColor: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		statusLine: { refreshVcs: statusRefresh },
	} as unknown as InteractiveModeContext;
	return { ctx, executeBash, presentExecRun, runs, state, statusRefresh };
}

/** The output a finished run shows. */
function finalOutput(run: ExecRun | undefined): string {
	if (!run) throw new Error("Expected a shown shell run");
	return run.completion()?.output ?? "";
}

describe("bash shortcut command", () => {
	it("has the context meter count the run once it is recorded, not before", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-meter-"));
		try {
			const { ctx, executeBash, statusRefresh } = createCwdContext(sourceDir);
			const running = Promise.withResolvers<void>();
			const base = executeBash.getMockImplementation()!;
			executeBash.mockImplementationOnce(async (...args) => {
				await running.promise;
				return base(...args);
			});
			const done = new CommandController(ctx).handleBashCommand("echo hi");
			await Promise.resolve();
			expect(statusRefresh).not.toHaveBeenCalled();
			running.resolve();
			await done;
			expect(statusRefresh).toHaveBeenCalledTimes(1);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("persists standalone and bare cd before the next user-shell command", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-cd-source-"));
		const childDir = path.join(sourceDir, "child");
		await fs.mkdir(childDir);
		try {
			const { ctx, executeBash, state } = createCwdContext(sourceDir);
			executeBash.mockImplementationOnce(async () => {
				state.executedCwds.push(state.cwd);
				return {
					output: "",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					totalLines: 0,
					totalBytes: 0,
					outputLines: 0,
					outputBytes: 0,
					workingDir: childDir,
				};
			});
			executeBash.mockImplementationOnce(async () => {
				state.executedCwds.push(state.cwd);
				return {
					output: "",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					totalLines: 0,
					totalBytes: 0,
					outputLines: 0,
					outputBytes: 0,
					workingDir: sourceDir,
				};
			});
			const controller = new CommandController(ctx);

			await controller.handleBashCommand("cd child");
			await controller.handleBashCommand("cd");
			await controller.handleBashCommand("pwd");

			expect(state.cwd).toBe(sourceDir);
			expect(state.workspaceCwd).toBe(sourceDir);
			expect(state.artifactCwd).toBe(sourceDir);
			expect(state.completedBtwVisible).toBe(false);
			expect(ctx.session.moveSession).toHaveBeenNthCalledWith(1, childDir);
			expect(ctx.session.moveSession).toHaveBeenNthCalledWith(2, sourceDir);
			expect(state.executedCwds).toEqual([sourceDir, childDir, sourceDir]);
			expect(executeBash).toHaveBeenCalledTimes(3);
			expect(ctx.applyCwdChange).toHaveBeenNthCalledWith(1, childDir);
			expect(ctx.applyCwdChange).toHaveBeenNthCalledWith(2, sourceDir);
			expect(ctx.updateEditorBorderColor).toHaveBeenCalledTimes(2);
			expect(ctx.reloadTodos).toHaveBeenCalledTimes(2);
			expect(ctx.showError).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("does not adopt cwd from a non-cd bash command", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-cwd-sync-"));
		const childDir = path.join(sourceDir, "child");
		await fs.mkdir(childDir);
		try {
			const { ctx, executeBash, state } = createCwdContext(sourceDir);
			executeBash.mockImplementationOnce(async () => {
				state.executedCwds.push(state.cwd);
				return {
					output: "",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					totalLines: 0,
					totalBytes: 0,
					outputLines: 0,
					outputBytes: 0,
					workingDir: childDir,
				};
			});
			const controller = new CommandController(ctx);

			await controller.handleBashCommand("pushd child >/dev/null");

			expect(state.cwd).toBe(sourceDir);
			expect(state.executedCwds).toEqual([sourceDir]);
			expect(executeBash).toHaveBeenCalledTimes(1);
			expect(ctx.withBtwSessionMove).not.toHaveBeenCalled();
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(ctx.updateEditorBorderColor).not.toHaveBeenCalled();
			expect(ctx.reloadTodos).not.toHaveBeenCalled();
			expect(ctx.showWarning).not.toHaveBeenCalled();
			expect(ctx.showError).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("rejects simple cd while streaming before queuing a bash block", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-cd-streaming-"));
		try {
			const { ctx, executeBash, presentExecRun, state } = createCwdContext(sourceDir, true);
			const controller = new CommandController(ctx);

			await controller.handleBashCommand("cd child");

			expect(state.cwd).toBe(sourceDir);
			expect(executeBash).not.toHaveBeenCalled();
			expect(presentExecRun).not.toHaveBeenCalled();
			expect(ctx.showWarning).toHaveBeenCalledWith(expect.stringContaining("response"));
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("does not adopt cwd or warn for a non-cd command while streaming", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-cwd-deferred-"));
		const childDir = path.join(sourceDir, "child");
		await fs.mkdir(childDir);
		try {
			const { ctx, executeBash, runs, state } = createCwdContext(sourceDir, true);
			executeBash.mockImplementationOnce(async () => ({
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 0,
				totalBytes: 0,
				outputLines: 0,
				outputBytes: 0,
				workingDir: childDir,
			}));
			const controller = new CommandController(ctx);

			await controller.handleBashCommand("pushd child >/dev/null");

			expect(state.cwd).toBe(sourceDir);
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(runs.map(entry => entry.deferred)).toEqual([true]);
			expect(ctx.showWarning).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("renders images extracted from a completed manual Bash command", async () => {
		const { ctx, executeBash, runs } = createCwdContext("/tmp", false, false);
		executeBash.mockResolvedValueOnce({
			output: "generated",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 9,
			outputLines: 1,
			outputBytes: 9,
			workingDir: "/tmp",
			images: [
				{
					type: "image",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
					mimeType: "image/png",
				},
			],
		});
		const controller = new CommandController(ctx);

		await controller.handleBashCommand("emit-image");

		const run = runs[0]?.run;
		if (!run) throw new Error("Expected a shown shell run");
		const rows = () => Bun.stripANSI(printRows(() => ExecRunBlock({ run }), 80).join("\n"));
		expect(rows()).toContain("[Image: [image/png] 1x1]");
		run.setExpanded(true);
		expect(rows()).toContain("[Image: [image/png] 1x1]");
	});

	it("forwards composer keystrokes to a running PTY command until it exits (#17210)", async () => {
		const { ctx, executeBash } = createCwdContext("/tmp");
		let interceptors: ((event: InputEvent) => boolean)[] = [];
		let globalExpansions = 0;
		const ctrlO = key("ctrl+o", "\x0f");
		// Keys no interceptor takes reach the app-wide shortcuts (Ctrl+O expands tool output).
		const press = (event: InputEvent): boolean => {
			if (interceptors.some(handler => handler(event))) return true;
			if (event.type === "key" && event.key.id === "ctrl+o") globalExpansions++;
			return false;
		};
		const field = {};
		let passthrough = false;
		let focused: unknown = field;
		Object.assign(ctx, {
			composer: { field, setKeyPassthrough: (on: boolean) => (passthrough = on) },
			keybindings: { matches: (event: KeyEvent, id: string) => id === "app.interrupt" && event.id === "escape" },
			shell: { size: () => ({ columns: 80, rows: 24 }), focused: () => focused },
			interceptInput: (handler: (event: InputEvent) => boolean) => {
				interceptors = [handler, ...interceptors];
				return () => {
					interceptors = interceptors.filter(entry => entry !== handler);
				};
			},
		});
		const written: string[] = [];
		const pressed: Record<string, boolean> = {};
		let onStdin: BashPtyOptions["onStdin"];
		executeBash.mockImplementationOnce(async (_command, _onChunk, options) => {
			onStdin = options?.pty?.onStdin;
			onStdin?.(data => written.push(data));
			expect(passthrough).toBe(true);
			// The command is blocked on `read` while the user types in the composer.
			pressed.answer = press({ type: "key", key: key("y", "y", "y") });
			pressed.nanoWrite = press({ type: "key", key: ctrlO });
			pressed.paste = press({ type: "paste", paste: { text: "a\nβ\tc" } });
			pressed.enter = press({ type: "key", key: key("enter", "\r") });
			pressed.escape = press({ type: "key", key: key("escape", "\x1b") });
			pressed.mouse = press({
				type: "mouse",
				mouse: { kind: "press", button: "left", x: 9, y: 4, mods: [] },
			} as unknown as InputEvent);
			focused = {}; // a dialog took focus
			pressed.dialog = press({ type: "key", key: key("n", "n", "n") });
			pressed.dialogPaste = press({ type: "paste", paste: { text: "dialog only" } });
			focused = field;
			return {
				output: "ANSWER=y",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 8,
				outputLines: 1,
				outputBytes: 8,
			};
		});
		const controller = new CommandController(ctx);

		await controller.handleBashCommand("read -k 1 answer");
		expect(passthrough).toBe(false);

		expect(written).toEqual(["y", "\x0f", "\x1b[200~a\nβ\tc\x1b[201~", "\r"]);
		expect(globalExpansions).toBe(0);
		// Esc stays the cancel key; mouse reports and focused dialogs keep their input.
		expect(pressed).toEqual({
			answer: true,
			nanoWrite: true,
			paste: true,
			enter: true,
			escape: false,
			mouse: false,
			dialog: false,
			dialogPaste: false,
		});
		// After exit the global Ctrl+O shortcut works again.
		expect(press({ type: "key", key: ctrlO })).toBe(false);
		expect(globalExpansions).toBe(1);
		expect(interceptors).toHaveLength(0);
		// A native start notification queued behind command completion must not
		// reclaim the composer after the PTY has exited.
		onStdin?.(data => written.push(data));
		expect(passthrough).toBe(false);
		expect(interceptors).toHaveLength(0);
	});

	it("finalizes successful output before reporting a standalone cd refresh failure", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-cwd-refresh-error-"));
		const childDir = path.join(sourceDir, "child");
		await fs.mkdir(childDir);
		try {
			const { ctx, executeBash, runs, state } = createCwdContext(sourceDir);
			executeBash.mockImplementationOnce(async () => ({
				output: "final output",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 12,
				outputLines: 1,
				outputBytes: 12,
				workingDir: childDir,
			}));
			ctx.applyCwdChange = vi.fn(async (cwd: string) => {
				expect(state.gateHeld).toBe(true);
				if (cwd === childDir) throw new Error("refresh failed");
				state.workspaceCwd = cwd;
				return true;
			});
			const controller = new CommandController(ctx);

			await controller.handleBashCommand("cd child");

			expect(finalOutput(runs[0]?.run)).toContain("final output");
			expect(state.cwd).toBe(sourceDir);
			expect(state.workspaceCwd).toBe(sourceDir);
			expect(state.artifactCwd).toBe(sourceDir);
			expect(state.completedBtwVisible).toBe(true);
			expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("refresh failed"));
			expect(ctx.shutdown).not.toHaveBeenCalled();
			await controller.handleBashCommand("pwd");
			expect(state.executedCwds).toEqual([sourceDir]);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("does not execute or render a persistent cd when the BTW migration gate refuses", async () => {
		const { ctx, executeBash, presentExecRun, state } = createCwdContext("/tmp");
		ctx.withBtwSessionMove = vi.fn(async () => false);

		await new CommandController(ctx).handleBashCommand("cd /");

		expect(executeBash).not.toHaveBeenCalled();
		expect(presentExecRun).not.toHaveBeenCalled();
		expect(ctx.session.moveSession).not.toHaveBeenCalled();
		expect(ctx.applyCwdChange).not.toHaveBeenCalled();
		expect(state.cwd).toBe("/tmp");
		expect(state.artifactCwd).toBe("/tmp");
		expect(state.workspaceCwd).toBe("/tmp");
		expect(state.completedBtwVisible).toBe(true);
	});

	it("does not execute cd when saving source settings fails", async () => {
		const { ctx, executeBash, presentExecRun, state } = createCwdContext("/tmp");
		vi.spyOn(ctx.settings, "flush").mockRejectedValue(new Error("settings write denied"));

		await new CommandController(ctx).handleBashCommand("cd /");

		expect(executeBash).not.toHaveBeenCalled();
		expect(presentExecRun).not.toHaveBeenCalled();
		expect(ctx.withBtwSessionMove).not.toHaveBeenCalled();
		expect(state.cwd).toBe("/tmp");
		expect(state.completedBtwVisible).toBe(true);
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("settings write denied"));
	});

	it("leaves compound cd commands outside persistent cwd migration", async () => {
		const { ctx, executeBash, state } = createCwdContext("/tmp");
		executeBash.mockResolvedValueOnce({
			output: "/",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 1,
			outputLines: 1,
			outputBytes: 1,
			workingDir: "/",
		});

		await new CommandController(ctx).handleBashCommand("cd / && pwd");

		expect(executeBash).toHaveBeenCalledTimes(1);
		expect(ctx.withBtwSessionMove).not.toHaveBeenCalled();
		expect(ctx.session.moveSession).not.toHaveBeenCalled();
		expect(state.cwd).toBe("/tmp");
		expect(state.completedBtwVisible).toBe(true);
	});

	it("holds the same migration gate through shell execution and cwd adoption", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-cd-gate-"));
		const childDir = path.join(sourceDir, "child");
		await fs.mkdir(childDir);
		const executionStarted = Promise.withResolvers<void>();
		const executionResult = Promise.withResolvers<BashResult>();
		const adoptionStarted = Promise.withResolvers<void>();
		const adoptionResult = Promise.withResolvers<void>();
		const result: BashResult = {
			output: "changed directory",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 17,
			outputLines: 1,
			outputBytes: 17,
			workingDir: childDir,
		};
		let pending: Promise<void> | undefined;
		try {
			const { ctx, executeBash, state } = createCwdContext(sourceDir);
			executeBash.mockImplementationOnce(async () => {
				executionStarted.resolve();
				return executionResult.promise;
			});
			ctx.applyCwdChange = vi.fn(async (cwd: string) => {
				adoptionStarted.resolve();
				await adoptionResult.promise;
				state.workspaceCwd = cwd;
				return true;
			});
			pending = new CommandController(ctx).handleBashCommand("cd child");
			await executionStarted.promise;
			expect(state.gateHeld).toBe(true);
			expect(state.cwd).toBe(sourceDir);
			expect(state.completedBtwVisible).toBe(true);
			executionResult.resolve(result);
			await adoptionStarted.promise;
			expect(state.gateHeld).toBe(true);
			expect(state.cwd).toBe(childDir);
			expect(state.artifactCwd).toBe(childDir);
			expect(state.workspaceCwd).toBe(sourceDir);
			expect(state.completedBtwVisible).toBe(true);
			adoptionResult.resolve();
			await pending;
			expect(state.gateHeld).toBe(false);
			expect(state.workspaceCwd).toBe(childDir);
			expect(state.completedBtwVisible).toBe(false);
			expect(ctx.withBtwSessionMove).toHaveBeenCalledTimes(1);
		} finally {
			executionResult.resolve(result);
			adoptionResult.resolve();
			await pending;
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it.each(["failed", "cancelled", "unchanged"] as const)(
		"retains completed BTW and session cwd after a %s standalone cd",
		async outcome => {
			const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-cd-not-moved-"));
			const childDir = path.join(sourceDir, "child");
			await fs.mkdir(childDir);
			try {
				const { ctx, executeBash, state } = createCwdContext(sourceDir);
				executeBash.mockResolvedValueOnce({
					output: outcome === "failed" ? "permission denied" : "",
					exitCode: outcome === "failed" ? 1 : 0,
					cancelled: outcome === "cancelled",
					truncated: false,
					totalLines: 0,
					totalBytes: 0,
					outputLines: 0,
					outputBytes: 0,
					workingDir: outcome === "unchanged" ? sourceDir : childDir,
				});

				await new CommandController(ctx).handleBashCommand(outcome === "unchanged" ? "cd ." : "cd child");

				expect(executeBash).toHaveBeenCalledTimes(1);
				expect(state.cwd).toBe(sourceDir);
				expect(state.workspaceCwd).toBe(sourceDir);
				expect(state.artifactCwd).toBe(sourceDir);
				expect(state.completedBtwVisible).toBe(true);
				expect(state.gateHeld).toBe(false);
				expect(ctx.session.moveSession).not.toHaveBeenCalled();
				expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			} finally {
				await fs.rm(sourceDir, { recursive: true, force: true });
			}
		},
	);

	it("keeps the source session and shell output when session move invariants reject cd adoption", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-cd-move-rejected-"));
		const childDir = path.join(sourceDir, "child");
		await fs.mkdir(childDir);
		try {
			const { ctx, executeBash, runs, state } = createCwdContext(sourceDir);
			executeBash.mockResolvedValueOnce({
				output: "cd output",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 9,
				outputLines: 1,
				outputBytes: 9,
				workingDir: childDir,
			});
			ctx.session.moveSession = vi.fn(async () => {
				throw new Error("session transition rejected");
			});
			const controller = new CommandController(ctx);

			await controller.handleBashCommand("cd child");
			await controller.handleBashCommand("pwd");

			expect(state.executedCwds).toEqual([sourceDir]);
			expect(state.cwd).toBe(sourceDir);
			expect(state.artifactCwd).toBe(sourceDir);
			expect(state.workspaceCwd).toBe(sourceDir);
			expect(state.completedBtwVisible).toBe(true);
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("session transition rejected"));
			expect(finalOutput(runs[0]?.run)).toContain("cd output");
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});
});
