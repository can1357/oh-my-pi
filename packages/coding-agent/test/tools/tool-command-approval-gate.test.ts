/**
 * Approval for tools reached as bash tool commands: a line made only of mounted
 * tool commands passes the bash gate at read tier, and every command's own
 * wrapped tool is then prompted, denied, or allowed by its own tier and
 * `tools.approval.<tool>` policy.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import {
	type AgentTool,
	type AgentToolContext,
	type AgentToolResult,
	type ToolApproval,
} from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import {
	dispatchToolCommand,
	resolveToolCommand,
	type ToolCommandState,
} from "@oh-my-pi/pi-coding-agent/tools/tool-commands";
import { TempDir } from "@oh-my-pi/pi-utils";

const COMMENT_TOOL = "jira_addcomment";
const ISSUE_TOOL = "linear_create_issue";

/** Session with both tools mounted and `bash` active, so both resolve as commands. */
function mountedBashSession(settings: Record<string, unknown> = {}): ToolSession {
	const toolCommands: ToolCommandState = {
		tools: new Map(),
		mountedNames: new Set([COMMENT_TOOL, ISSUE_TOOL]),
		builtInNames: new Set(),
		isActive: () => false,
	};
	return {
		cwd: ".",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated(settings),
		toolCommands,
		isToolActive: name => name === "bash",
	};
}

function bashApproval(command: string, settings?: Record<string, unknown>) {
	return new BashTool(mountedBashSession(settings)).approval({ command });
}

describe("bash gate for tool-command lines", () => {
	it("returns read tier for a line made only of mounted tool commands", () => {
		for (const command of [
			`${COMMENT_TOOL} body=hi`,
			`${COMMENT_TOOL} body=hi && ${ISSUE_TOOL} title=bug`,
			`${COMMENT_TOOL} body=hi || ${ISSUE_TOOL} title=bug`,
			`${COMMENT_TOOL} --help | ${ISSUE_TOOL} --help`,
			`${COMMENT_TOOL} body=hi; ${ISSUE_TOOL} title=bug`,
			`${COMMENT_TOOL} body=hi\n${ISSUE_TOOL} title=bug`,
		]) {
			expect(bashApproval(command)).toBe("read");
		}
	});

	it("does not match bash.patterns or critical patterns against tool arguments", () => {
		const settings = {
			"bash.patterns": [
				{ match: "*git*reset* --hard*", approval: "deny" },
				{ match: "*curl*", approval: "prompt" },
			],
		};
		for (const command of [
			`${COMMENT_TOOL} body="how to git reset --hard safely"`,
			`${COMMENT_TOOL} body="curl example" && ${ISSUE_TOOL} title=bug`,
			`${COMMENT_TOOL} body="rm -rf /"`,
		]) {
			expect(bashApproval(command, settings)).toBe("read");
		}
		// The same text run as a shell command stays gated.
		expect(bashApproval("git reset --hard", settings)).toMatchObject({ policy: "deny" });
		expect(bashApproval(`echo hi && ${COMMENT_TOOL} body="git reset --hard"`, settings)).toMatchObject({
			policy: "deny",
		});
	});

	it("keeps its normal decision for anything the scan cannot vouch for", () => {
		// No `bash.patterns` rule matches, so a plain line resolves to exec tier.
		for (const command of [
			"echo hi",
			`${COMMENT_TOOL} body=hi && echo done`,
			`echo done && ${COMMENT_TOOL} body=hi`,
			`${COMMENT_TOOL} body=hi > /tmp/out`,
			`${COMMENT_TOOL} body=$(cat note.txt)`,
			`${COMMENT_TOOL} body=$HOME`,
			`${COMMENT_TOOL} body=\`cat note.txt\``,
			`${COMMENT_TOOL} body=hi & ${ISSUE_TOOL} title=bug`,
			`${COMMENT_TOOL} body=hi # note`,
			"unmounted_tool body=hi",
		]) {
			expect(bashApproval(command)).toBe("exec");
		}
	});
});

let root: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	root = TempDir.createSync("@pi-tool-command-approval-");
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

/** Context whose settings drive the wrapper's approval gate. */
function context(sessionManager: SessionManager, settings: Record<string, unknown>): AgentToolContext {
	return {
		sessionManager,
		modelRegistry,
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
		settings: Settings.isolated(settings),
	};
}

/** Tool whose `approval` declaration sets the tier the wrapper gates it at. */
function mountedTool(name: string, executed: unknown[], approval?: ToolApproval): AgentTool {
	return {
		name,
		label: "Add comment",
		description: "MCP tool reached as a bash tool command",
		parameters: type({ body: "string" }),
		...(approval === undefined ? {} : { approval }),
		async execute(_id, args) {
			executed.push(args);
			return { content: [{ type: "text", text: "commented" }] };
		},
	};
}

/** Command registry holding one approval-wrapped tool, as a live session's registry does. */
function commandState(runner: ExtensionRunner, tool: AgentTool): ToolCommandState {
	const tools = new Map<string, Tool>();
	tools.set(tool.name, new ExtensionToolWrapper(tool, runner));
	const state: ToolCommandState = {
		tools,
		mountedNames: new Set([tool.name]),
		builtInNames: new Set(),
		isActive: () => false,
		resolve: name => resolveToolCommand(state, name),
	};
	return state;
}

function textOf(result: AgentToolResult<unknown>): string {
	for (const block of result.content) {
		if (block.type === "text") return block.text;
	}
	return "";
}

describe("tool command dispatch approval", () => {
	const args = { body: "hello" };

	it("asks the mounted tool's own prompt policy and then executes", async () => {
		const sessionManager = SessionManager.inMemory(root.path());
		const select = vi.fn(async (_title: string, options: string[]) => options[0]);
		const executed: unknown[] = [];
		const state = commandState(runnerWith(sessionManager, select), mountedTool(COMMENT_TOOL, executed));

		const { result, dispatch } = await dispatchToolCommand(
			state,
			COMMENT_TOOL,
			args,
			"call-prompt",
			undefined,
			undefined,
			context(sessionManager, { "tools.approvalMode": "write", "tools.approval": { [COMMENT_TOOL]: "prompt" } }),
		);

		expect(select).toHaveBeenCalledTimes(1);
		expect(result.isError).toBeUndefined();
		expect(dispatch).toMatchObject({ tool: COMMENT_TOOL, mode: "execute", exitCode: 0, tier: "exec" });
		expect(executed).toEqual([args]);
	});

	it("denies through the mounted tool's own deny policy without asking", async () => {
		const sessionManager = SessionManager.inMemory(root.path());
		const select = vi.fn(async (_title: string, options: string[]) => options[0]);
		const executed: unknown[] = [];
		const state = commandState(runnerWith(sessionManager, select), mountedTool(COMMENT_TOOL, executed));

		const { result, dispatch } = await dispatchToolCommand(
			state,
			COMMENT_TOOL,
			args,
			"call-deny",
			undefined,
			undefined,
			context(sessionManager, { "tools.approvalMode": "always-ask", "tools.approval": { [COMMENT_TOOL]: "deny" } }),
		);

		expect(select).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("blocked by user policy");
		expect(dispatch).toMatchObject({ tool: COMMENT_TOOL, exitCode: 1, tier: "exec" });
		expect(executed).toEqual([]);
	});

	it("allows through the mounted tool's own allow policy without asking", async () => {
		const sessionManager = SessionManager.inMemory(root.path());
		const select = vi.fn(async (_title: string, options: string[]) => options[0]);
		const executed: unknown[] = [];
		const state = commandState(runnerWith(sessionManager, select), mountedTool(COMMENT_TOOL, executed));

		const { result, dispatch } = await dispatchToolCommand(
			state,
			COMMENT_TOOL,
			args,
			"call-allow",
			undefined,
			undefined,
			context(sessionManager, { "tools.approvalMode": "always-ask", "tools.approval": { [COMMENT_TOOL]: "allow" } }),
		);

		expect(select).not.toHaveBeenCalled();
		expect(result.isError).toBeUndefined();
		expect(dispatch).toMatchObject({ exitCode: 0, tier: "exec" });
		expect(executed).toEqual([args]);
	});

	it("allows a read-tier mounted tool in write mode without asking", async () => {
		const sessionManager = SessionManager.inMemory(root.path());
		const select = vi.fn(async (_title: string, options: string[]) => options[0]);
		const executed: unknown[] = [];
		const state = commandState(runnerWith(sessionManager, select), mountedTool(COMMENT_TOOL, executed, "read"));

		const { result, dispatch } = await dispatchToolCommand(
			state,
			COMMENT_TOOL,
			args,
			"call-read-tier",
			undefined,
			undefined,
			context(sessionManager, { "tools.approvalMode": "write" }),
		);

		expect(select).not.toHaveBeenCalled();
		expect(result.isError).toBeUndefined();
		expect(dispatch).toMatchObject({ exitCode: 0, tier: "read" });
		expect(executed).toEqual([args]);
	});
});
