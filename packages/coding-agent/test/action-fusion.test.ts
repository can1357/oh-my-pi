import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { getEditStore } from "@oh-my-pi/pi-coding-agent/edit/store";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	NATIVE_THEN_RUN_MESSAGE,
	THEN_RUN_BATCH_MESSAGE,
	THEN_RUN_MISSING_BASH_MESSAGE,
	extractThenRunCommand,
	hasThenRun,
	prepareThenRunFusion,
	stripThenRun,
	thenRunUnsupportedTargetReason,
} from "@oh-my-pi/pi-coding-agent/tools/action-fusion";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { formatHashlineHeader } from "@oh-my-pi/pi-tui/tools/hashline-format";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const BASE_SETTINGS = {
	"async.enabled": false,
	"bash.autoBackground.enabled": false,
	"bashInterceptor.enabled": false,
} as const;

function emptyWorkspaceTree(cwd: string) {
	return { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] };
}

function allText(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
	return (result.content ?? [])
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text)
		.join("\n");
}

function createNativeSession(cwd: string, settings: Settings = Settings.isolated()): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "session"),
		settings,
	};
}

function fakeWriteTool(): AgentTool {
	return {
		name: "write",
		label: "Write",
		description: "write",
		parameters: {},
		execute: async () => ({ content: [{ type: "text", text: "wrote" }] }),
		matcherPaths: args => {
			if (args && typeof args === "object" && "path" in args && typeof args.path === "string") {
				return [args.path];
			}
			return [];
		},
	} as AgentTool;
}

function fakeHashlineEditTool(): AgentTool {
	return {
		name: "edit",
		label: "Edit",
		description: "edit",
		parameters: {},
		execute: async () => ({ content: [{ type: "text", text: "edited" }] }),
		matcherPaths: args => {
			if (args && typeof args === "object" && "input" in args && typeof args.input === "string") {
				return ["local.ts"];
			}
			return [];
		},
	} as AgentTool;
}

function fakeBashTool(): AgentTool {
	return {
		name: "bash",
		label: "Bash",
		description: "bash",
		parameters: {},
		approval: "exec",
		execute: async () => ({ content: [{ type: "text", text: "ran" }] }),
	} as AgentTool;
}

describe("action fusion helpers", () => {
	it("keeps then_run as the original command string", () => {
		const params = { path: "a.ts", content: "x", then_run: "echo keep-me" };
		expect(hasThenRun(params)).toBe(true);
		expect(extractThenRunCommand(params)).toBe("echo keep-me");
		expect(stripThenRun(params)).toEqual({ path: "a.ts", content: "x" });
	});

	it("rejects xd, ssh, archive, and sqlite targets before mutation", () => {
		expect(thenRunUnsupportedTargetReason("xd://bash")).toMatch(/xd:\/\//);
		expect(thenRunUnsupportedTargetReason("ssh://host/tmp/a.ts")).toMatch(/ssh:\/\//);
		expect(thenRunUnsupportedTargetReason("pkg.tar.gz:inner/file.txt")).toMatch(/archive/);
		expect(thenRunUnsupportedTargetReason("data.sqlite:users")).toMatch(/sqlite/);
	});

	it("fail-closes when bash is missing", () => {
		expect(() =>
			prepareThenRunFusion({
				tool: fakeWriteTool(),
				params: { path: "local.ts", content: "a", then_run: "echo x" },
				runner: { getFollowUpBashTool: () => undefined },
			}),
		).toThrow(THEN_RUN_MISSING_BASH_MESSAGE);
	});

	it("fail-closes bash deny before returning mutation params", () => {
		expect(() =>
			prepareThenRunFusion({
				tool: fakeWriteTool(),
				params: { path: "local.ts", content: "a", then_run: "echo x" },
				runner: {
					getFollowUpBashTool: () => fakeBashTool(),
					sessionSettings: Settings.isolated({ "tools.approval": { bash: "deny" } }),
				},
				context: { settings: Settings.isolated({ "tools.approval": { bash: "deny" } }) } as AgentToolContext,
			}),
		).toThrow(/blocked by user policy/i);
	});

	it("rejects then_run on a non-final LSP write/edit batch", () => {
		expect(() =>
			prepareThenRunFusion({
				tool: fakeWriteTool(),
				params: { path: "local.ts", content: "a", then_run: "echo x" },
				runner: { getFollowUpBashTool: () => fakeBashTool() },
				context: {
					toolCall: {
						batchId: "b1",
						index: 0,
						total: 2,
						toolCalls: [
							{ id: "c1", name: "write" },
							{ id: "c2", name: "write" },
						],
					},
				} as AgentToolContext,
			}),
		).toThrow(THEN_RUN_BATCH_MESSAGE);
	});

	it("accepts JSON hashline then_run and strips it before mutation", () => {
		const prepared = prepareThenRunFusion({
			tool: fakeHashlineEditTool(),
			params: { input: "[local.ts#abcd]\nPUT 1.=1:\n+ok\n", then_run: "echo keep-me" },
			runner: { getFollowUpBashTool: () => fakeBashTool() },
			context: { settings: Settings.isolated({ "tools.approvalMode": "yolo" }) } as AgentToolContext,
		});
		expect(prepared?.command).toBe("echo keep-me");
		expect(prepared?.mutationParams).toEqual({
			input: "[local.ts#abcd]\nPUT 1.=1:\n+ok\n",
		});
		expect(hasThenRun(prepared?.mutationParams)).toBe(false);
	});
});

describe("native write/edit then_run fail closed", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), `fusion-native-${Snowflake.next()}-`));
	});

	afterEach(() => {
		removeSyncWithRetries(cwd);
	});

	it("does not write when native write is called with then_run", async () => {
		const target = path.join(cwd, "nope.txt");
		const write = new WriteTool(createNativeSession(cwd));
		await expect(
			write.execute("native-write", { path: target, content: "secret", then_run: "echo leaked" }),
		).rejects.toThrow(NATIVE_THEN_RUN_MESSAGE);
		expect(fs.existsSync(target)).toBe(false);
	});

	it("does not edit when native replace edit is called with then_run", async () => {
		const target = path.join(cwd, "keep.txt");
		fs.writeFileSync(target, "alpha\n");
		const edit = new EditTool(createNativeSession(cwd), "replace");
		await expect(
			edit.execute("native-edit", {
				path: target,
				old_string: "alpha",
				new_string: "beta",
				then_run: "echo leaked",
			}),
		).rejects.toThrow(NATIVE_THEN_RUN_MESSAGE);
		expect(fs.readFileSync(target, "utf8")).toBe("alpha\n");
	});

	it("fail-closes native hashline execute when then_run is still present", async () => {
		const edit = new EditTool(createNativeSession(cwd), "hashline");
		await expect(edit.execute("native-hashline", { input: "nope", then_run: "echo leaked" })).rejects.toThrow(
			NATIVE_THEN_RUN_MESSAGE,
		);
	});
});

describe("wrapped write/edit then_run", () => {
	let tempDir: string;
	let cwd: string;
	let session: AgentSession;
	let authStorage: AuthStorage;
	const originalEditVariant = Bun.env.PI_EDIT_VARIANT;

	beforeAll(async () => {
		Bun.env.PI_EDIT_VARIANT = "replace";
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `fusion-wrap-${Snowflake.next()}-`));
		cwd = path.join(tempDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		// createAgentSession opens AuthStorage under agentDir and does not close
		// it in session.dispose(); on Windows that SQLite handle keeps EBUSY on
		// the temp tree. Own the store (utilities.ts / aside-delivery pattern).
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		const created = await createAgentSession({
			cwd,
			agentDir: tempDir,
			authStorage,
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated(BASE_SETTINGS),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: emptyWorkspaceTree(cwd),
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["write", "edit", "bash"],
		});
		session = created.session;
	});

	afterAll(async () => {
		await session.dispose();
		authStorage.close();
		if (originalEditVariant === undefined) {
			delete Bun.env.PI_EDIT_VARIANT;
		} else {
			Bun.env.PI_EDIT_VARIANT = originalEditVariant;
		}
		removeSyncWithRetries(tempDir);
	});

	function tool(name: "write" | "edit" | "bash") {
		const found = session.getToolByName(name);
		if (!found) throw new Error(`expected ${name}`);
		return found;
	}

	function ctx(extra: Record<string, unknown> = {}): AgentToolContext {
		return {
			settings: Settings.isolated({ ...BASE_SETTINGS, ...extra }),
		} as AgentToolContext;
	}

	it("write allow / bash deny does not mutate", async () => {
		const target = path.join(cwd, "denied.txt");
		await expect(
			tool("write").execute(
				"deny",
				{ path: target, content: "nope", then_run: "echo should-not-run" },
				undefined,
				undefined,
				ctx({ "tools.approval": { write: "allow", bash: "deny" } }),
			),
		).rejects.toThrow(/blocked by user policy/i);
		expect(fs.existsSync(target)).toBe(false);
	});

	it("runs then_run after a successful local write", async () => {
		const target = path.join(cwd, "ok.txt");
		const result = await tool("write").execute(
			"pass",
			{ path: target, content: "fusion-write-order\n", then_run: "cat ok.txt" },
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "yolo" }),
		);
		expect(fs.readFileSync(target, "utf8")).toBe("fusion-write-order\n");
		expect(result.isError).toBeUndefined();
		expect(allText(result)).toContain("then_run: pass");
		expect(allText(result)).toContain("fusion-write-order");
		expect((result.details as { thenRun?: { outcome: string } } | undefined)?.thenRun?.outcome).toBe("pass");
	});

	it("keeps the write and does not set isError when verification fails", async () => {
		const target = path.join(cwd, "keep-fail.txt");
		const result = await tool("write").execute(
			"verfail",
			{ path: target, content: "kept\n", then_run: "exit 1" },
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "yolo" }),
		);
		expect(fs.readFileSync(target, "utf8")).toBe("kept\n");
		expect(result.isError).toBeUndefined();
		expect(allText(result)).toContain("then_run: fail");
		expect((result.details as { thenRun?: { outcome: string } } | undefined)?.thenRun?.outcome).toBe("fail");
	});

	it("prompt rejection cancels verification and preserves the mutation", async () => {
		const target = path.join(cwd, "keep-cancel.txt");
		const result = await tool("write").execute(
			"prompt",
			{ path: target, content: "still-here\n", then_run: "echo no-ui" },
			undefined,
			undefined,
			ctx({
				"tools.approvalMode": "always-ask",
				"tools.approval": { write: "allow" },
			}),
		);
		expect(fs.readFileSync(target, "utf8")).toBe("still-here\n");
		expect(result.isError).toBeUndefined();
		expect(allText(result)).toContain("then_run: cancel");
		expect((result.details as { thenRun?: { outcome: string } } | undefined)?.thenRun?.outcome).toBe("cancel");
	});

	it("inherited xdev/ACP grants do not authorize bash", async () => {
		const target = path.join(cwd, "grant.txt");
		const result = await tool("write").execute(
			"grants",
			{ path: target, content: "granted-write\n", then_run: "echo should-prompt" },
			undefined,
			undefined,
			{
				...ctx({
					"tools.approvalMode": "always-ask",
					"tools.approval": { write: "allow" },
				}),
				xdevApproved: true,
				acpApprovedArgs: {
					path: target,
					content: "granted-write\n",
					then_run: "echo should-prompt",
				},
			} as AgentToolContext,
		);
		expect(fs.readFileSync(target, "utf8")).toBe("granted-write\n");
		expect(allText(result)).toContain("then_run: cancel");
	});

	it("skips verification when the mutation fails", async () => {
		const target = path.join(cwd, "missing-old.txt");
		fs.writeFileSync(target, "only-this\n");
		const result = await tool("edit").execute(
			"mutfail",
			{
				path: target,
				old_string: "does-not-exist",
				new_string: "new",
				then_run: "echo should-skip",
			},
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "yolo" }),
		);
		expect(fs.readFileSync(target, "utf8")).toBe("only-this\n");
		expect(result.isError).toBe(true);
		expect(allText(result)).toContain("then_run: skipped");
		expect(allText(result)).not.toContain("should-skip");
	});

	it("runs then_run after a successful replace edit and keeps the diff on verification failure", async () => {
		const target = path.join(cwd, "edit-keep.ts");
		fs.writeFileSync(target, "const n = 1;\n");
		const result = await tool("edit").execute(
			"edit-fail",
			{
				path: target,
				old_string: "const n = 1;",
				new_string: "const n = 2;",
				then_run: "exit 1",
			},
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "yolo" }),
		);
		expect(fs.readFileSync(target, "utf8")).toBe("const n = 2;\n");
		expect(result.isError).toBeUndefined();
		expect(allText(result)).toContain("then_run: fail");
		expect((result.details as { diff?: string; thenRun?: { outcome: string } } | undefined)?.diff).toContain(
			"const n = 2",
		);
		expect((result.details as { thenRun?: { outcome: string } } | undefined)?.thenRun?.outcome).toBe("fail");
	});

	it("rejects then_run on a non-final batch write before creating the file", async () => {
		const target = path.join(cwd, "batch.txt");
		await expect(
			tool("write").execute("c1", { path: target, content: "batch\n", then_run: "echo no" }, undefined, undefined, {
				...ctx({ "tools.approvalMode": "yolo" }),
				toolCall: {
					batchId: "batch",
					index: 0,
					total: 2,
					toolCalls: [
						{ id: "c1", name: "write" },
						{ id: "c2", name: "write" },
					],
				},
			} as AgentToolContext),
		).rejects.toThrow(THEN_RUN_BATCH_MESSAGE);
		expect(fs.existsSync(target)).toBe(false);
	});

	it("runs JSON hashline then_run after a local mutation", async () => {
		const runner = session.extensionRunner;
		if (!runner) throw new Error("expected extension runner");
		const toolSession = createNativeSession(cwd);
		const hashline = new EditTool(toolSession, "hashline");
		const wrapped = new ExtensionToolWrapper(hashline, runner);
		const target = path.join(cwd, "hl.ts");
		const original = "const n = 1;\n";
		fs.writeFileSync(target, original);
		const tag = getEditStore(toolSession).recordSnapshot(target, original);
		const header = formatHashlineHeader(target, tag);
		const result = await wrapped.execute(
			"hl-json",
			{ input: `${header}\nPUT 1.=1:\n+const n = 2;\n`, then_run: "cat hl.ts" },
			undefined,
			undefined,
			ctx({ "tools.approvalMode": "yolo" }),
		);
		expect(fs.readFileSync(target, "utf8")).toBe("const n = 2;\n");
		expect(result.isError).toBeUndefined();
		expect(allText(result)).toContain("then_run: pass");
		expect(allText(result)).toContain("const n = 2");
	});
});
