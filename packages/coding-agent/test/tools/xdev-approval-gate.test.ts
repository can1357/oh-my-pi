/**
 * Approval prompts for `write xd://<device>`: the write tool's outer gate and the
 * mounted tool's own wrapper must ask the user once per call (#17039).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { resolveXdevTool, type XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { TempDir } from "@oh-my-pi/pi-utils";

const DEVICE = "mcp__jira_addcomment";

let root: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	root = TempDir.createSync("@pi-xdev-approval-");
	authStorage = await AuthStorage.create(path.join(root.path(), "testauth.db"));
	modelRegistry = new ModelRegistry(authStorage);
});
afterAll(() => {
	authStorage.close();
	root.removeSync();
});

function runnerWith(sessionManager: SessionManager, select: ExtensionUIContext["select"]): ExtensionRunner {
	const runner = new ExtensionRunner([], new ExtensionRuntime(), root.path(), sessionManager, modelRegistry);
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

/**
 * The session's tool graph for one mounted device: the registry wraps every
 * tool (the mounted device included) in `ExtensionToolWrapper`, and `write`
 * dispatches `xd://` to the wrapped device.
 */
function mountedDevice(runner: ExtensionRunner, cwd: string): { write: AgentTool; executed: unknown[] } {
	const executed: unknown[] = [];
	const device: AgentTool = {
		name: DEVICE,
		label: "Add comment",
		description: "MCP tool without an approval declaration (exec tier)",
		parameters: type({ body: "string" }),
		async execute(_id, args) {
			executed.push(args);
			return { content: [{ type: "text", text: "commented" }] };
		},
	};
	const wrappedDevice = new ExtensionToolWrapper(device, runner) as unknown as Tool;
	const xdev: XdevState = {
		tools: new Map([[DEVICE, wrappedDevice]]),
		mountedNames: new Set([DEVICE]),
		builtInNames: new Set(),
		isActive: () => false,
		resolve: name => resolveXdevTool(xdev, name),
	};
	const writeTool = new WriteTool({
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({}),
		xdev,
	});
	return { write: new ExtensionToolWrapper(writeTool as unknown as AgentTool, runner), executed };
}

/**
 * The same graph for `edit` in apply_patch mode, active at the top level:
 * `write` dispatches both `xd://edit` and the wire alias `xd://apply_patch`
 * to the one wrapped `edit`.
 */
function editBehindWrite(runner: ExtensionRunner, cwd: string): AgentTool {
	const session: ToolSession = {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated({}),
	};
	const edit = new ExtensionToolWrapper(new EditTool(session, "apply_patch"), runner) as unknown as Tool;
	const xdev: XdevState = {
		tools: new Map([[edit.name, edit]]),
		mountedNames: new Set(),
		builtInNames: new Set(),
		isActive: name => name === edit.name,
		resolve: name => resolveXdevTool(xdev, name),
	};
	session.xdev = xdev;
	return new ExtensionToolWrapper(new WriteTool(session) as unknown as AgentTool, runner);
}

function context(sessionManager: SessionManager, settings: Record<string, unknown>): AgentToolContext {
	return {
		sessionManager,
		modelRegistry,
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
		settings: Settings.isolated(settings),
	} as AgentToolContext;
}

/**
 * Prompts per spelling of `edit` behind `write` under `tools.approval.edit:
 * prompt`, in a mode that asks for every write-tier call. Each call adds its
 * own file, so a spelling that never reached `edit` fails here instead of
 * counting zero prompts.
 */
async function editPromptsBySpelling(): Promise<Record<string, number>> {
	const cwd = root.path();
	const sessionManager = SessionManager.inMemory(cwd);
	const select = vi.fn(async (_title: string, options: string[]) => options[0]);
	const write = editBehindWrite(runnerWith(sessionManager, select), cwd);
	const settings = { "tools.approvalMode": "always-ask", "tools.approval": { edit: "prompt" } };
	const prompts: Record<string, number> = {};
	for (const spelling of ["edit", "apply_patch"]) {
		const file = `prompt-${spelling}.txt`;
		const input = ["*** Begin Patch", `*** Add File: ${file}`, "+ok", "*** End Patch"].join("\n");
		const asked = select.mock.calls.length;
		const result = await write.execute(
			`call-${spelling}`,
			{ path: `xd://${spelling}`, content: JSON.stringify({ input }) },
			undefined,
			undefined,
			context(sessionManager, settings),
		);
		expect(result.isError).toBeUndefined();
		expect(await Bun.file(path.join(cwd, file)).text()).toBe("ok\n");
		prompts[spelling] = select.mock.calls.length - asked;
	}
	return prompts;
}

const args = { path: `xd://${DEVICE}`, content: JSON.stringify({ body: "hello" }) };

describe("write xd://<device> approval", () => {
	it("asks once for an explicit device prompt policy", async () => {
		const cwd = root.path();
		const sessionManager = SessionManager.inMemory(cwd);
		const select = vi.fn(async (_title: string, options: string[]) => options[0]);
		const { write, executed } = mountedDevice(runnerWith(sessionManager, select), cwd);

		await write.execute(
			"call-1",
			args,
			undefined,
			undefined,
			context(sessionManager, { "tools.approvalMode": "write", "tools.approval": { [DEVICE]: "prompt" } }),
		);

		expect(select).toHaveBeenCalledTimes(1);
		expect(executed).toEqual([{ body: "hello" }]);
	});

	it("asks once for xd://apply_patch under tools.approval.edit: prompt, as for xd://edit", async () => {
		// The outer gate must key the alias on `edit`: keyed on `apply_patch`, the
		// mode asks there and the inner `edit` gate asks again for its own policy.
		expect(await editPromptsBySpelling()).toEqual({ edit: 1, apply_patch: 1 });
	});
});
