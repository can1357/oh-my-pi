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
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
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

	function createSession(prompt: string): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model");
		const authStorage = createInMemoryAuthStorage();
		return new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [{ role: "user", content: prompt, timestamp: 1 }],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			advisorTools: [],
		});
	}

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-dump-all-");
		session = createSession("main prompt");
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

	it("includes a live subagent's unpersisted in-flight turn and pending tools", async () => {
		const sessionFile = session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const subDir = sessionFile.slice(0, -".jsonl".length);
		const scoutFile = path.join(subDir, "Scout.jsonl");
		const workerFile = path.join(subDir, "Worker.jsonl");
		await Bun.write(scoutFile, subagentJsonl("scout", "scout task"));
		await Bun.write(workerFile, subagentJsonl("worker", "worker task"));

		const scout = createSession("scout task");
		const startedAt = Date.now() - 90_000;
		scout.agent.state.isStreaming = true;
		scout.agent.state.streamMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "Mentally compiling block.rs" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: startedAt,
		};
		const worker = createSession("worker task");
		worker.agent.state.isStreaming = true;
		worker.agent.state.messages.push({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "cargo build" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: startedAt,
		});
		worker.agent.state.pendingToolCalls.add("call-1");

		const registry = AgentRegistry.global();
		registry.register({ id: "Scout", displayName: "Scout", kind: "sub", session: scout, sessionFile: scoutFile });
		registry.register({ id: "Worker", displayName: "Worker", kind: "sub", session: worker, sessionFile: workerFile });
		try {
			const archive = await session.dumpSessionArchiveToTmpDir();
			if (!archive) throw new Error("Expected an archive");
			archives.push(archive.path);
			const entries = await readArchiveEntries({ bytes: await Bun.file(archive.path).bytes(), format: "zip" });
			const scoutText = new TextDecoder().decode(entries.get("subagents/Scout.md"));
			const workerText = new TextDecoder().decode(entries.get("subagents/Worker.md"));

			expect(scoutText).toContain("Live: running, request in flight");
			expect(scoutText).toContain(
				`## Assistant (in flight, not persisted) · started ${new Date(startedAt).toISOString()}`,
			);
			expect(scoutText).toContain("Mentally compiling block.rs");
			expect(workerText).toContain("Pending tool calls: bash (call-1)");
			// A running tool is not a stalled model request, even though the agent turn is busy.
			expect(workerText).toContain("Live: running, running tools");
			expect(workerText).not.toContain("request in flight");
			expect(workerText).not.toContain("in flight, not persisted");
		} finally {
			registry.unregister("Scout");
			registry.unregister("Worker");
			scout.agent.state.isStreaming = false;
			worker.agent.state.isStreaming = false;
			await scout.dispose();
			await worker.dispose();
		}
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
