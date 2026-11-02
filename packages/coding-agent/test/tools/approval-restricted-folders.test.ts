/**
 * `tools.restrictedFolders` — folders where every action needs an explicit approval, whatever the
 * approval mode, a remembered grant, or a session approval.
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
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type ApprovalRestrictions,
	resolveApproval,
	sessionApprovalScope,
} from "@oh-my-pi/pi-coding-agent/tools/approval";
import {
	approvalDirectoryKey,
	approvalGrantKey,
	getApprovalGrants,
} from "@oh-my-pi/pi-coding-agent/tools/approval-cache";
import { approvalTargetKey, approvalTreeSearchKey } from "@oh-my-pi/pi-coding-agent/tools/approval-targets";
import { getAgentDir, isRecord, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

/** Tool whose targets come from `args.path`, like read/write/edit. */
function pathTool(name: string, tier: ToolTier, cwd: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: {} as never,
		approval: tier,
		approvalCacheTargets: (args: unknown) =>
			isRecord(args) && typeof args.path === "string" ? [approvalTargetKey(cwd, args.path)!] : undefined,
		execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
	};
}

/** Exec tool that names no path, like bash: matched by the directory it runs in. */
const bash: AgentTool = {
	name: "bash",
	label: "Bash",
	description: "command tool",
	parameters: {} as never,
	approval: "exec",
	execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
};

let temp: TempDir;
let cwd: string;
let restricted: string;

beforeEach(() => {
	temp = TempDir.createSync("@omp-restricted-folders-");
	cwd = temp.path();
	restricted = path.join(cwd, "restricted");
	fs.mkdirSync(path.join(restricted, "nested"), { recursive: true });
	fs.mkdirSync(path.join(cwd, "plain"));
	fs.writeFileSync(path.join(restricted, "secret.txt"), "secret\n");
});
afterEach(() => temp.removeSync());

const restrictions = (): ApprovalRestrictions => ({ restrictedFolders: [restricted], cwd });

describe("restricted folder resolution", () => {
	it("prompts for a restricted target even in yolo, with a per-call reason", () => {
		const read = pathTool("read", "read", cwd);
		const resolved = resolveApproval(read, { path: "restricted/secret.txt" }, "yolo", {}, undefined, restrictions());
		expect(resolved).toMatchObject({ policy: "prompt", source: "restriction", override: true });
		expect(resolved.reason).toStartWith("Restricted folder: ");
		// Neither a session approval nor a remembered grant can be offered for it.
		expect(sessionApprovalScope(resolved, "read")).toBeUndefined();
		// The folder itself is restricted, not only what it holds.
		expect(resolveApproval(read, { path: "restricted" }, "yolo", {}, undefined, restrictions()).policy).toBe(
			"prompt",
		);
	});

	it("is not silenced by remembered grants or a user allow policy", () => {
		const read = pathTool("read", "read", cwd);
		const args = { path: "restricted/secret.txt" };
		const grants = getApprovalGrants(path.join(cwd, "agent"), "s1");
		grants.record(approvalGrantKey("read", approvalTargetKey(cwd, args.path)!), "read", "session");
		grants.record(approvalGrantKey("exec", approvalDirectoryKey(restricted)), "read", "session");
		// Without the restriction the grants allow the call; with it they do not.
		expect(resolveApproval(read, args, "always-ask-cached", {}, grants).policy).toBe("allow");
		expect(resolveApproval(read, args, "always-ask-cached", {}, grants, restrictions()).policy).toBe("prompt");
		expect(resolveApproval(read, args, "yolo", { read: "allow" }, undefined, restrictions()).policy).toBe("prompt");
	});

	it("keeps a deny policy denied", () => {
		const read = pathTool("read", "read", cwd);
		expect(
			resolveApproval(read, { path: "restricted/secret.txt" }, "yolo", { read: "deny" }, undefined, restrictions()),
		).toMatchObject({ policy: "deny", source: "user" });
	});

	it("never restricts a sibling that only shares the folder's name prefix", () => {
		const read = pathTool("read", "read", cwd);
		fs.mkdirSync(path.join(cwd, "restricted-other"));
		expect(
			resolveApproval(read, { path: "restricted-other/file.txt" }, "yolo", {}, undefined, restrictions()).policy,
		).toBe("allow");
		expect(resolveApproval(read, { path: "plain/open.txt" }, "yolo", {}, undefined, restrictions()).policy).toBe(
			"allow",
		);
	});

	it("matches a tool that names no path by its working directory or its cwd argument", () => {
		const inside: ApprovalRestrictions = { restrictedFolders: [restricted], cwd: path.join(restricted, "nested") };
		expect(resolveApproval(bash, {}, "yolo", {}, undefined, inside)).toMatchObject({
			policy: "prompt",
			source: "restriction",
		});
		expect(resolveApproval(bash, {}, "yolo", {}, undefined, restrictions()).policy).toBe("allow");
		// A command run from outside, pointed into the folder by its own `cwd`, asks too.
		expect(resolveApproval(bash, { cwd: "restricted" }, "yolo", {}, undefined, restrictions()).policy).toBe("prompt");
	});

	it("prompts for a recursive search rooted above a restricted folder, not a one-level listing", () => {
		const search = (key: string): AgentTool => ({
			...bash,
			name: "grep",
			approval: "read",
			approvalCacheTargets: () => [key],
		});
		expect(
			resolveApproval(
				search(approvalTreeSearchKey(approvalDirectoryKey(cwd))),
				{},
				"yolo",
				{},
				undefined,
				restrictions(),
			).policy,
		).toBe("prompt");
		expect(resolveApproval(search(approvalDirectoryKey(cwd)), {}, "yolo", {}, undefined, restrictions()).policy).toBe(
			"allow",
		);
	});

	it("names a folder through ~, a symlink, or (on Windows) different case", () => {
		const read = pathTool("read", "read", cwd);
		const home = path.join(os.homedir(), ".omp-restricted-probe", "file.txt");
		const probe: AgentTool = { ...read, approvalCacheTargets: () => [approvalTargetKey(cwd, home)!] };
		expect(
			resolveApproval(probe, {}, "yolo", {}, undefined, { restrictedFolders: ["~/.omp-restricted-probe"], cwd })
				.policy,
		).toBe("prompt");

		if (process.platform === "win32") {
			const upper = { restrictedFolders: [restricted.toUpperCase()], cwd };
			expect(resolveApproval(read, { path: "restricted/secret.txt" }, "yolo", {}, undefined, upper).policy).toBe(
				"prompt",
			);
		}

		const link = path.join(cwd, "link");
		try {
			fs.symlinkSync(restricted, link, "junction");
		} catch {
			return; // Symlinks unavailable on this host.
		}
		expect(resolveApproval(read, { path: "link/secret.txt" }, "yolo", {}, undefined, restrictions()).policy).toBe(
			"prompt",
		);
	});
});

describe("restricted folder wrapper gate", () => {
	let root: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let originalAgentDir: string;

	beforeAll(async () => {
		root = TempDir.createSync("@omp-restricted-wrapper-");
		authStorage = await AuthStorage.create(path.join(root.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});
	afterAll(() => {
		authStorage.close();
		root.removeSync();
	});
	beforeEach(() => {
		originalAgentDir = getAgentDir();
		setAgentDir(path.join(cwd, "agent"));
	});
	afterEach(() => setAgentDir(originalAgentDir));

	function runnerWith(sessionManager: SessionManager, select: ExtensionUIContext["select"]): ExtensionRunner {
		const runner = new ExtensionRunner([], new ExtensionRuntime(), getAgentDir(), sessionManager, modelRegistry);
		runner.initialize(
			{} as Parameters<ExtensionRunner["initialize"]>[0],
			{} as Parameters<ExtensionRunner["initialize"]>[1],
			undefined,
			{ select } as unknown as ExtensionUIContext,
		);
		return runner;
	}

	it("asks with only Approve/Deny on every call in yolo mode", async () => {
		const session = SessionManager.inMemory(cwd);
		const select = vi.fn(async () => "Approve");
		const wrapper = new ExtensionToolWrapper(pathTool("read", "read", cwd), runnerWith(session, select));
		const context = {
			sessionManager: session,
			modelRegistry,
			settings: Settings.isolated({ "tools.approvalMode": "yolo", "tools.restrictedFolders": [restricted] }),
		} as unknown as AgentToolContext;

		await wrapper.execute("r1", { path: "restricted/secret.txt" }, undefined, undefined, context);
		await wrapper.execute("r2", { path: "restricted/secret.txt" }, undefined, undefined, context);
		await wrapper.execute("r3", { path: "plain/open.txt" }, undefined, undefined, context);

		expect(select).toHaveBeenCalledTimes(2);
		const [title, options] = select.mock.calls[0]! as unknown as [string, string[]];
		expect(title).toContain("Reason: Restricted folder: ");
		expect(options).toEqual(["Approve", "Deny"]);
	});
});
