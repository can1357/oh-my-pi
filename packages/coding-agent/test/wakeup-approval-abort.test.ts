/**
 * A tool call's abort signal reaches its approval dialog: an aborted call (a wakeup check past its
 * bound, a cancelled turn) dismisses the pending `approve`/`select` dialog, settles the call so a
 * serialized check queue moves on, and never records an answer that arrives after the abort.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, ToolTier } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionApprovalAnswer,
	ExtensionApprovalPrompt,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { requestApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { approvalTargetKey } from "@oh-my-pi/pi-coding-agent/tools/approval-targets";
import { getAgentDir, isRecord, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

/**
 * A dialog the test answers by hand: `opened` resolves once a host shows it, `answered` once it
 * settles, and `state` records the options it was shown with and whether its signal dismissed it.
 * A call that failed to settle on abort would hang its `rejects` assertion until the test times out.
 */
function manualDialog<T>() {
	const answer = Promise.withResolvers<T | undefined>();
	const opened = Promise.withResolvers<void>();
	const state = { options: undefined as ExtensionUIDialogOptions | undefined, calls: 0, dismissed: false };
	const show = (dialogOptions?: ExtensionUIDialogOptions): void => {
		state.calls++;
		state.options = dialogOptions;
		opened.resolve();
	};
	/** A host that honors `signal`, as the TUI and RPC hosts do: abort settles the dialog with no answer. */
	const honoring = (dialogOptions?: ExtensionUIDialogOptions): Promise<T | undefined> => {
		show(dialogOptions);
		dialogOptions?.signal?.addEventListener(
			"abort",
			() => {
				state.dismissed = true;
				answer.resolve(undefined);
			},
			{ once: true },
		);
		return answer.promise;
	};
	/** A host that ignores `signal` and answers whenever the test says so. */
	const ignoring = (dialogOptions?: ExtensionUIDialogOptions): Promise<T | undefined> => {
		show(dialogOptions);
		return answer.promise;
	};
	return {
		state,
		honoring,
		ignoring,
		opened: opened.promise,
		answered: answer.promise,
		answer: (value: T | undefined) => answer.resolve(value),
	};
}

const execSubject = { name: "probe_exec", approval: "exec" as const };

describe("requestApproval cancellation", () => {
	it("passes the signal to approve(), dismisses it on abort, and rejects the call", async () => {
		const dialog = manualDialog<ExtensionApprovalAnswer>();
		const ui = {
			select: vi.fn(async () => "Approve"),
			approve: (_prompt: ExtensionApprovalPrompt, options?: ExtensionUIDialogOptions) =>
				dialog.honoring(options) as Promise<ExtensionApprovalAnswer>,
		};
		const controller = new AbortController();
		const pending = requestApproval(ui, execSubject, {}, { signal: controller.signal });
		await dialog.opened;
		expect(dialog.state.options?.signal).toBe(controller.signal);

		controller.abort(new Error("check timed out"));
		await expect(pending).rejects.toThrow("check timed out");
		expect(dialog.state.dismissed).toBe(true);
		expect(ui.select).not.toHaveBeenCalled();
	});

	it("passes the signal to select(), dismisses it on abort, and rejects the call", async () => {
		const dialog = manualDialog<string>();
		const ui = {
			select: (_title: string, _options: ExtensionUISelectItem[], options?: ExtensionUIDialogOptions) =>
				dialog.honoring(options),
		};
		const controller = new AbortController();
		const pending = requestApproval(ui, execSubject, {}, { signal: controller.signal, sessionSubject: "probe" });
		await dialog.opened;
		expect(dialog.state.options?.signal).toBe(controller.signal);

		controller.abort(new Error("check timed out"));
		await expect(pending).rejects.toThrow("check timed out");
		expect(dialog.state.dismissed).toBe(true);
	});

	it("settles promptly and drops a late answer from a host that ignores the signal", async () => {
		const approveDialog = manualDialog<ExtensionApprovalAnswer>();
		const approveUi = {
			select: async () => undefined,
			approve: (_prompt: ExtensionApprovalPrompt, options?: ExtensionUIDialogOptions) =>
				approveDialog.ignoring(options) as Promise<ExtensionApprovalAnswer>,
		};
		const approveAbort = new AbortController();
		const approvePending = requestApproval(approveUi, execSubject, {}, { signal: approveAbort.signal });
		await approveDialog.opened;
		approveAbort.abort(new Error("check timed out"));
		await expect(approvePending).rejects.toThrow("check timed out");
		approveDialog.answer("once");
		await approveDialog.answered;

		const selectDialog = manualDialog<string>();
		const selectUi = {
			select: (_title: string, _options: ExtensionUISelectItem[], options?: ExtensionUIDialogOptions) =>
				selectDialog.ignoring(options),
		};
		const selectAbort = new AbortController();
		const selectPending = requestApproval(selectUi, execSubject, {}, { signal: selectAbort.signal });
		await selectDialog.opened;
		selectAbort.abort(new Error("check timed out"));
		await expect(selectPending).rejects.toThrow("check timed out");
		selectDialog.answer("Approve");
		await selectDialog.answered;
	});

	it("shows no dialog for a call already aborted", async () => {
		const ui = { select: vi.fn(async () => "Approve"), approve: vi.fn(async () => "once" as const) };
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(requestApproval(ui, execSubject, {}, { signal: controller.signal })).rejects.toThrow("cancelled");
		expect(ui.approve).not.toHaveBeenCalled();
		expect(ui.select).not.toHaveBeenCalled();
	});

	it("leaves a call without a signal exactly as before", async () => {
		const approve = vi.fn(async (..._args: unknown[]) => "once" as const);
		expect(await requestApproval({ select: async () => undefined, approve }, execSubject, {})).toBe("once");
		expect(approve.mock.calls[0]).toHaveLength(1);

		const select = vi.fn(async (..._args: unknown[]) => "Approve");
		expect(await requestApproval({ select }, execSubject, {})).toBe("once");
		expect(select.mock.calls[0]).toHaveLength(2);
	});
});

describe("ExtensionToolWrapper approval cancellation", () => {
	let root: TempDir;
	let agentDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let originalAgentDir: string;

	beforeAll(async () => {
		root = TempDir.createSync("@pi-wakeup-approval-abort-");
		authStorage = await AuthStorage.create(path.join(root.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});
	afterAll(() => {
		authStorage.close();
		root.removeSync();
	});
	beforeEach(() => {
		originalAgentDir = getAgentDir();
		agentDir = fs.mkdtempSync(path.join(root.path(), "agent-"));
		setAgentDir(agentDir);
	});
	afterEach(() => {
		setAgentDir(originalAgentDir);
	});

	function pathTool(name: string, tier: ToolTier, cwd: string, executed: string[]): AgentTool {
		return {
			name,
			label: name,
			description: `${name} test tool`,
			parameters: {} as never,
			approval: tier,
			approvalCacheTargets: (args: unknown) =>
				isRecord(args) && typeof args.path === "string" ? [approvalTargetKey(cwd, args.path)!] : undefined,
			execute: async toolCallId => {
				executed.push(toolCallId);
				return { content: [{ type: "text" as const, text: "executed" }] };
			},
		};
	}

	function runnerWith(sessionManager: SessionManager, select: ExtensionUIContext["select"]): ExtensionRunner {
		const runner = new ExtensionRunner([], new ExtensionRuntime(), agentDir, sessionManager, modelRegistry);
		runner.initialize(
			{
				sendMessage: () => {},
				sendUserMessage: async () => {},
				appendEntry: () => {},
				setLabel: () => {},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: async () => {},
				getCommands: () => [],
				setModel: async () => false,
				getThinkingLevel: () => undefined,
				setThinkingLevel: () => {},
				getSessionName: () => undefined,
				setSessionName: async () => {},
			},
			{
				getModel: () => undefined,
				isIdle: () => true,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: async () => {},
				getSystemPrompt: () => [],
			},
			undefined,
			{
				select,
				confirm: async () => false,
				input: async () => undefined,
				notify: () => {},
				onTerminalInput: () => () => {},
				rerenderMessage: () => {},
				refreshTranscript: () => {},
				getLinkClicksAvailable: () => false,
				setStatus: () => {},
				setWorkingMessage: () => {},
				setWidget: () => {},
				setFooter: () => {},
				setHeader: () => {},
				setTitle: () => {},
				custom: async <T>() => undefined as T,
				pasteToEditor: () => {},
				setEditorText: () => {},
				getEditorText: () => "",
				editor: async () => undefined,
				addAutocompleteProvider: () => {},
				setEditorComponent: () => {},
				getEditorComponent: () => undefined,
				get theme() {
					return {} as never;
				},
				getAllThemes: async () => [],
				getTheme: async () => undefined,
				setTheme: async () => ({ success: false, error: "not implemented" }),
				getToolsExpanded: () => false,
				setToolsExpanded: () => {},
			} satisfies ExtensionUIContext,
		);
		return runner;
	}

	function context(sessionManager: SessionManager): AgentToolContext {
		return {
			sessionManager,
			modelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
			settings: Settings.isolated({ "tools.approvalMode": "always-ask-cached" }),
		} as AgentToolContext;
	}

	it("dismisses the pending dialog and settles the call when its signal aborts", async () => {
		const cwd = path.join(agentDir, "work");
		const executed: string[] = [];
		const session = SessionManager.inMemory(cwd);
		const dialog = manualDialog<string>();
		const wrapper = new ExtensionToolWrapper(
			pathTool("write", "write", cwd, executed),
			runnerWith(session, (_title, _options, options) => dialog.honoring(options)),
		);
		const controller = new AbortController();
		const execution = wrapper.execute("c1", { path: "a.txt" }, controller.signal, undefined, context(session));
		await dialog.opened;
		expect(dialog.state.calls).toBe(1);
		expect(dialog.state.options?.signal).toBe(controller.signal);

		controller.abort(new Error("check timed out"));
		await expect(execution).rejects.toThrow("check timed out");
		expect(dialog.state.dismissed).toBe(true);
		expect(executed).toEqual([]);

		// A serial queue behind the aborted call runs the next one.
		const next = vi.fn(async () => "Approve Once");
		const nextWrapper = new ExtensionToolWrapper(
			pathTool("write", "write", cwd, executed),
			runnerWith(session, next),
		);
		await nextWrapper.execute("c2", { path: "a.txt" }, undefined, undefined, context(session));
		expect(executed).toEqual(["c2"]);
	});

	it("never records a grant answered after the abort", async () => {
		const cwd = path.join(agentDir, "work");
		const executed: string[] = [];
		const session = SessionManager.inMemory(cwd);
		const dialog = manualDialog<string>();
		const wrapper = new ExtensionToolWrapper(
			pathTool("write", "write", cwd, executed),
			runnerWith(session, (_title, _options, options) => dialog.ignoring(options)),
		);
		const controller = new AbortController();
		const execution = wrapper.execute("g1", { path: "a.txt" }, controller.signal, undefined, context(session));
		await dialog.opened;
		controller.abort(new Error("check timed out"));
		await expect(execution).rejects.toThrow("check timed out");
		// The host answers the stale dialog with the broadest grant only after the abort.
		dialog.answer("Always Approve File");
		await dialog.answered;
		expect(executed).toEqual([]);

		// Neither this conversation nor another one inherits that answer: both ask again.
		const again = vi.fn(async () => "Deny");
		await expect(
			new ExtensionToolWrapper(pathTool("write", "write", cwd, executed), runnerWith(session, again)).execute(
				"g2",
				{ path: "a.txt" },
				undefined,
				undefined,
				context(session),
			),
		).rejects.toThrow("denied by user");
		const other = SessionManager.inMemory(cwd);
		await expect(
			new ExtensionToolWrapper(pathTool("write", "write", cwd, executed), runnerWith(other, again)).execute(
				"g3",
				{ path: "a.txt" },
				undefined,
				undefined,
				context(other),
			),
		).rejects.toThrow("denied by user");
		expect(again).toHaveBeenCalledTimes(2);
		expect(executed).toEqual([]);
	});

	it("never records a session approval answered after the abort", async () => {
		const executed: string[] = [];
		const session = SessionManager.inMemory(path.join(agentDir, "work"));
		const dialog = manualDialog<string>();
		const tool: AgentTool = {
			...pathTool("probe_exec", "exec", agentDir, executed),
			approvalCacheTargets: undefined,
		};
		// Session approvals live on the runner, so the follow-up call must go through the same one.
		let select: ExtensionUIContext["select"] = (_title, _options, options) => dialog.ignoring(options);
		const runner = runnerWith(session, (title, options, dialogOptions) => select(title, options, dialogOptions));
		const wrapper = new ExtensionToolWrapper(tool, runner);
		const controller = new AbortController();
		const execution = wrapper.execute("s1", {}, controller.signal, undefined, context(session));
		await dialog.opened;
		controller.abort(new Error("check timed out"));
		await expect(execution).rejects.toThrow("check timed out");
		dialog.answer("Approve probe_exec for this session");
		await dialog.answered;

		const again = vi.fn(async () => "Deny");
		select = again;
		await expect(wrapper.execute("s2", {}, undefined, undefined, context(session))).rejects.toThrow("denied by user");
		expect(again).toHaveBeenCalledTimes(1);
		expect(executed).toEqual([]);
	});
});
