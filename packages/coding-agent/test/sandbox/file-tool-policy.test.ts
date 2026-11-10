/**
 * The sandbox's filesystem policy on omp's in-process file tools: a path outside it is refused
 * before the tool runs, whatever the approval mode, until a `sandbox_request` grant covers it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, ToolTier } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { sandboxFileToolDenial } from "@oh-my-pi/pi-coding-agent/sandbox/file-tools";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import {
	cfgSandboxAllowRead,
	cfgSandboxDenyRead,
	cfgSandboxEnabled,
	cfgSandboxMode,
	cfgSandboxReadScope,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { approvalTargetKey, approvalTreeSearchKey } from "@oh-my-pi/pi-coding-agent/tools/approval-targets";
import { AstEditTool } from "@oh-my-pi/pi-coding-agent/tools/ast-edit";
import { applyWorkspaceEditWithLsp } from "@oh-my-pi/pi-coding-agent/lsp/client";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { SANDBOX_SUPPORTED } from "../helpers/sandbox-test-state";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let state: SettingsTestState | undefined;
let settings: Settings;
let scratch: TempDir;
let agentDir: string;
let workspace: string;
let outside: string;
let runtimes: SandboxRuntime[];

/** A file tool whose target is `args.path` (`tree` marks a recursive search of it), like read/write/grep. */
function pathTool(name: string, tier: ToolTier): AgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: {} as never,
		approval: tier,
		approvalCacheTargets: (args: unknown) => {
			if (!isRecord(args) || typeof args.path !== "string") return undefined;
			const key = approvalTargetKey(workspace, args.path)!;
			return [args.tree === true ? approvalTreeSearchKey(key) : key];
		},
		execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
	};
}

async function denial(tool: AgentTool, args: unknown, tier: ToolTier): Promise<string | undefined> {
	runtimes.push(await SandboxRuntime.for(workspace));
	return sandboxFileToolDenial({ settings, workspace, tool, args, tier, requestTool: () => true });
}

beforeEach(async () => {
	state = beginSettingsTest();
	scratch = TempDir.createSync("@omp-sandbox-file-tools-");
	const root = fs.realpathSync(scratch.path());
	agentDir = path.join(root, "agent");
	workspace = path.join(root, "workspace");
	outside = path.join(root, "outside");
	const tmp = path.join(root, "tmp");
	for (const dir of [agentDir, workspace, outside, tmp]) fs.mkdirSync(dir);
	vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
	runtimes = [];
	SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
	settings = await Settings.init({ inMemory: true, agentDir, cwd: workspace });
	cfgSandboxEnabled.set(settings, true);
});

afterEach(async () => {
	try {
		for (const instance of runtimes) await instance.dispose();
		SandboxRuntime.resetForTest();
	} finally {
		vi.restoreAllMocks();
		restoreSettingsTestState(state);
		state = undefined;
		scratch.removeSync();
	}
});

describe("sandbox policy on in-process file tools", () => {
	it("refuses a write outside the writable roots until a session grant covers it", async () => {
		const write = pathTool("write", "write");
		expect(await denial(write, { path: "notes.md" }, "write")).toBeUndefined();
		const refused = await denial(write, { path: path.join(outside, "a.txt") }, "write");
		expect(refused).toContain("outside the sandbox's writable roots");
		expect(refused).toContain("sandbox_request");
		(await SandboxRuntime.for(workspace)).grantPath("write", outside, "session");
		expect(await denial(write, { path: path.join(outside, "a.txt") }, "write")).toBeUndefined();
	});

	it("checks a modifying call as a write even when its tier is exec, and nothing while the sandbox is off", async () => {
		const target = { path: path.join(outside, "gone.txt") };
		expect(await denial(pathTool("edit", "exec"), target, "exec")).toContain("writable roots");
		cfgSandboxEnabled.set(settings, false);
		expect(await denial(pathTool("edit", "write"), target, "write")).toBeUndefined();
	});

	it("reads follow the readable roots contained processes get, minus protected paths", async () => {
		const read = pathTool("read", "read");
		const secrets = path.join(outside, "secrets");
		fs.mkdirSync(secrets);
		cfgSandboxDenyRead.set(settings, [secrets]);
		cfgSandboxAllowRead.set(settings, [outside]);
		// A protected path cannot be requested, so the refusal does not point at sandbox_request.
		const protectedRead = await denial(read, { path: path.join(secrets, "key") }, "read");
		expect(protectedRead).toContain("denyRead");
		expect(protectedRead).not.toContain("sandbox_request");
		// A recursive search above a protected path would read into it.
		expect(await denial(read, { path: outside, tree: true }, "read")).toContain("name a narrower path");
		expect(await denial(read, { path: outside }, "read")).toBeUndefined();
		cfgSandboxAllowRead.set(settings, []);

		// `all` reads system and profile trees, but it is not the filesystem root: device and virtual
		// trees (and Linux `/tmp`) stay unreadable, as they are to contained processes.
		const systemFile = process.platform === "win32" ? path.join(os.homedir(), "notes.txt") : "/usr/notes.txt";
		cfgSandboxReadScope.set(settings, "all");
		expect(await denial(read, { path: systemFile }, "read")).toBeUndefined();
		if (process.platform !== "win32") {
			expect(await denial(read, { path: "/dev/null" }, "read")).toContain("readable roots");
		}
		cfgSandboxReadScope.set(settings, "workspace");
		expect(await denial(read, { path: systemFile }, "read")).toContain("readable roots");
		expect(await denial(read, { path: "src/a.ts" }, "read")).toBeUndefined();
	});

	it("read-only mode refuses writes to the workspace", async () => {
		cfgSandboxMode.set(settings, "read-only");
		expect(await denial(pathTool("write", "write"), { path: "notes.md" }, "write")).toContain("writable roots");
	});

	it("ast_edit is checked where its globs rewrite", async () => {
		const astEdit = new AstEditTool({ cwd: workspace, settings } as unknown as ToolSession) as unknown as AgentTool;
		const args = (paths: string[]) => ({ ops: [{ pat: "a", out: "b" }], paths });
		expect(await denial(astEdit, args(["src/**/*.ts"]), "write")).toBeUndefined();
		expect(await denial(astEdit, args([`${outside}/**/*.ts`]), "write")).toContain("writable roots");
	});

	it("an LSP workspace edit outside the writable roots changes nothing", async () => {
		runtimes.push(await SandboxRuntime.for(workspace));
		const target = path.join(outside, "renamed.ts");
		const edit = { documentChanges: [{ kind: "create" as const, uri: Bun.pathToFileURL(target).href }] };
		await expect(applyWorkspaceEditWithLsp(edit, workspace)).rejects.toThrow("writable roots");
		expect(fs.existsSync(target)).toBe(false);
	});
});

describe("sandbox policy through the tool wrapper", () => {
	let authRoot: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authRoot = TempDir.createSync("@omp-sandbox-file-tools-auth-");
		authStorage = await AuthStorage.create(path.join(authRoot.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});
	afterAll(() => {
		authStorage.close();
		authRoot.removeSync();
	});

	it("refuses an out-of-policy write in yolo mode without running the tool", async () => {
		runtimes.push(await SandboxRuntime.for(workspace));
		const session = SessionManager.inMemory(workspace);
		const runner = new ExtensionRunner([], new ExtensionRuntime(), agentDir, session, modelRegistry);
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "executed" }] }));
		const wrapper = new ExtensionToolWrapper({ ...pathTool("write", "write"), execute }, runner);
		// `tools.approvalMode` defaults to yolo: nothing would prompt for this write.
		const context = { sessionManager: session, modelRegistry, settings } as unknown as AgentToolContext;

		await expect(
			wrapper.execute("w1", { path: path.join(outside, "untitled.txt") }, undefined, undefined, context),
		).rejects.toThrow("outside the sandbox's writable roots");
		expect(execute).not.toHaveBeenCalled();
		await wrapper.execute("w2", { path: "untitled.txt" }, undefined, undefined, context);
		expect(execute).toHaveBeenCalledTimes(1);
	});
});
