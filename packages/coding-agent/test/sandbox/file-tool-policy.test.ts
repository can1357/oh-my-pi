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
import { invokeEvalPrelude } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { sandboxCallDenial, sandboxSubjects } from "@oh-my-pi/pi-coding-agent/sandbox/gate";
import { grantExecIn } from "@oh-my-pi/pi-coding-agent/sandbox/grants";
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
import { DebugTool } from "@oh-my-pi/pi-coding-agent/tools/debug";
import { createTtsTool } from "@oh-my-pi/pi-coding-agent/tools/tts";
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
	return sandboxCallDenial({
		settings,
		workspace,
		name: tool.name,
		subjects: () => sandboxSubjects(tool, args, tier),
		requestTool: () => true,
	});
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
	it("refuses a write outside the writable roots until a session grant covers it, and the workspace in read-only mode", async () => {
		const write = pathTool("write", "write");
		expect(await denial(write, { path: "notes.md" }, "write")).toBeUndefined();
		const refused = await denial(write, { path: path.join(outside, "a.txt") }, "write");
		expect(refused).toContain("outside the sandbox's writable roots");
		expect(refused).toContain("sandbox_request");
		(await SandboxRuntime.for(workspace)).grantPath("write", outside, "session");
		expect(await denial(write, { path: path.join(outside, "a.txt") }, "write")).toBeUndefined();
		cfgSandboxMode.set(settings, "read-only");
		const readOnly = await denial(write, { path: "notes.md" }, "write");
		expect(readOnly).toContain("writable roots");
		// Only the user can switch modes: the refusal names no request that would be refused.
		expect(readOnly).toContain("read-only mode");
		expect(readOnly).not.toContain("sandbox_request");
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

	it("ast_edit is checked where its globs rewrite, on every root of a delimited paths entry", async () => {
		const astEdit = new AstEditTool({ cwd: workspace, settings } as unknown as ToolSession) as unknown as AgentTool;
		const args = (paths: string[]) => ({ ops: [{ pat: "a", out: "b" }], paths });
		expect(await denial(astEdit, args(["src,lib/**/*.ts"]), "write")).toBeUndefined();
		expect(await denial(astEdit, args([`${outside}/**/*.ts`]), "write")).toContain("writable roots");
		for (const delimiter of [",", ";"]) {
			const refused = await denial(astEdit, args([`src${delimiter}${outside}/**/*.ts`]), "write");
			expect(refused).toContain("writable roots");
		}
	});

	it("ast_edit does not split an absolute path whose workspace directory contains a space", async () => {
		workspace = path.join(path.dirname(workspace), "my project");
		fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
		const astEdit = new AstEditTool({ cwd: workspace, settings } as unknown as ToolSession) as unknown as AgentTool;
		const paths = [`${workspace}/src/**/*.ts`];
		expect(await denial(astEdit, { ops: [{ pat: "a", out: "b" }], paths }, "write")).toBeUndefined();
	});

	it("tts is checked where it saves the audio", async () => {
		const tts = createTtsTool({ cwd: workspace }) as unknown as AgentTool;
		expect(await denial(tts, { text: "hi", output_path: "speech.mp3" }, "write")).toBeUndefined();
		expect(await denial(tts, { text: "hi", output_path: path.join(outside, "speech.mp3") }, "write")).toContain(
			"writable roots",
		);
		// A directory `output_path` saves `<dir>.wav` beside it: here, outside the workspace.
		expect(await denial(tts, { text: "hi", output_path: "." }, "write")).toContain("writable roots");
	});

	it("an LSP workspace edit outside the writable roots changes nothing", async () => {
		runtimes.push(await SandboxRuntime.for(workspace));
		const target = path.join(outside, "renamed.ts");
		const edit = { documentChanges: [{ kind: "create" as const, uri: Bun.pathToFileURL(target).href }] };
		await expect(applyWorkspaceEditWithLsp(edit, workspace)).rejects.toThrow("writable roots");
		expect(fs.existsSync(target)).toBe(false);
	});

	it("refuses a write to a protected project path that does not exist yet, naming the path to request", async () => {
		const write = pathTool("write", "write");
		const refused = await denial(write, { path: ".omp/extensions/x.ts" }, "write");
		expect(refused).toContain(`target \`${path.join(workspace, ".omp")}\``);
		expect(fs.existsSync(path.join(workspace, ".omp"))).toBe(false);
		expect(await denial(write, { path: "omp-notes/x.ts" }, "write")).toBeUndefined();
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

	it("refuses a prelude call whose declared subject is outside the policy before it runs", async () => {
		runtimes.push(await SandboxRuntime.for(workspace));
		const invoke = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));
		const definition = {
			name: "computer",
			documentation: "",
			javascript: "",
			python: "",
			exports: [],
			approval: "read" as const,
			sandboxSubjects: () => [{ kind: "exec" as const, target: "computer" }],
			invoke,
		};
		const session = {
			cwd: workspace,
			settings,
			getEvalPreludes: () => [definition],
			isToolActive: (name: string) => name === "sandbox_request",
		} as unknown as ToolSession;
		await expect(invokeEvalPrelude("computer", {}, { session, toolCallId: "p1" })).rejects.toThrow(
			"kind `exec`, target `computer`",
		);
		expect(invoke).not.toHaveBeenCalled();
	});

	it("refuses a debug launch naming the program's real path until that exact exec target is granted", async () => {
		runtimes.push(await SandboxRuntime.for(workspace));
		fs.writeFileSync(path.join(workspace, "prog"), "");
		fs.symlinkSync("prog", path.join(workspace, "alias"));
		const target = `debug:launch ${path.join(workspace, "prog")}`;
		const session = SessionManager.inMemory(workspace);
		const runner = new ExtensionRunner([], new ExtensionRuntime(), agentDir, session, modelRegistry);
		const wrapper = new ExtensionToolWrapper(
			new DebugTool({ cwd: workspace, settings } as unknown as ToolSession) as unknown as AgentTool,
			runner,
		);
		const context = { sessionManager: session, modelRegistry, settings } as unknown as AgentToolContext;
		// An unknown adapter fails inside the handler, before any adapter is spawned.
		const launch = () =>
			wrapper.execute(
				"d1",
				{ action: "launch", program: "alias", adapter: "none-such" },
				undefined,
				undefined,
				context,
			);

		await expect(launch()).rejects.toThrow(`\`exec\` access to \`${target}\``);
		grantExecIn(target);
		await expect(launch()).rejects.toThrow("No debugger adapter available");
	});
});

describe("debug sandbox subjects", () => {
	const subjects = (args: object) =>
		new DebugTool({ cwd: workspace, settings } as unknown as ToolSession).sandboxSubjects(args);

	it("resolves the program against the call's cwd, keeps the lexical path while it is missing, and names every attach field", () => {
		fs.mkdirSync(path.join(workspace, "sub"));
		fs.writeFileSync(path.join(workspace, "sub", "prog"), "");
		expect(subjects({ action: "launch", program: "prog", cwd: "sub" })).toEqual([
			{ kind: "exec", target: `debug:launch ${path.join(workspace, "sub", "prog")}` },
		]);
		expect(subjects({ action: "launch", program: "missing" })).toEqual([
			{ kind: "exec", target: `debug:launch ${path.join(workspace, "missing")}` },
		]);
		// Every field the call sends is part of the target: a grant for a pid alone does not cover a pid+port attach.
		expect(subjects({ action: "attach", adapter: "dlv", pid: 42, host: "box", port: 9 })).toEqual([
			{ kind: "exec", target: "debug:attach adapter dlv pid 42 box:9" },
		]);
		// A host without a port still shows.
		expect(subjects({ action: "attach", pid: 42, host: "10.0.0.5" })).toEqual([
			{ kind: "exec", target: "debug:attach pid 42 host 10.0.0.5" },
		]);
	});
});
