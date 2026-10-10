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

	it("writes anonymized JSONL for the session and each subagent, mapping agent ids consistently", async () => {
		const sessionFile = session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const subDir = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(subDir, "Scout.jsonl"), subagentJsonl("scout", "scout task"));
		// A truncated trailing record: the transcript still loads, and the skip must be reported.
		await Bun.write(
			path.join(subDir, "Scout", "Helper.jsonl"),
			`${subagentJsonl("helper", "helper task")}{"type":"message","id":"helper-x`,
		);

		const archive = await session.dumpAnonymizedArchiveToTmpDir();
		if (!archive) throw new Error("Expected an archive");
		archives.push(archive.path);

		expect(archive.anonymized).toBe(true);
		expect(archive.subagentCount).toBe(2);
		const [main, scout, helper] = archive.files;
		expect(main).toBe("session.jsonl");
		expect(scout).toMatch(/^subagents\/seg\d+\.jsonl$/);
		expect(helper).toMatch(new RegExp(`^${scout.slice(0, -".jsonl".length)}/seg\\d+\\.jsonl$`));
		expect(archive.malformed).toEqual([[helper, 1]]);
		const entries = await readArchiveEntries({ bytes: await Bun.file(archive.path).bytes(), format: "zip" });
		const scoutLines = new TextDecoder()
			.decode(entries.get(scout))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(scoutLines.map(line => line.type)).toEqual(["session", "model_change", "message"]);
		expect(scoutLines[1].model).toBe("anthropic/claude-x");
		expect(scoutLines[2].message.content).toMatch(/^\[redacted #\d+: 10 chars, 1 line\]$/);
		for (const name of archive.files) {
			const body = new TextDecoder().decode(entries.get(name));
			for (const secret of ["scout task", "helper task", "Scout", "Helper"]) expect(body).not.toContain(secret);
		}
	});

	it("reports a subagent whose session header cannot be read instead of dropping it silently", async () => {
		const sessionFile = session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const subDir = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(subDir, "Scout.jsonl"), subagentJsonl("scout", "scout task"));
		await Bun.write(path.join(subDir, "Broken.jsonl"), `{"type":"session","version":3,"id":"bro`);
		// Valid records without a leading header parse cleanly but still cannot be exported.
		const headless = subagentJsonl("headless", "headless task").split("\n").slice(1).join("\n");
		await Bun.write(path.join(subDir, "Headless.jsonl"), headless);

		const archive = await session.dumpAnonymizedArchiveToTmpDir();
		if (!archive) throw new Error("Expected an archive");
		archives.push(archive.path);

		expect(archive.subagentCount).toBe(1);
		expect(archive.unreadable).toEqual([
			expect.stringMatching(/^subagents\/seg\d+\.jsonl$/),
			expect.stringMatching(/^subagents\/seg\d+\.jsonl$/),
		]);
	});

	it("reports malformed records skipped while loading the main session", async () => {
		const file = path.join(tempDir.path(), "corrupt.jsonl");
		await Bun.write(file, `${subagentJsonl("main", "hello")}{"type":"message","id":"broken`);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model");
		const reopened = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: [],
					tools: [],
					messages: [{ role: "user", content: "x", timestamp: 1 }],
				},
			}),
			sessionManager: await SessionManager.open(file, tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(createInMemoryAuthStorage()),
			advisorTools: [],
		});
		try {
			const archive = await reopened.dumpAnonymizedArchiveToTmpDir();
			if (!archive) throw new Error("Expected an archive");
			archives.push(archive.path);
			expect(archive.malformed).toEqual([["session.jsonl", 1]]);
		} finally {
			await reopened.dispose();
		}
	});

	it("returns undefined when the main session has no messages", async () => {
		session.agent.state.messages = [];
		expect(await session.dumpSessionArchiveToTmpDir()).toBeUndefined();
	});
});
