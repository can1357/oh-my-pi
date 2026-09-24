import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
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
		expect(result.content.map(part => (part.type === "text" ? part.text : "")).join("\n")).toContain(
			"Path traversal (..) is not allowed in local:// URLs",
		);
		expect(await Bun.file(victim).text()).toBe("old\n");
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
