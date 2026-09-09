import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

// Exercises the real per-tool approval gate (ExtensionToolWrapper) for read/grep/write,
// proving an `ssh://` target is exec-tier (prompts / is denied without a UI) while the
// equivalent local-path call runs. ssh:// calls are rejected at the approval gate before any
// connection, so this suite needs no live ssh.
const BASE_SETTINGS = {
	"async.enabled": false,
	"bash.autoBackground.enabled": false,
	"bashInterceptor.enabled": false,
} as const;

const APPROVAL_RE = /requires approval but no interactive UI available/;

describe("ssh:// tools are exec-gated through the production approval wrapper", () => {
	let tempDir: string;
	let session: AgentSession;

	beforeAll(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-ssh-approval-${Snowflake.next()}-`));
		const cwd = path.join(tempDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		fs.writeFileSync(path.join(cwd, "local.txt"), "hello-local\n");
		const sessionManager = SessionManager.create(cwd, path.join(tempDir, "sessions"));
		const created = await createAgentSession({
			cwd,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated(BASE_SETTINGS),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "grep", "write"],
		});
		session = created.session;
	});

	afterAll(async () => {
		await session.dispose();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup; the OS reclaims the temp dir
		}
	});

	function tool(name: "read" | "grep" | "write") {
		const found = session.getToolByName(name);
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
		// The wrapper sees `paths` verbatim (pre-expansion), so the substring scan must trip exec here.
		await expect(
			tool("grep").execute(
				"s-ssh",
				{ pattern: "x", paths: "local.txt,ssh://localhost/etc/hosts" },
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
});
