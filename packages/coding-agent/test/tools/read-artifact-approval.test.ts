import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { approvalGrantKey, SessionApprovals } from "@oh-my-pi/pi-coding-agent/tools/approval-cache";
import { approvalTargetKey } from "@oh-my-pi/pi-coding-agent/tools/approval-targets";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.flatMap(block => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");
}

describe("artifact reads through session approval", () => {
	let root: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-artifact-approval-"));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		await fs.rm(root, { recursive: true, force: true });
	});

	it.each([
		["main", 0],
		["subagent", 1],
	] as const)(
		"%s sessions can follow bash's raw artifact hint with restricted folders configured",
		async (_kind, taskDepth) => {
			const cwd = path.join(root, "cwd");
			await fs.mkdir(cwd);
			const created = await createAgentSession({
				cwd,
				agentDir: path.join(root, "agent"),
				sessionManager: SessionManager.create(cwd, path.join(root, "sessions")),
				settings: Settings.isolated({
					"tools.approvalMode": "yolo",
					"tools.restrictedFolders": [path.join(root, "restricted")],
					"async.enabled": false,
					"bash.autoBackground.enabled": false,
					"bashInterceptor.enabled": false,
				}),
				model: getBundledModel("openai", "gpt-4o-mini"),
				bindProcessState: false,
				taskDepth,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				workspaceTree: { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: ["bash", "read"],
			});
			session = created.session;
			const bash = session.getToolByName("bash");
			const read = session.getToolByName("read");
			if (!bash || !read) throw new Error("Expected bash and read tools");

			const produced = await bash.execute("produce", {
				command: "printf 'artifact-start-'; printf '%010000d' 0; printf -- '-artifact-end'",
			});
			const hint = /Use (artifact:\/\/\S+:raw:1-1) to read/.exec(textOf(produced))?.[1];
			expect(hint).toBeDefined();
			if (!hint) throw new Error("Expected a raw artifact recovery hint");

			const recovered = await read.execute("recover", { path: hint });
			expect(textOf(recovered)).toBe(`artifact-start-${"0".repeat(10_000)}-artifact-end`);
		},
	);

	function readTool(): ReadTool {
		return new ReadTool({
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		});
	}

	it("reuses an artifact grant across selectors without granting another artifact", () => {
		const read = readTool();
		const grants = new SessionApprovals();
		const approve = (target: string) =>
			resolveApproval(read, { path: target }, "always-ask-cached", {}, grants).policy;

		expect(approve("artifact://54:raw:4-4")).toBe("prompt");
		grants.record(approvalGrantKey("read", "artifact://54"));
		expect(approve("artifact://54:raw:4-4")).toBe("allow");
		expect(approve("artifact://54:5-10")).toBe("allow");
		expect(approve("artifact://55:raw:4-4")).toBe("prompt");
	});

	it("preserves the SSH authority port when checking a selected read's grant", () => {
		const read = readTool();
		const grants = new SessionApprovals();
		grants.record(approvalGrantKey("exec", "ssh://example.test:2222/log.txt"));

		expect(
			resolveApproval(read, { path: "ssh://example.test:2222/log.txt:raw:4-4" }, "always-ask-cached", {}, grants),
		).toMatchObject({ policy: "allow", tier: "exec" });
		expect(
			resolveApproval(read, { path: "ssh://example.test:2223/log.txt:raw:4-4" }, "always-ask-cached", {}, grants),
		).toMatchObject({ policy: "prompt", tier: "exec" });
	});

	it.skipIf(process.platform === "win32")(
		"keeps literal colon filenames separate from a base file's grant",
		async () => {
			await Bun.write(path.join(root, "notes.txt"), "base content");
			await Bun.write(path.join(root, "notes.txt:1"), "literal content");
			const read = readTool();
			const grants = new SessionApprovals();
			grants.record(approvalGrantKey("read", approvalTargetKey(root, "notes.txt")!));

			expect(resolveApproval(read, { path: "notes.txt:1" }, "always-ask-cached", {}, grants).policy).toBe("prompt");
			grants.record(approvalGrantKey("read", approvalTargetKey(root, "notes.txt:1")!));
			expect(resolveApproval(read, { path: "notes.txt:1" }, "always-ask-cached", {}, grants).policy).toBe("allow");
			expect(textOf(await read.execute("literal", { path: "notes.txt:1" }))).toContain("literal content");
		},
	);
});
