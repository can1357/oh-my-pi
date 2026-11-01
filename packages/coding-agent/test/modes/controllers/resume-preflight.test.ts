import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as SessionSelector from "@oh-my-pi/pi-tui/overlays/session-selector";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { makeAssistantMessage } from "../../session-manager/helpers";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

type ResumeSwitchOptions = {
	onCwdChange?: (newCwd: string, previousCwd: string) => Promise<boolean>;
};

type ResumeDirectoryResult = { directory: string } | undefined;

type ResumeRepository = {
	sessionWorktreeRoot: string;
	primaryWorktreeRoot: string;
};
async function writeRecoverySession(sessionPath: string, cwd: string, repository?: ResumeRepository): Promise<void> {
	await fs.mkdir(path.dirname(sessionPath), { recursive: true });
	await fs.writeFile(
		sessionPath,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "resume-preflight-recovery",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
			repository,
		})}\n`,
	);
}

function createResumeContext(
	opts: {
		flushFails?: boolean;
		sourceCwd?: string;
		previousSessionFile?: string;
		directoryResults?: ResumeDirectoryResult[];
		managerSessionDir?: string;
		sessionDirOverride?: string;
	} = {},
) {
	const sourceCwd = opts.sourceCwd ?? "/tmp/source-project";
	const state = { cwd: sourceCwd, settingsScope: sourceCwd };
	const switchSession = vi.fn(async (_sessionPath: string, _options?: ResumeSwitchOptions) => true);
	const moveTo = vi.fn(async (cwd: string) => {
		state.cwd = cwd;
	});
	const showHookCustom = vi.fn(async () => opts.directoryResults?.shift());
	const editor = {};
	let selector: SessionSelector.SessionSelectorComponent | undefined;
	const hide = vi.fn();
	const setFocus = vi.fn();
	// Real settings: the picker reads its worktree scope before resuming; `scope` mirrors the active project dir.
	const settings = Object.assign(Settings.isolated(), { scope: sourceCwd });
	const flush = vi.spyOn(settings, "flush").mockImplementation(async () => {
		if (opts.flushFails) throw new Error("disk full");
	});
	const applyCwdChange = vi.fn(async (newCwd: string) => {
		state.settingsScope = newCwd;
		settings.scope = newCwd;
		return true;
	});
	const ctx = {
		session: { switchSession },
		sessionManager: {
			getCwd: () => state.cwd,
			getSessionDir: () => opts.managerSessionDir ?? "/tmp",
			getSessionFile: () => opts.previousSessionFile,
			moveTo,
		},
		sessionDirOverride: opts.sessionDirOverride,
		settings,
		prepareSessionSwitch: vi.fn(async () => {}),
		resetObserverRegistry: vi.fn(),
		clearTransientSessionUi: vi.fn(),
		applyCwdChange,
		updateEditorBorderColor: vi.fn(),
		renderInitialMessages: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		showStatus: vi.fn(),
		showError: vi.fn(),
		showHookCustom,
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
		showHookCustom,
		settings,
		getSelector: () => selector,
	};
}

async function createPersistedRecoverySession(
	root: string,
	recordedCwd: string,
): Promise<{
	sessionPath: string;
	sessionId: string;
	artifactId: string;
}> {
	const manager = SessionManager.create(recordedCwd, path.join(root, "original-sessions"));
	manager.appendMessage({ role: "user", content: "saved conversation", timestamp: Date.now() });
	manager.appendMessage(makeAssistantMessage());
	await manager.ensureOnDisk();
	const artifactId = await manager.saveArtifact("saved artifact", "resume-test");
	if (!artifactId) throw new Error("Expected a saved recovery artifact");
	const sessionPath = manager.getSessionFile();
	if (!sessionPath) throw new Error("Expected a persisted recovery session");
	const sessionId = manager.getSessionId();
	await manager.flush();
	await manager.close();
	return { sessionPath, sessionId, artifactId };
}

async function expectPersistedRecovery(
	sessionPath: string,
	recordedCwd: string,
	sessionId: string,
	artifactId: string,
): Promise<void> {
	const manager = await SessionManager.open(sessionPath, undefined, undefined, { suppressBreadcrumb: true });
	try {
		expect(manager.getSessionId()).toBe(sessionId);
		expect(manager.getRecordedCwd()).toBe(recordedCwd);
		expect(
			manager
				.getBranch()
				.some(
					entry =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						entry.message.content === "saved conversation",
				),
		).toBe(true);
		const artifactPath = await manager.getArtifactPath(artifactId);
		expect(artifactPath).not.toBeNull();
		expect(await fs.readFile(artifactPath!, "utf8")).toBe("saved artifact");
	} finally {
		await manager.close();
	}
}

describe("SelectorController.handleResumeSession preflight flush", () => {
	it("aborts resume and returns false when flush fails, leaving session untouched", async () => {
		const { ctx, switchSession, applyCwdChange } = createResumeContext({ flushFails: true });
		const controller = new SelectorController(ctx);

		const result = await controller.handleResumeSession("/tmp/some-session.jsonl");

		expect(result).toBe(false);
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
		expect(ctx.prepareSessionSwitch).not.toHaveBeenCalled();
		expect(ctx.resetObserverRegistry).not.toHaveBeenCalled();
		expect(ctx.clearTransientSessionUi).not.toHaveBeenCalled();
		expect(switchSession).not.toHaveBeenCalled();
		expect(applyCwdChange).not.toHaveBeenCalled();
		expect(ctx.showStatus).not.toHaveBeenCalled();
	});

	it("fails closed when the selected transcript is missing", async () => {
		const { ctx, switchSession } = createResumeContext({ previousSessionFile: "/tmp/active-session.jsonl" });
		const result = await new SelectorController(ctx).handleResumeSession("/tmp/missing-session.jsonl");

		expect(result).toBe(false);
		expect(switchSession).not.toHaveBeenCalled();
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("refusing to create a replacement"));
	});

	it("proceeds and returns true when flush succeeds", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-preflight-"));
		try {
			const { ctx, switchSession, applyCwdChange, state } = createResumeContext({
				sourceCwd: tmpDir,
				previousSessionFile: "/tmp/some-session.jsonl",
			});
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
			const { ctx, switchSession, applyCwdChange, moveTo, state } = createResumeContext({
				sourceCwd,
				previousSessionFile: "/tmp/memory-session.jsonl",
			});
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
			const { ctx, switchSession, moveTo, state } = createResumeContext({
				sourceCwd,
				previousSessionFile: "/tmp/target-session.jsonl",
			});
			switchSession.mockImplementation(async (sessionPath, options) => {
				if (sessionPath === "/tmp/target-session.jsonl") return false;
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
			const { ctx, switchSession, state } = createResumeContext({
				sourceCwd: tmpDir,
				previousSessionFile: "/tmp/some-session.jsonl",
			});
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
		vi.spyOn(SessionManager, "listForPicker").mockResolvedValue([session]);
		const OriginalSelector = SessionSelector.SessionSelectorComponent;
		const selectionPromises: Promise<void>[] = [];
		vi.spyOn(SessionSelector, "SessionSelectorComponent").mockImplementation(
			((
				sessions: SessionInfo[],
				onSelect: (session: SessionInfo) => void,
				onCancel: () => void,
				onExit: () => void,
				options: SessionSelector.SessionSelectorOptions<SessionInfo>,
			) =>
				new OriginalSelector<SessionInfo>(
					sessions,
					selected => {
						selectionPromises.push(onSelect(selected) as unknown as Promise<void>);
					},
					onCancel,
					onExit,
					options,
				)) as never,
		);
		const { ctx, switchSession, editor, hide, setFocus, flush, getSelector } = createResumeContext({
			previousSessionFile: session.path,
		});
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
		const rendered = selector!.render(120).join("\n");
		expect(rendered).toContain("Error:");
		expect(rendered).toContain("disk full");
		expect(switchSession).not.toHaveBeenCalled();

		selector!.handleInput("\n");
		expect(selectionPromises).toHaveLength(2);
		await selectionPromises[1];
		expect(switchSession).toHaveBeenCalledTimes(1);
		expect(hide).toHaveBeenCalledTimes(1);
	});

	it("keeps the selector visible with an inline error when switching rejects", async () => {
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
		vi.spyOn(SessionManager, "listForPicker").mockResolvedValue([session]);
		const OriginalSelector = SessionSelector.SessionSelectorComponent;
		let selectionPromise: Promise<void> | undefined;
		vi.spyOn(SessionSelector, "SessionSelectorComponent").mockImplementation(
			((
				sessions: SessionInfo[],
				onSelect: (session: SessionInfo) => void,
				onCancel: () => void,
				onExit: () => void,
				options: SessionSelector.SessionSelectorOptions<SessionInfo>,
			) =>
				new OriginalSelector<SessionInfo>(
					sessions,
					selected => {
						selectionPromise = onSelect(selected) as unknown as Promise<void>;
					},
					onCancel,
					onExit,
					options,
				)) as never,
		);
		const { ctx, switchSession, editor, hide, setFocus, getSelector } = createResumeContext({
			previousSessionFile: session.path,
		});
		const switchError = new Error("\u001b[31mswitch failed\u001b[0m\u0007");
		switchSession.mockRejectedValueOnce(switchError).mockResolvedValue(true);
		const controller = new SelectorController(ctx);
		await controller.showSessionSelector();
		const selector = getSelector();
		expect(selector).toBeDefined();

		selector!.handleInput("\n");
		expect(selectionPromise).toBeDefined();
		await selectionPromise;

		expect(ctx.showError).not.toHaveBeenCalled();
		const rendered = selector!.render(120).join("\n");
		expect(rendered).toContain("switch failed");
		expect(rendered).not.toContain("\u001b[31m");
		expect(rendered).not.toContain("\u0007");
		const nativeContext: DescribeContext = {
			cols: 120,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		};
		const native = JSON.stringify(selector!.describe(nativeContext));
		expect(native).toContain("switch failed");
		expect(native).not.toContain("\\u001b");
		expect(native).not.toContain("\\u0007");
		expect(ctx.settings.flush).toHaveBeenCalledTimes(1);
		expect(switchSession).toHaveBeenCalledWith(
			session.path,
			expect.objectContaining({ onCwdChange: expect.any(Function) }),
		);
		expect(hide).not.toHaveBeenCalled();
		expect(setFocus).not.toHaveBeenCalledWith(editor);

		selector!.handleInput("\n");
		expect(selectionPromise).toBeDefined();
		await selectionPromise;
		expect(hide).toHaveBeenCalledTimes(1);
	});
	it("recovers to the saved primary worktree and preserves an explicit storage override", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-primary-"));
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(root, "agent"));
		try {
			const sourceCwd = path.join(root, "launch");
			const primaryCwd = path.join(root, "primary");
			const missingCwd = path.join(root, "deleted-worktree");
			const sessionPath = path.join(root, "session.jsonl");
			const activeSessionPath = path.join(root, "active.jsonl");
			const explicitSessionDir = path.join(root, "explicit-session-dir");
			await fs.mkdir(sourceCwd);
			await fs.mkdir(primaryCwd);
			await writeRecoverySession(sessionPath, missingCwd, {
				sessionWorktreeRoot: missingCwd,
				primaryWorktreeRoot: primaryCwd,
			});
			const { ctx, switchSession, applyCwdChange, state, showHookCustom } = createResumeContext({
				sourceCwd,
				previousSessionFile: activeSessionPath,
				managerSessionDir: path.join(root, "unrelated-manager-bucket"),
				sessionDirOverride: explicitSessionDir,
			});
			switchSession.mockImplementation(async (_path, options) => {
				state.cwd = primaryCwd;
				return options?.onCwdChange ? options.onCwdChange(primaryCwd, sourceCwd) : true;
			});
			const result = await new SelectorController(ctx).handleResumeSession(sessionPath);

			expect(result).toBe(true);
			const relocatedFiles = await fs.readdir(explicitSessionDir);
			expect(relocatedFiles.some(file => file.endsWith(".jsonl"))).toBe(true);
			expect(showHookCustom).not.toHaveBeenCalled();
			expect(state.cwd).toBe(primaryCwd);
			expect(state.settingsScope).toBe(primaryCwd);
			expect(applyCwdChange).toHaveBeenCalledWith(primaryCwd);
			expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining(missingCwd));
			expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining(primaryCwd));
		} finally {
			setAgentDir(previousAgentDir);
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it("resumes in a selected existing directory relative to the active cwd", async () => {
		let relocatedFile: string | undefined;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-select-"));
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(root, "agent"));
		try {
			const sourceCwd = path.join(root, "launch");
			const selectedCwd = path.join(sourceCwd, "selected");
			const missingCwd = path.join(root, "missing");
			const sessionPath = path.join(root, `${path.basename(root)}.jsonl`);
			await fs.mkdir(selectedCwd, { recursive: true });
			await writeRecoverySession(sessionPath, missingCwd);
			const unrelatedManagerBucket = path.join(root, "unrelated-manager-bucket");
			const { ctx, switchSession, state } = createResumeContext({
				sourceCwd,
				managerSessionDir: unrelatedManagerBucket,
				directoryResults: [{ directory: "selected" }],
			});
			switchSession.mockImplementation(async (_path, options) => {
				state.cwd = selectedCwd;
				return options?.onCwdChange ? options.onCwdChange(selectedCwd, sourceCwd) : true;
			});
			const result = await new SelectorController(ctx).handleResumeSession(sessionPath);

			expect(result).toBe(true);
			relocatedFile = path.join(SessionManager.getDefaultSessionDir(selectedCwd), path.basename(sessionPath));
			expect(await fs.stat(relocatedFile)).toBeTruthy();
			const unrelatedFiles = await fs.readdir(unrelatedManagerBucket).catch(() => []);
			expect(unrelatedFiles).toHaveLength(0);
			expect(state.cwd).toBe(selectedCwd);
		} finally {
			if (relocatedFile) await fs.rm(relocatedFile, { force: true });
			setAgentDir(previousAgentDir);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("reports an invalid directory and keeps the picker retryable", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-retry-"));
		try {
			const sourceCwd = path.join(root, "launch");
			const selectedCwd = path.join(sourceCwd, "selected");
			const invalidCwd = path.join(root, "does-not-exist");
			const sessionPath = path.join(root, "session.jsonl");
			await fs.mkdir(selectedCwd, { recursive: true });
			await writeRecoverySession(sessionPath, path.join(root, "missing"));
			const { ctx, switchSession, state, showHookCustom } = createResumeContext({
				sourceCwd,
				directoryResults: [{ directory: invalidCwd }, { directory: "selected" }],
				sessionDirOverride: path.join(root, "relocated-sessions"),
			});
			switchSession.mockImplementation(async (_path, options) => {
				state.cwd = selectedCwd;
				return options?.onCwdChange ? options.onCwdChange(selectedCwd, sourceCwd) : true;
			});
			const controller = new SelectorController(ctx);
			const firstResult = await controller.handleResumeSession(sessionPath);

			expect(firstResult).toBe(false);
			expect(showHookCustom).toHaveBeenCalledTimes(1);
			expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining(invalidCwd));
			expect(state.cwd).toBe(sourceCwd);
			expect(switchSession).not.toHaveBeenCalled();

			const secondResult = await controller.handleResumeSession(sessionPath);
			expect(secondResult).toBe(true);
			expect(showHookCustom).toHaveBeenCalledTimes(2);
			expect(state.cwd).toBe(selectedCwd);
			expect(switchSession).toHaveBeenCalledTimes(1);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("cancels recovery without changing the active session, cwd, or settings scope", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-cancel-"));
		try {
			const sourceCwd = path.join(root, "launch");
			const missingCwd = path.join(root, "missing");
			const sessionPath = path.join(root, "session.jsonl");
			const activeSessionPath = path.join(root, "active.jsonl");
			await fs.mkdir(sourceCwd);
			await writeRecoverySession(sessionPath, missingCwd);
			const { ctx, switchSession, applyCwdChange, state, settings, showHookCustom } = createResumeContext({
				sourceCwd,
				previousSessionFile: activeSessionPath,
				directoryResults: [undefined],
			});
			const result = await new SelectorController(ctx).handleResumeSession(sessionPath);

			expect(result).toBe(false);
			expect(showHookCustom).toHaveBeenCalledTimes(1);
			expect(switchSession).not.toHaveBeenCalled();
			expect(applyCwdChange).not.toHaveBeenCalled();
			expect(state.cwd).toBe(sourceCwd);
			expect(state.settingsScope).toBe(sourceCwd);
			expect(settings.scope).toBe(sourceCwd);
			expect(ctx.sessionManager.getSessionFile()).toBe(activeSessionPath);
			expect(ctx.showStatus).not.toHaveBeenCalled();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("reports a directory that disappears during switching and leaves the active session usable", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-disappear-"));
		try {
			const sourceCwd = path.join(root, "launch");
			const selectedCwd = path.join(root, "selected");
			const sessionPath = path.join(root, "session.jsonl");
			const activeSessionPath = path.join(root, "active.jsonl");
			await fs.mkdir(sourceCwd);
			await fs.mkdir(selectedCwd);
			await writeRecoverySession(sessionPath, path.join(root, "missing"));
			const { ctx, switchSession, applyCwdChange, state, showHookCustom } = createResumeContext({
				sourceCwd,
				previousSessionFile: activeSessionPath,
				directoryResults: [{ directory: selectedCwd }],
				sessionDirOverride: path.join(root, "relocated-sessions"),
			});
			switchSession.mockImplementation(async (_path, options) => {
				state.cwd = selectedCwd;
				await fs.rm(selectedCwd, { recursive: true, force: true });
				const applied = options?.onCwdChange ? await options.onCwdChange(selectedCwd, sourceCwd) : true;
				if (!applied) state.cwd = sourceCwd;
				return applied;
			});
			applyCwdChange.mockImplementation(async newCwd => {
				try {
					await fs.stat(newCwd);
					return true;
				} catch {
					return false;
				}
			});
			const result = await new SelectorController(ctx).handleResumeSession(sessionPath);

			expect(result).toBe(false);
			expect(showHookCustom).toHaveBeenCalledTimes(1);
			expect(state.cwd).toBe(sourceCwd);
			expect(ctx.sessionManager.getSessionFile()).toBe(activeSessionPath);
			expect(ctx.showError).toHaveBeenCalled();
			expect(ctx.showStatus).not.toHaveBeenCalled();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("reports cwd rejection and rolls runtime and settings back to the active session", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-cwd-reject-"));
		try {
			const sourceCwd = path.join(root, "launch");
			const selectedCwd = path.join(root, "selected");
			const sessionPath = path.join(root, "session.jsonl");
			const activeSessionPath = path.join(root, "active.jsonl");
			await fs.mkdir(sourceCwd);
			await fs.mkdir(selectedCwd);
			await writeRecoverySession(sessionPath, path.join(root, "missing"));
			const { ctx, switchSession, applyCwdChange, state, settings, showHookCustom } = createResumeContext({
				sourceCwd,
				previousSessionFile: activeSessionPath,
				directoryResults: [{ directory: selectedCwd }],
				sessionDirOverride: path.join(root, "relocated-sessions"),
			});
			applyCwdChange.mockResolvedValue(false);
			switchSession.mockImplementation(async (_path, options) => {
				state.cwd = selectedCwd;
				state.settingsScope = selectedCwd;
				const applied = options?.onCwdChange ? await options.onCwdChange(selectedCwd, sourceCwd) : true;
				if (!applied) {
					state.cwd = sourceCwd;
					state.settingsScope = sourceCwd;
				}
				return applied;
			});
			const result = await new SelectorController(ctx).handleResumeSession(sessionPath);

			expect(result).toBe(false);
			expect(state.cwd).toBe(sourceCwd);
			expect(state.settingsScope).toBe(sourceCwd);
			expect(settings.scope).toBe(sourceCwd);
			expect(ctx.sessionManager.getSessionFile()).toBe(activeSessionPath);
			expect(ctx.showError).toHaveBeenCalled();
			expect(ctx.showStatus).not.toHaveBeenCalled();
			expect(showHookCustom).toHaveBeenCalledTimes(1);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("leaves a live-writer refusal retryable without losing the active session", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-live-writer-"));
		try {
			const sourceCwd = path.join(root, "launch");
			const primaryCwd = path.join(root, "primary");
			const missingCwd = path.join(root, "missing");
			const sessionPath = path.join(root, "session.jsonl");
			const activeSessionPath = path.join(root, "active.jsonl");
			await fs.mkdir(sourceCwd);
			await fs.mkdir(primaryCwd);
			await writeRecoverySession(sessionPath, missingCwd, {
				sessionWorktreeRoot: missingCwd,
				primaryWorktreeRoot: primaryCwd,
			});
			const liveWriterError = new Error("session is being written by another process");
			const relocation = vi.spyOn(SessionManager, "open");
			relocation.mockRejectedValueOnce(liveWriterError);
			const { ctx, switchSession, state, showHookCustom } = createResumeContext({
				sourceCwd,
				previousSessionFile: activeSessionPath,
				sessionDirOverride: path.join(root, "relocated-sessions"),
			});
			switchSession.mockImplementation(async (_path, options) => {
				state.cwd = primaryCwd;
				return options?.onCwdChange ? options.onCwdChange(primaryCwd, sourceCwd) : true;
			});
			const controller = new SelectorController(ctx);

			const firstResult = await controller.handleResumeSession(sessionPath);
			expect(firstResult).toBe(false);
			expect(state.cwd).toBe(sourceCwd);
			expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining(liveWriterError.message));
			expect(ctx.sessionManager.getSessionFile()).toBe(activeSessionPath);

			const secondResult = await controller.handleResumeSession(sessionPath);
			expect(secondResult).toBe(true);
			expect(state.cwd).toBe(primaryCwd);
			expect(showHookCustom).not.toHaveBeenCalled();
			expect(relocation).toHaveBeenCalledTimes(2);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it("rolls back a real relocation after a thrown switch and retries the original row", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-rollback-throw-"));
		try {
			const sourceCwd = path.join(root, "launch");
			const targetCwd = path.join(root, "target");
			const missingCwd = path.join(root, "missing");
			const activeSessionPath = path.join(root, "active.jsonl");
			await fs.mkdir(sourceCwd);
			await fs.mkdir(targetCwd);
			const { sessionPath, sessionId, artifactId } = await createPersistedRecoverySession(root, missingCwd);
			const { ctx, switchSession, state, settings } = createResumeContext({
				sourceCwd,
				previousSessionFile: activeSessionPath,
				directoryResults: [{ directory: targetCwd }, { directory: targetCwd }],
				sessionDirOverride: path.join(root, "relocated-sessions"),
			});
			const restoreActiveState = () => {
				state.cwd = sourceCwd;
				state.settingsScope = sourceCwd;
				settings.scope = sourceCwd;
			};
			const switchError = new Error("switch failed");
			switchSession
				.mockImplementationOnce(async (_path, options) => {
					state.cwd = targetCwd;
					await options?.onCwdChange?.(targetCwd, sourceCwd);
					restoreActiveState();
					throw switchError;
				})
				.mockImplementationOnce(async (_path, options) => {
					state.cwd = targetCwd;
					return options?.onCwdChange ? options.onCwdChange(targetCwd, sourceCwd) : true;
				});
			const controller = new SelectorController(ctx);

			await expect(controller.handleResumeSession(sessionPath)).rejects.toThrow("switch failed");

			const movedPath = switchSession.mock.calls[0]?.[0];
			if (typeof movedPath !== "string") throw new Error("Expected a relocated session path");
			expect(await fs.stat(sessionPath)).toBeTruthy();
			await expect(fs.stat(movedPath)).rejects.toThrow();
			await expectPersistedRecovery(sessionPath, missingCwd, sessionId, artifactId);
			expect(state.cwd).toBe(sourceCwd);
			expect(state.settingsScope).toBe(sourceCwd);
			expect(settings.scope).toBe(sourceCwd);
			expect(ctx.sessionManager.getSessionFile()).toBe(activeSessionPath);

			const result = await controller.handleResumeSession(sessionPath);
			expect(result).toBe(true);
			const resumedPath = switchSession.mock.calls[1]?.[0];
			if (typeof resumedPath !== "string") throw new Error("Expected a retry relocation path");
			expect(resumedPath).toBe(movedPath);
			await expectPersistedRecovery(resumedPath, targetCwd, sessionId, artifactId);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rolls back a real relocation after cwd-hook cancellation and retries the original row", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-rollback-cancel-"));
		try {
			const sourceCwd = path.join(root, "launch");
			const targetCwd = path.join(root, "target");
			const missingCwd = path.join(root, "missing");
			const activeSessionPath = path.join(root, "active.jsonl");
			await fs.mkdir(sourceCwd);
			await fs.mkdir(targetCwd);
			const { sessionPath, sessionId, artifactId } = await createPersistedRecoverySession(root, missingCwd);
			const { ctx, switchSession, applyCwdChange, state, settings } = createResumeContext({
				sourceCwd,
				previousSessionFile: activeSessionPath,
				directoryResults: [{ directory: targetCwd }, { directory: targetCwd }],
				sessionDirOverride: path.join(root, "relocated-sessions"),
			});
			const restoreActiveState = () => {
				state.cwd = sourceCwd;
				state.settingsScope = sourceCwd;
				settings.scope = sourceCwd;
			};
			applyCwdChange.mockResolvedValueOnce(false).mockResolvedValue(true);
			switchSession
				.mockImplementationOnce(async (_path, options) => {
					state.cwd = targetCwd;
					const applied = options?.onCwdChange ? await options.onCwdChange(targetCwd, sourceCwd) : true;
					if (!applied) restoreActiveState();
					return false;
				})
				.mockImplementationOnce(async (_path, options) => {
					state.cwd = targetCwd;
					return options?.onCwdChange ? options.onCwdChange(targetCwd, sourceCwd) : true;
				});
			const controller = new SelectorController(ctx);

			const firstResult = await controller.handleResumeSession(sessionPath);
			expect(firstResult).toBe(false);

			const movedPath = switchSession.mock.calls[0]?.[0];
			if (typeof movedPath !== "string") throw new Error("Expected a relocated session path");
			expect(await fs.stat(sessionPath)).toBeTruthy();
			await expect(fs.stat(movedPath)).rejects.toThrow();
			await expectPersistedRecovery(sessionPath, missingCwd, sessionId, artifactId);
			expect(state.cwd).toBe(sourceCwd);
			expect(state.settingsScope).toBe(sourceCwd);
			expect(settings.scope).toBe(sourceCwd);
			expect(ctx.sessionManager.getSessionFile()).toBe(activeSessionPath);

			const secondResult = await controller.handleResumeSession(sessionPath);
			expect(secondResult).toBe(true);
			const resumedPath = switchSession.mock.calls[1]?.[0];
			if (typeof resumedPath !== "string") throw new Error("Expected a retry relocation path");
			expect(resumedPath).toBe(movedPath);
			await expectPersistedRecovery(resumedPath, targetCwd, sessionId, artifactId);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
