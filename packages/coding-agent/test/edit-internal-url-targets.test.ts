import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type EditMode, EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { ProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let tmpDir: string;
let artifactsDir: string;

function createSession(): ToolSession {
	const getArtifactsDir = () => artifactsDir;
	const getSessionId = () => "session-a";
	return {
		cwd: tmpDir,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => path.join(tmpDir, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir,
		getSessionId,
		localProtocolOptions: { getArtifactsDir, getSessionId },
		settings: Settings.isolated({ "edit.enforceSeenLines": false }),
	} as ToolSession;
}

function localFile(url: string): string {
	return resolveLocalUrlToPath(url, { getArtifactsDir: () => artifactsDir, getSessionId: () => "session-a" });
}

beforeEach(async () => {
	resetSettingsForTest();
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-edit-urls-"));
	artifactsDir = path.join(tmpDir, "artifacts");
	await Settings.init({ inMemory: true, cwd: tmpDir });
});

afterEach(async () => {
	resetSettingsForTest();
	await removeWithRetries(tmpDir);
});

describe("EditTool internal URL targets", () => {
	it("edits the single-slash local:/ spelling in the sandbox its read-tier approval describes", async () => {
		const target = localFile("local://notes.md");
		await Bun.write(target, "old\n");
		const tool = new EditTool(createSession(), "replace");
		const args = { path: "local:/notes.md", old_string: "old", new_string: "new" };

		expect(tool.approval(args)).toBe("read");
		const result = await tool.execute("single-slash", args);

		expect(result.isError).not.toBe(true);
		expect(await Bun.file(target).text()).toBe("new\n");
		expect(await fs.exists(path.join(tmpDir, "local:"))).toBe(false);
	});

	it("refuses local:/../ traversal instead of editing the working tree", async () => {
		const victim = path.join(tmpDir, "victim.txt");
		await Bun.write(victim, "old\n");

		const result = await new EditTool(createSession(), "replace").execute("traversal", {
			path: "local:/../victim.txt",
			old_string: "old",
			new_string: "pwned",
		});

		expect(result.isError).toBe(true);
		expect(await Bun.file(victim).text()).toBe("old\n");
	});

	it("refuses a URL target carrying a line selector instead of editing the whole file", async () => {
		const target = localFile("local://notes.md");
		await Bun.write(target, "one\ntwo\n");

		const result = await new EditTool(createSession(), "replace").execute("selector", {
			path: "local://notes.md:2",
			old_string: "two",
			new_string: "TWO",
		});

		expect(result.isError).toBe(true);
		expect(await Bun.file(target).text()).toBe("one\ntwo\n");
	});

	it("refuses URI-shaped targets write refuses instead of editing a working-tree path", async () => {
		// Same shape as vault://: a file-written scheme without the single-slash alias.
		const backing = path.join(tmpDir, "demo-root", "n.md");
		await Bun.write(backing, "old\n");
		const handler: ProtocolHandler = {
			scheme: "demo",
			spec: {
				backing: "file",
				selectors: "lines",
				immutable: false,
				write: { via: "file", payload: "text", scope: "workspace", tier: () => "write" },
			},
			resolve: async url => ({ url: url.href, content: await Bun.file(backing).text(), contentType: "text/plain" }),
			locate: async url => path.join(tmpDir, "demo-root", url.rawHost),
		};
		const router = InternalUrlRouter.instance();
		router.register(handler);
		try {
			const tool = new EditTool(createSession(), "apply_patch");
			for (const target of ["demo:/n.md", "bogus://n.md"]) {
				const result = await tool.execute(target, {
					input: `*** Begin Patch\n*** Add File: ${target}\n+pwned\n*** End Patch`,
				});
				expect(result.isError).toBe(true);
			}
			const replaced = await new EditTool(createSession(), "replace").execute("demo-replace", {
				path: "demo:/n.md",
				old_string: "old",
				new_string: "pwned",
			});
			expect(replaced.isError).toBe(true);
		} finally {
			router.unregister("demo");
		}

		expect(await Bun.file(backing).text()).toBe("old\n");
		expect(await fs.exists(path.join(tmpDir, "demo:"))).toBe(false);
		expect(await fs.exists(path.join(tmpDir, "bogus:"))).toBe(false);
	});

	it("re-resolves streamed URL targets at execute instead of reusing the preview's answer", async () => {
		const previewed = localFile("local://plan.md");
		await Bun.write(previewed, "one\n");
		const tool = new EditTool(createSession(), "replace");
		const args = { path: "local://plan.md", old_string: "one", new_string: "two" };
		const finalPreview = Promise.withResolvers<{ diff?: string; error?: string } | undefined>();
		const stream = tool.openArgStream({
			toolCallId: "streamed",
			toolName: "edit",
			emit: update => {
				if (update && typeof update === "object" && "streaming" in update && update.streaming === false) {
					const files = "files" in update && Array.isArray(update.files) ? update.files : [];
					finalPreview.resolve(files[0]);
				}
			},
		});
		const encoded = JSON.stringify(args);
		for (let offset = 0; offset < encoded.length; offset += 7) stream.push(encoded.slice(offset, offset + 7));
		stream.end(args);
		expect((await finalPreview.promise)?.diff).toContain("+1|two");

		// The session's local:// root moves between the preview and execution.
		artifactsDir = path.join(tmpDir, "moved-artifacts");
		const current = localFile("local://plan.md");
		await Bun.write(current, "one\n");
		const result = await tool.execute("streamed", args);

		expect(result.isError).not.toBe(true);
		expect(await Bun.file(current).text()).toBe("two\n");
		expect(await Bun.file(previewed).text()).toBe("one\n");
	});
});

describe("EditTool approval of moves out of the local:// sandbox", () => {
	const moves: Array<{ mode: EditMode; args: (to: string) => Record<string, unknown> }> = [
		{
			mode: "apply_patch",
			args: (to: string) => ({
				input: `*** Begin Patch\n*** Update File: local://a.md\n*** Move to: ${to}\n@@\n-one\n+pwned\n*** End Patch`,
			}),
		},
		{ mode: "hashline", args: (to: string) => ({ input: `[local://a.md#AB12]\nMV ${to}` }) },
		{
			mode: "patch",
			args: (to: string) => ({
				path: "local://a.md",
				edits: [{ op: "update", rename: to, diff: "@@\n-one\n+pwned" }],
			}),
		},
	];

	for (const { mode, args } of moves) {
		it(`${mode}: a working-tree destination raises the tier to write and is shown`, () => {
			const tool = new EditTool(createSession(), mode);

			expect(tool.approval(args("local://b.md"))).toBe("read");
			expect(tool.approval(args("bunfig.toml"))).toBe("write");
			expect(tool.formatApprovalDetails(args("bunfig.toml")).join("\n")).toContain("bunfig.toml");
		});
	}
});
