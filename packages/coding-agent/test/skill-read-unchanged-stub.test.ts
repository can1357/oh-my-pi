import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-reread-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function textOutput(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map(block => block.text)
		.join("");
}

function pushReadResult(
	messages: AgentMessage[],
	toolCallId: string,
	result: { content: ToolResultMessage<ReadToolDetails>["content"]; details?: ReadToolDetails; isError?: boolean },
): void {
	messages.push({
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: result.content,
		details: result.details,
		isError: result.isError === true,
		timestamp: Date.UTC(2026, 8, 25, 8, 30),
	});
}

function makeSession(cwd: string, skill: Skill, messages: AgentMessage[]): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated(),
		skills: [skill],
		messages,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};
}

describe("skill:// repeated reads", () => {
	it("stubs byte-identical full reads that are still in current context", async () => {
		const tempDir = await makeTempDir();
		const skillDir = path.join(tempDir, "skills", "demo");
		const skillFile = path.join(skillDir, "SKILL.md");
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(skillFile, "---\nname: demo\ndescription: Demo\n---\nFirst body\n");
		await fs.writeFile(path.join(skillDir, "ref.md"), "Reference body\n");
		const skill: Skill = {
			name: "demo",
			description: "Demo",
			filePath: skillFile,
			baseDir: skillDir,
			source: "user",
		};
		const messages: AgentMessage[] = [];
		const read = new ReadTool(makeSession(tempDir, skill, messages));

		const first = await read.execute("read-skill-1", { path: "skill://demo" });
		expect(textOutput(first)).toContain("First body");
		expect(first.details?.skillRead?.full).toBe(true);
		pushReadResult(messages, "read-skill-1", first);

		const second = await read.execute("read-skill-2", { path: "skill://demo/SKILL.md" });
		expect(textOutput(second)).toMatch(
			/^skill:\/\/demo\/SKILL\.md unchanged since your read at \d\d:\d\d \(still in context above\); read skill:\/\/demo\/SKILL\.md\?full to get it again$/,
		);
		expect(textOutput(second)).not.toContain("First body");

		const referenceFirst = await read.execute("read-skill-reference-1", { path: "skill://demo/ref.md" });
		expect(textOutput(referenceFirst)).toContain("Reference body");
		pushReadResult(messages, "read-skill-reference-1", referenceFirst);
		const referenceSecond = await read.execute("read-skill-reference-2", { path: "skill://demo/ref.md" });
		expect(textOutput(referenceSecond)).toContain("Reference body");

		const forced = await read.execute("read-skill-full", { path: "skill://demo/SKILL.md?full" });
		expect(textOutput(forced)).toContain("First body");

		const compactedRead = new ReadTool(makeSession(tempDir, skill, []));
		const afterCompaction = await compactedRead.execute("read-skill-after-compaction", { path: "skill://demo" });
		expect(textOutput(afterCompaction)).toContain("First body");

		await fs.writeFile(skillFile, "---\nname: demo\ndescription: Demo\n---\nChanged body\n");
		const changed = await read.execute("read-skill-changed", { path: "skill://demo" });
		expect(textOutput(changed)).toContain("Changed body");
	});
});
