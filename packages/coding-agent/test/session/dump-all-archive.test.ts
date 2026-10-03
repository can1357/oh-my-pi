/**
 * Contract: `/dump all` writes a zip holding the main `/dump` transcript and one
 * separate `subagents/<path>.md` per persisted subagent (nested paths kept,
 * empty transcripts skipped) instead of concatenating them into one document.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { readArchiveEntries } from "@oh-my-pi/pi-utils/ar";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

function subagentJsonl(id: string, userText: string | null): string {
	const lines = [
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-01T00:00:00.000Z", cwd: "/tmp" }),
	];
	if (userText !== null) {
		lines.push(
			JSON.stringify({
				type: "model_change",
				id: `${id}-m`,
				parentId: null,
				timestamp: "2026-10-01T00:00:01.000Z",
				model: "anthropic/claude-x",
			}),
			JSON.stringify({
				type: "message",
				id: `${id}-u`,
				parentId: `${id}-m`,
				timestamp: "2026-10-01T00:00:02.000Z",
				message: { role: "user", content: userText, timestamp: 2 },
			}),
		);
	}
	return `${lines.join("\n")}\n`;
}

describe("AgentSession.dumpSessionArchiveToTmpDir", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const archives: string[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-dump-all-");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model");
		const authStorage = createInMemoryAuthStorage();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [{ role: "user", content: "main prompt", timestamp: 1 }],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			advisorTools: [],
		});
	});

	afterEach(async () => {
		await session.dispose();
		for (const archive of archives.splice(0)) await fs.rm(archive, { force: true });
		await tempDir.remove();
	});

	it("archives the main dump and each subagent as its own file", async () => {
		const sessionFile = session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const subDir = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(subDir, "Scout.jsonl"), subagentJsonl("scout", "scout task"));
		await Bun.write(path.join(subDir, "Scout", "Helper.jsonl"), subagentJsonl("helper", "helper task"));
		await Bun.write(path.join(subDir, "Idle.jsonl"), subagentJsonl("idle", null));

		const archive = await session.dumpSessionArchiveToTmpDir();
		if (!archive) throw new Error("Expected an archive");
		archives.push(archive.path);

		expect(archive.files).toEqual([
			"session.md",
			"llm-request.json",
			"subagents/Scout.md",
			"subagents/Scout/Helper.md",
		]);
		expect(archive.subagentCount).toBe(2);
		const entries = await readArchiveEntries({ bytes: await Bun.file(archive.path).bytes(), format: "zip" });
		const text = (name: string) => new TextDecoder().decode(entries.get(name));
		expect(text("session.md")).toContain("main prompt");
		expect(text("session.md")).not.toContain("scout task");
		expect(text("subagents/Scout.md")).toStartWith("# Subagent: Scout\n\nModel: anthropic/claude-x\n");
		expect(text("subagents/Scout.md")).toContain("scout task");
		expect(text("subagents/Scout.md")).not.toContain("helper task");
		expect(text("subagents/Scout/Helper.md")).toContain("helper task");
		expect(JSON.parse(text("llm-request.json")).messages).toHaveLength(1);
	});

	it("returns undefined when the main session has no messages", async () => {
		session.agent.state.messages = [];
		expect(await session.dumpSessionArchiveToTmpDir()).toBeUndefined();
	});
});
