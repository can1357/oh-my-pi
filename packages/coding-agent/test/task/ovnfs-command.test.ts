import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { ovnfsCommand } from "@oh-my-pi/pi-coding-agent/task/settings";
import { $ } from "bun";

describe("ovnfsCommand", () => {
	// Bash strips backslashes: `C:\Users\…\ovnfs.exe` pasted into a command runs as `C:Users…ovnfs.exe`.
	it.skipIf(process.platform !== "win32")("returns a Windows ovnfs.path with forward slashes", () => {
		const configured = process.execPath.replaceAll("/", "\\");
		const command = ovnfsCommand(Settings.isolated({ "ovnfs.path": configured }));
		expect(command).toBe(configured.replaceAll("\\", "/"));
	});

	// The checkout guidance is pasted into bash: spaces, `$` and quotes must not split or expand the path.
	it("renders checkout guidance whose command parses back to the configured path", async () => {
		const ovnfs = "C:/Program Files/$HOME/it's/ovnfs.exe";
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "ovnfs-guidance-"));
		try {
			const prompt = await buildSystemPrompt({ cwd: project, contextFiles: [], rules: [], toolNames: ["bash"], ovnfs });
			const text = prompt.systemPrompt.join("\n");
			const line = text.split("\n").find(row => row.includes(" new --name <name>"));
			const pasted = line?.match(/`cd <folder> && (.+) new --name <name>`/)?.[1];
			expect(pasted).toBeDefined();
			// Script on stdin: a Windows command line would re-quote an argv script before bash sees it.
			const script = new Response(`printf %s ${pasted}`);
			const parsed = await $`bash -s < ${script}`.quiet().text();
			expect(parsed).toBe(ovnfs);
		} finally {
			await fs.rm(project, { recursive: true, force: true });
		}
	});
});
