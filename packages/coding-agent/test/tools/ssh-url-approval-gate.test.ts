import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

// Exercises the real per-tool approval gate (ExtensionToolWrapper) for read/grep/glob/write/edit,
// proving an `ssh://` target is exec-tier (prompts / is denied without a UI) while the
// equivalent local-path call runs. ssh:// calls are rejected at the approval gate before any
// connection, so this suite needs no live ssh.
const BASE_SETTINGS = {
	"async.enabled": false,
	"bash.autoBackground.enabled": false,
	"bashInterceptor.enabled": false,
	"edit.mode": "replace",
} as const;

const APPROVAL_RE = /requires approval but no interactive UI available/;

describe("ssh:// tools are exec-gated through the production approval wrapper", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let tools: Tool[];

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-ssh-approval-");
		const cwd = path.join(tempDir.path(), "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		fs.writeFileSync(path.join(cwd, "local.txt"), "hello-local\n");
		const settings = Settings.isolated(BASE_SETTINGS);
		const session: ToolSession = {
			cwd,
			settings,
			hasUI: false,
			enableLsp: false,
			restrictToolNames: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		};
		authStorage = createInMemoryAuthStorage();
		const runner = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			cwd,
			SessionManager.inMemory(cwd),
			new ModelRegistry(authStorage),
			undefined,
			settings,
		);
		// Adding edit made the full SDK setup exceed Bun's default five-second
		// deadline, including with unchanged main implementation. Keep the real
		// tool factory and approval wrapper while avoiding unrelated SDK startup.
		tools = (await createTools(session, ["read", "grep", "glob", "write", "edit"])).map(
			tool => new ExtensionToolWrapper(tool, runner),
		);
	});

	afterAll(() => {
		authStorage?.close();
		tempDir?.removeSync();
	});

	function tool(name: "read" | "grep" | "glob" | "write" | "edit") {
		const found = tools.find(tool => tool.name === name);
		if (!found) throw new Error(`Expected ${name} tool`);
		return found;
	}

	function ctx(approvalMode: "always-ask" | "write"): AgentToolContext {
		return {
			settings: Settings.isolated({ ...BASE_SETTINGS, "tools.approvalMode": approvalMode }),
		} as AgentToolContext;
	}

	it("read: ssh:// requires approval (exec), a local path runs (read)", async () => {
		await expect(
			tool("read").execute(
				"r-ssh",
				{ path: "ssh://localhost/etc/hostname" },
				undefined,
				undefined,
				ctx("always-ask"),
			),
		).rejects.toThrow(APPROVAL_RE);
		const ok = await tool("read").execute("r-local", { path: "local.txt" }, undefined, undefined, ctx("always-ask"));
		expect(JSON.stringify(ok.content)).toContain("hello-local");
	});

	it("grep: a delimited ssh:// entry requires approval before path expansion", async () => {
		// The wrapper sees `path` verbatim (pre-expansion), so the substring scan must trip exec here.
		await expect(
			tool("grep").execute(
				"s-ssh",
				{ pattern: "x", path: "local.txt,ssh://localhost/etc/hosts" },
				undefined,
				undefined,
				ctx("always-ask"),
			),
		).rejects.toThrow(APPROVAL_RE);
		const ok = await tool("grep").execute(
			"s-local",
			{ pattern: "hello", path: "." },
			undefined,
			undefined,
			ctx("always-ask"),
		);
		expect(ok).toBeDefined();
	});

	it("glob: an ssh:// path requires approval (exec), a local glob runs (read)", async () => {
		await expect(
			tool("glob").execute("g-ssh", { path: "ssh://localhost/etc" }, undefined, undefined, ctx("always-ask")),
		).rejects.toThrow(APPROVAL_RE);
		const ok = await tool("glob").execute("g-local", { path: "*.txt" }, undefined, undefined, ctx("always-ask"));
		expect(JSON.stringify(ok.content)).toContain("local.txt");
	});

	it("write: ssh:// requires approval (exec), a local write runs (write tier, write mode)", async () => {
		await expect(
			tool("write").execute(
				"w-ssh",
				{ path: "ssh://localhost/tmp/x", content: "x" },
				undefined,
				undefined,
				ctx("write"),
			),
		).rejects.toThrow(APPROVAL_RE);
		const ok = await tool("write").execute(
			"w-local",
			{ path: "out.txt", content: "data\n" },
			undefined,
			undefined,
			ctx("write"),
		);
		expect(JSON.stringify(ok.content)).toContain("out.txt");
	});

	it("edit: ssh:// requires exec approval while a local edit runs in write mode", async () => {
		await expect(
			tool("edit").execute(
				"e-ssh",
				{ path: "ssh://localhost/tmp/x", old_string: "old", new_string: "new" },
				undefined,
				undefined,
				ctx("write"),
			),
		).rejects.toThrow(APPROVAL_RE);
		const ok = await tool("edit").execute(
			"e-local",
			{ path: "local.txt", old_string: "hello-local", new_string: "edited-local" },
			undefined,
			undefined,
			ctx("write"),
		);
		expect(ok.isError).not.toBe(true);
		expect(await Bun.file(path.join(tempDir.path(), "cwd", "local.txt")).text()).toBe("edited-local\n");
	});
});
