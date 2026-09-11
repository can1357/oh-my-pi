import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import {
	getMarkdownTheme,
	getThemeByName,
	setMarkdownMermaidRendering,
	setMarkdownMermaidSpacing,
	setThemeInstance,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { beginSettingsTest, restoreSettingsTestState } from "../../helpers/settings-test-state";

function createMoveContext(sourceDir: string, settingsFlush?: () => Promise<void>) {
	const state = { cwd: sourceDir, movedTo: undefined as string | undefined };
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
	const refreshBaseSystemPrompt = vi.fn(async () => {});
	const rebuildChatFromMessages = vi.fn();
	const ctx = {
		session: { isStreaming: false, moveSession, refreshBaseSystemPrompt },
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
		updateEditorBorderColor: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		rebuildChatFromMessages: vi.fn(),
		ui: { requestRender: vi.fn() },
		present,
		shutdown,
	} as unknown as InteractiveModeContext;
	return { ctx, state, present, captureState, restoreState, rollbackMove, shutdown, sessionDir };
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}
function renderMermaidAscii(source: string, maxWidth = 120): string {
	const resolve = getMarkdownTheme().resolveMermaidAscii;
	if (!resolve) throw new Error("Mermaid renderer unavailable");
	const rendered = resolve(source, maxWidth);
	if (rendered === null) throw new Error("Mermaid renderer returned null");
	return stripAnsi(rendered);
}

describe("CommandController /move", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("relocates the active session before re-scoping cwd-derived state", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, state, present } = createMoveContext(sourceDir);
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(state.movedTo).toBe(targetDir);
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
			const { ctx, state, captureState, restoreState, rollbackMove, shutdown } = createMoveContext(sourceDir);
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

	it("aborts /move when pending settings flush fails, leaving cwd untouched", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, state } = createMoveContext(sourceDir, async () => {
				throw new Error("disk full");
			});
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
			expect(ctx.session.moveSession).not.toHaveBeenCalled();
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(state.movedTo).toBeUndefined();
			expect(state.cwd).toBe(sourceDir);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("refreshes the base system prompt after relocating (renderMermaid can differ per project)", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx } = createMoveContext(sourceDir);
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(ctx.session.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
			expect(ctx.rebuildChatFromMessages).toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("applies the destination project's Mermaid spacing to rendered diagrams after /move", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-spacing-global-"));
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-spacing-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-spacing-target-"));
		const plainDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-spacing-plain-"));
		const settingsState = beginSettingsTest();
		try {
			await Settings.init({ cwd: sourceDir, agentDir });
			await settings.reloadForCwd(sourceDir);
			await fs.mkdir(path.join(targetDir, ".claude"), { recursive: true });
			await fs.writeFile(
				path.join(targetDir, ".claude", "settings.json"),
				JSON.stringify({ tui: { mermaidPaddingX: 0, mermaidPaddingY: 0, mermaidBoxBorderPadding: 0 } }),
			);
			await fs.mkdir(path.join(plainDir, ".claude"), { recursive: true });
			await fs.writeFile(
				path.join(plainDir, ".claude", "settings.json"),
				JSON.stringify({ tui: { renderMermaid: false } }),
			);
			const source = "flowchart TD\n  A[alpha] --> B[beta]";
			const baseline = renderMermaidAscii(source);
			const { ctx, state } = createMoveContext(sourceDir);
			const controller = new CommandController(ctx);
			ctx.applyCwdChange = async (cwd: string) => {
				expect(state.cwd).toBe(cwd);
				await settings.reloadForCwd(cwd);
				return true;
			};

			await controller.handleMoveCommand(targetDir);

			expect(settings.get("tui.mermaidPaddingX")).toBe(0);
			expect(settings.get("tui.mermaidPaddingY")).toBe(0);
			expect(settings.get("tui.mermaidBoxBorderPadding")).toBe(0);
			const tight = renderMermaidAscii(source);
			expect(tight).not.toBe(baseline);
			expect(tight.length).toBeLessThan(baseline.length);

			await controller.handleMoveCommand(plainDir);

			expect(settings.get("tui.renderMermaid")).toBe(false);
			expect(getMarkdownTheme().resolveMermaidAscii).toBeUndefined();
		} finally {
			setMarkdownMermaidSpacing({ paddingX: 5, paddingY: 5, boxBorderPadding: 1 });
			setMarkdownMermaidRendering(true);
			restoreSettingsTestState(settingsState);
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
			await fs.rm(plainDir, { recursive: true, force: true });
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	it("presents a prompt-refresh failure after rebuilding the transcript", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-refresh-error-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-refresh-target-"));
		try {
			const { ctx } = createMoveContext(sourceDir);
			const rebuildChatFromMessages = vi.fn();
			const showError = vi.fn();
			ctx.rebuildChatFromMessages = rebuildChatFromMessages;
			ctx.showError = showError;
			ctx.session.refreshBaseSystemPrompt = vi.fn(async () => {
				throw new Error("prompt boom");
			});
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(showError).toHaveBeenCalledWith(expect.stringContaining("prompt boom"));
			expect(rebuildChatFromMessages).toHaveBeenCalledTimes(1);
			expect(rebuildChatFromMessages.mock.invocationCallOrder[0]).toBeLessThan(
				showError.mock.invocationCallOrder[0],
			);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});
});
