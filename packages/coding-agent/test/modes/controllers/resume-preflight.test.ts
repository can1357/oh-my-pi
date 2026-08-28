import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as SessionSelector from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

type ResumeSwitchOptions = {
	onCwdChange?: (newCwd: string, previousCwd: string) => Promise<boolean>;
};

function createResumeContext(opts: { flushFails?: boolean; sourceCwd?: string; previousSessionFile?: string } = {}) {
	const sourceCwd = opts.sourceCwd ?? "/tmp/source-project";
	const state = { cwd: sourceCwd };
	const switchSession = vi.fn(async (_sessionPath: string, _options?: ResumeSwitchOptions) => true);
	const applyCwdChange = vi.fn(async () => true);
	const moveTo = vi.fn(async (cwd: string) => {
		state.cwd = cwd;
	});
	const editor = {};
	let selector: SessionSelector.SessionSelectorComponent | undefined;
	const hide = vi.fn();
	const setFocus = vi.fn();
	const flush = vi.fn(async () => {
		if (opts.flushFails) throw new Error("disk full");
	});
	const ctx = {
		session: { switchSession },
		sessionManager: {
			getCwd: () => state.cwd,
			getSessionDir: () => "/tmp",
			getSessionFile: () => opts.previousSessionFile,
			moveTo,
		},
		settings: { flush },
		clearTransientSessionUi: vi.fn(),
		applyCwdChange,
		updateEditorBorderColor: vi.fn(),
		renderInitialMessages: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		showStatus: vi.fn(),
		showError: vi.fn(),
		statusLine: { invalidate: vi.fn(), resetActiveTime: vi.fn() },
		ui: {
			requestRender: vi.fn(),
			setFocus,
			terminal: { rows: 24 },
			showOverlay: vi.fn((component: unknown) => {
				selector = component as SessionSelector.SessionSelectorComponent;
				return { hide, setHidden: vi.fn(), isHidden: () => false };
			}),
		},
		editor,
		editorContainer: { children: [editor], clear: vi.fn(), addChild: vi.fn() },
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		switchSession,
		applyCwdChange,
		moveTo,
		state,
		editor,
		hide,
		setFocus,
		flush,
		getSelector: () => selector,
	};
}

describe("SelectorController.handleResumeSession preflight flush", () => {
	it("aborts resume and returns false when flush fails, leaving session untouched", async () => {
		const { ctx, switchSession, applyCwdChange } = createResumeContext({ flushFails: true });
		const controller = new SelectorController(ctx);

		const result = await controller.handleResumeSession("/tmp/some-session.jsonl");

		expect(result).toBe(false);
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
		expect(ctx.clearTransientSessionUi).not.toHaveBeenCalled();
		expect(switchSession).not.toHaveBeenCalled();
		expect(applyCwdChange).not.toHaveBeenCalled();
		expect(ctx.showStatus).not.toHaveBeenCalled();
	});

	it("proceeds and returns true when flush succeeds", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-preflight-"));
		try {
			const { ctx, switchSession, applyCwdChange, state } = createResumeContext({ sourceCwd: tmpDir });
			const targetCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-target-"));
			switchSession.mockImplementation(async (_sessionPath, options) => {
				state.cwd = targetCwd;
				return options?.onCwdChange ? options.onCwdChange(targetCwd, tmpDir) : true;
			});
			const controller = new SelectorController(ctx);

			const result = await controller.handleResumeSession("/tmp/some-session.jsonl");

			expect(result).toBe(true);
			expect(ctx.settings.flush).toHaveBeenCalled();
			expect(ctx.clearTransientSessionUi).toHaveBeenCalled();
			expect(switchSession).toHaveBeenCalledWith(
				"/tmp/some-session.jsonl",
				expect.objectContaining({ onCwdChange: expect.any(Function) }),
			);
			expect(applyCwdChange).toHaveBeenCalledWith(targetCwd);
			expect(ctx.showError).not.toHaveBeenCalled();
			expect(ctx.showStatus).toHaveBeenCalled();

			await fs.rm(targetCwd, { recursive: true, force: true });
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("restores an in-memory source when cwd application fails", async () => {
		const sourceCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-memory-source-"));
		const targetCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-memory-target-"));
		try {
			const { ctx, switchSession, applyCwdChange, moveTo, state } = createResumeContext({ sourceCwd });
			applyCwdChange.mockResolvedValue(false);
			switchSession.mockImplementation(async (_sessionPath, options) => {
				state.cwd = targetCwd;
				const applied = options?.onCwdChange ? await options.onCwdChange(targetCwd, sourceCwd) : true;
				if (!applied) state.cwd = sourceCwd;
				return applied;
			});
			const controller = new SelectorController(ctx);

			const result = await controller.handleResumeSession("/tmp/memory-session.jsonl");

			expect(result).toBe(false);
			expect(state.cwd).toBe(sourceCwd);
			expect(moveTo).not.toHaveBeenCalled();
			expect(ctx.clearTransientSessionUi).not.toHaveBeenCalled();
			expect(ctx.showStatus).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceCwd, { recursive: true, force: true });
			await fs.rm(targetCwd, { recursive: true, force: true });
		}
	});

	it("does not retry a cancelled rollback switch", async () => {
		const sourceCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-cancel-source-"));
		const targetCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-cancel-target-"));
		try {
			const { ctx, switchSession, applyCwdChange, moveTo, state } = createResumeContext({
				sourceCwd,
				previousSessionFile: "/tmp/source-session.jsonl",
			});
			applyCwdChange.mockResolvedValue(false);
			switchSession.mockImplementation(async (sessionPath, options) => {
				if (sessionPath === "/tmp/source-session.jsonl") return false;
				state.cwd = targetCwd;
				const applied = options?.onCwdChange ? await options.onCwdChange(targetCwd, sourceCwd) : true;
				if (!applied) state.cwd = sourceCwd;
				return applied;
			});
			const controller = new SelectorController(ctx);

			const result = await controller.handleResumeSession("/tmp/target-session.jsonl");

			expect(result).toBe(false);
			expect(switchSession).toHaveBeenCalledTimes(1);
			expect(moveTo).not.toHaveBeenCalled();
			expect(state.cwd).toBe(sourceCwd);
		} finally {
			await fs.rm(sourceCwd, { recursive: true, force: true });
			await fs.rm(targetCwd, { recursive: true, force: true });
		}
	});

	it("skips flush when settingsFlushed option is true", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-preflight-skip-"));
		try {
			const { ctx, switchSession, state } = createResumeContext({ sourceCwd: tmpDir });
			const targetCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-target-skip-"));
			switchSession.mockImplementation(async (_sessionPath, options) => {
				state.cwd = targetCwd;
				return options?.onCwdChange ? options.onCwdChange(targetCwd, tmpDir) : true;
			});
			const controller = new SelectorController(ctx);

			const result = await controller.handleResumeSession("/tmp/some-session.jsonl", { settingsFlushed: true });

			expect(result).toBe(true);
			expect(ctx.settings.flush).not.toHaveBeenCalled();
			expect(switchSession).toHaveBeenCalled();
			await fs.rm(targetCwd, { recursive: true, force: true });
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("keeps the selector open and unlocked for retry when the settings flush fails", async () => {
		const session: SessionInfo = {
			path: "/tmp/canceled-picker-resume.jsonl",
			id: "canceled-picker-resume",
			cwd: "/tmp",
			title: "Canceled picker resume",
			created: new Date("2026-01-01T00:00:00Z"),
			modified: new Date("2026-01-02T00:00:00Z"),
			messageCount: 1,
			size: 1,
			firstMessage: "first",
			allMessagesText: "first",
		};
		vi.spyOn(SessionManager, "list").mockResolvedValue([session]);
		const OriginalSelector = SessionSelector.SessionSelectorComponent;
		const selectionPromises: Promise<void>[] = [];
		vi.spyOn(SessionSelector, "SessionSelectorComponent").mockImplementation(
			((
				sessions: SessionInfo[],
				onSelect: (session: SessionInfo) => void,
				onCancel: () => void,
				onExit: () => void,
				options: SessionSelector.SessionSelectorOptions,
			) =>
				new OriginalSelector(
					sessions,
					selected => {
						selectionPromises.push(onSelect(selected) as unknown as Promise<void>);
					},
					onCancel,
					onExit,
					options,
				)) as never,
		);
		const { ctx, switchSession, editor, hide, setFocus, flush, getSelector } = createResumeContext();
		flush.mockRejectedValueOnce(new Error("disk full"));
		const controller = new SelectorController(ctx);
		await controller.showSessionSelector();
		const selector = getSelector();
		expect(selector).toBeDefined();

		selector!.handleInput("\n");
		expect(selectionPromises).toHaveLength(1);
		await selectionPromises[0];

		expect(hide).not.toHaveBeenCalled();
		expect(setFocus).not.toHaveBeenCalledWith(editor);
		expect(switchSession).not.toHaveBeenCalled();

		selector!.handleInput("\n");
		expect(selectionPromises).toHaveLength(2);
		await selectionPromises[1];
		expect(switchSession).toHaveBeenCalledTimes(1);
		expect(hide).toHaveBeenCalledTimes(1);
	});

	it("closes the selector and restores editor focus when switching rejects after preflight", async () => {
		const session: SessionInfo = {
			path: "/tmp/rejected-resume.jsonl",
			id: "rejected-resume",
			cwd: "/tmp",
			title: "Rejected resume",
			created: new Date("2026-01-01T00:00:00Z"),
			modified: new Date("2026-01-02T00:00:00Z"),
			messageCount: 1,
			size: 1,
			firstMessage: "first",
			allMessagesText: "first",
		};
		vi.spyOn(SessionManager, "list").mockResolvedValue([session]);
		const OriginalSelector = SessionSelector.SessionSelectorComponent;
		let selectionPromise: Promise<void> | undefined;
		vi.spyOn(SessionSelector, "SessionSelectorComponent").mockImplementation(
			((
				sessions: SessionInfo[],
				onSelect: (session: SessionInfo) => void,
				onCancel: () => void,
				onExit: () => void,
				options: SessionSelector.SessionSelectorOptions,
			) =>
				new OriginalSelector(
					sessions,
					selected => {
						selectionPromise = onSelect(selected) as unknown as Promise<void>;
					},
					onCancel,
					onExit,
					options,
				)) as never,
		);
		const { ctx, switchSession, editor, hide, setFocus, getSelector } = createResumeContext();
		const switchError = new Error("switch failed");
		switchSession.mockRejectedValue(switchError);
		const controller = new SelectorController(ctx);
		await controller.showSessionSelector();
		const selector = getSelector();
		expect(selector).toBeDefined();

		selector!.handleInput("\n");
		expect(selectionPromise).toBeDefined();
		await selectionPromise;

		expect(ctx.showError).toHaveBeenCalledWith("switch failed");
		expect(ctx.settings.flush).toHaveBeenCalledTimes(1);
		expect(switchSession).toHaveBeenCalledWith(
			session.path,
			expect.objectContaining({ onCwdChange: expect.any(Function) }),
		);
		expect(hide).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenLastCalledWith(editor);
	});
});
