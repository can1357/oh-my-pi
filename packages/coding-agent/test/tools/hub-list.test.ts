import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { HistoryProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/history-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, getAgentTombstonePath, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster, registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { collectIrcPeerRoster } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";
import {
	DEFAULT_HUB_LIST_LIMIT,
	executeList,
	executeSend,
	MAX_HUB_LIST_LIMIT,
} from "@oh-my-pi/pi-coding-agent/tools/hub/messaging";
import { prompt, TempDir } from "@oh-my-pi/pi-utils";

function sessionHeader(id: string): string {
	return JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-08-13T17:14:48.125Z",
		cwd: "/tmp",
	});
}

async function writeParkedTranscript(sessionFile: string, id: string, task: string): Promise<void> {
	await Bun.write(
		sessionFile,
		`${[
			sessionHeader(id),
			JSON.stringify({
				type: "session_init",
				id: `si-${id}`,
				parentId: null,
				timestamp: "2026-08-13T17:14:49.000Z",
				systemPrompt: "review",
				task,
				tools: ["read"],
			}),
		].join("\n")}\n`,
	);
}

function listText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content[0];
	if (content?.type !== "text") throw new Error("Expected text result");
	const text = content.text;
	if (typeof text !== "string") throw new Error("Expected text result");
	return text;
}

function makeToolSession(registry: AgentRegistry, agentId: string, sessionFile: string | null = null): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		agentRegistry: registry,
		getAgentId: () => agentId,
	};
}

const subagentSystemPromptTemplatePath = path.resolve(
	import.meta.dir,
	"../../src/prompts/system/subagent-system-prompt.md",
);

/**
 * Render the production subagent system prompt (roster section and all) with
 * the live peer data — the same template and render engine the executor uses
 * when spawning a child session — so these tests pin the real prompt output.
 */
async function renderIrcPeerRoster(
	selfId: string,
	registry: AgentRegistry = AgentRegistry.global(),
	sessionFileHint?: string | null,
): Promise<string> {
	const hint = sessionFileHint ?? registry.get(selfId)?.sessionFile ?? registry.get(MAIN_AGENT_ID)?.sessionFile;
	const root = await ensurePersistedRoster(registry, hint);
	const roster = collectIrcPeerRoster(registry, selfId, root);
	return prompt.render(await fs.promises.readFile(subagentSystemPromptTemplatePath, "utf-8"), {
		agent: "",
		context: "",
		planReference: "",
		planReferencePath: "",
		worktree: "",
		outputSchema: undefined,
		outputSchemaOverridesAgent: false,
		ircPeers: roster.peers,
		ircParkedCount: roster.parkedCount,
		ircOmittedCount: roster.omittedCount,
		ircSelfId: selfId,
	});
}

describe("hub list", () => {
	it("defaults to running+idle peers and reports parked counts without parked names", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			status: "running",
		});
		registry.register({
			id: "AuthLoader",
			displayName: "task",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			status: "running",
			activity: "auditing tokens",
		});
		registry.register({
			id: "IdleWorker",
			displayName: "task",
			kind: "sub",
			session: null,
			status: "idle",
		});
		registry.register({
			id: "ParkedScout",
			displayName: "secret parked label",
			kind: "sub",
			session: null,
			status: "parked",
			activity: "reviewing classified.diff",
		});

		const result = await executeList(registry, MAIN_AGENT_ID);
		if (!result.details) throw new Error("Expected coordination details");

		expect(result.details.peers?.map(peer => peer.id)).toEqual(["AuthLoader", "IdleWorker"]);
		expect(result.details.counts).toEqual({
			running: 1,
			idle: 1,
			parked: 1,
			shown: 2,
			truncated: 0,
		});
		const text = listText(result);
		expect(text).toContain("AuthLoader");
		expect(text).toContain("IdleWorker");
		expect(text).toContain("parked 1");
		expect(text).toContain('status="parked"');
		expect(text).not.toContain("ParkedScout");
		expect(text).not.toContain("secret parked label");
		expect(text).not.toContain("reviewing classified.diff");
	});

	it("lists parked peers only when status=parked is requested", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			status: "running",
		});
		registry.register({ id: "Live", displayName: "task", kind: "sub", session: null, status: "idle" });
		registry.register({
			id: "ParkedScout",
			displayName: "task",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			status: "parked",
		});

		const result = await executeList(registry, MAIN_AGENT_ID, { status: "parked" });
		if (!result.details) throw new Error("Expected coordination details");

		expect(result.details.peers).toEqual([
			expect.objectContaining({
				id: "ParkedScout",
				status: "parked",
				parentId: MAIN_AGENT_ID,
			}),
		]);
		expect(result.details.counts).toEqual({
			running: 0,
			idle: 1,
			parked: 1,
			shown: 1,
			truncated: 0,
		});
		expect(listText(result)).toContain("Parked agents are revived automatically");
	});

	it("bounds the page and reports truncated without a cursor", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			status: "running",
		});
		const extra = 5;
		for (let index = 0; index < DEFAULT_HUB_LIST_LIMIT + extra; index++) {
			registry.register({
				id: `Idle${index}`,
				displayName: "task",
				kind: "sub",
				session: null,
				status: "idle",
				lastActivity: index,
			});
		}

		const result = await executeList(registry, MAIN_AGENT_ID);
		if (!result.details) throw new Error("Expected coordination details");

		expect(result.details.peers).toHaveLength(DEFAULT_HUB_LIST_LIMIT);
		expect(result.details.counts).toEqual({
			running: 0,
			idle: DEFAULT_HUB_LIST_LIMIT + extra,
			parked: 0,
			shown: DEFAULT_HUB_LIST_LIMIT,
			truncated: extra,
		});
		expect(result.details.peers?.[0]?.id).toBe(`Idle${DEFAULT_HUB_LIST_LIMIT + extra - 1}`);
		expect(result.details).not.toHaveProperty("cursor");
		expect(listText(result)).toContain(`truncated ${extra}`);
	});

	it("clamps an explicit limit so parked archaeology cannot dump hundreds of names", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			status: "running",
		});
		const extra = 20;
		for (let index = 0; index < MAX_HUB_LIST_LIMIT + extra; index++) {
			registry.register({
				id: `Parked${index}`,
				displayName: "task",
				kind: "sub",
				session: null,
				status: "parked",
				lastActivity: index,
			});
		}

		const result = await executeList(registry, MAIN_AGENT_ID, { status: "parked", limit: 500 });
		if (!result.details) throw new Error("Expected coordination details");

		expect(result.details.peers).toHaveLength(MAX_HUB_LIST_LIMIT);
		expect(result.details.counts).toEqual({
			running: 0,
			idle: 0,
			parked: MAX_HUB_LIST_LIMIT + extra,
			shown: MAX_HUB_LIST_LIMIT,
			truncated: extra,
		});
	});

	it("excludes aborted and advisor refs from every list view", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			status: "running",
		});
		registry.register({ id: "Worker", displayName: "task", kind: "sub", session: null, status: "idle" });
		registry.register({
			id: `${MAIN_AGENT_ID}/advisor`,
			displayName: "advisor",
			kind: "advisor",
			session: null,
			status: "parked",
		});
		registry.register({ id: "Dead", displayName: "task", kind: "sub", session: null, status: "aborted" });

		const listed = await executeList(registry, MAIN_AGENT_ID);
		const parked = await executeList(registry, MAIN_AGENT_ID, { status: "parked" });
		if (!listed.details || !parked.details) throw new Error("Expected coordination details");

		expect(listed.details.peers?.map(peer => peer.id)).toEqual(["Worker"]);
		expect(parked.details.peers).toEqual([]);
		expect(listed.details.counts).toEqual({
			running: 0,
			idle: 1,
			parked: 0,
			shown: 1,
			truncated: 0,
		});
	});

	it("keeps actionable peers available when persisted roster IO is invalid", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile: "\0invalid.jsonl",
			status: "running",
		});
		registry.register({
			id: "LiveWorker",
			displayName: "task",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			status: "idle",
		});

		const result = await executeList(registry, MAIN_AGENT_ID);
		if (!result.details) throw new Error("Expected coordination details");
		expect(result.details.peers?.map(peer => peer.id)).toEqual(["LiveWorker"]);
		expect(result.details.counts?.idle).toBe(1);
	});

	it("retries persisted roster scan after a transient readdir failure", async () => {
		using tempDir = TempDir.createSync("@omp-hub-list-readdir-retry-");
		const dir = tempDir.path();
		const sessionFile = path.join(dir, "main.jsonl");
		await Bun.write(sessionFile, `${sessionHeader("main")}\n`);
		await writeParkedTranscript(path.join(dir, "main", "ParkedScout.jsonl"), "parked", "reviewing classified.diff");

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});
		registry.register({
			id: "LiveWorker",
			displayName: "task",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			status: "idle",
		});

		const readdirSpy = spyOn(fs.promises, "readdir").mockRejectedValueOnce(
			Object.assign(new Error("too many open files"), { code: "EMFILE" }),
		);
		try {
			const first = await executeList(registry, MAIN_AGENT_ID);
			if (!first.details) throw new Error("Expected coordination details");
			expect(first.isError).toBeFalsy();
			expect(first.details.peers?.map(peer => peer.id)).toEqual(["LiveWorker"]);
			expect(first.details.counts).toEqual({
				running: 0,
				idle: 1,
				parked: 0,
				shown: 1,
				truncated: 0,
			});
			expect(registry.get("ParkedScout")).toBeUndefined();
			expect(listText(first)).not.toContain("ParkedScout");

			const second = await executeList(registry, MAIN_AGENT_ID);
			if (!second.details) throw new Error("Expected coordination details");
			expect(second.isError).toBeFalsy();
			expect(second.details.peers?.map(peer => peer.id)).toEqual(["LiveWorker"]);
			expect(second.details.counts).toEqual({
				running: 0,
				idle: 1,
				parked: 1,
				shown: 1,
				truncated: 0,
			});
			expect(registry.get("ParkedScout")?.status).toBe("parked");
			expect(listText(second)).not.toContain("ParkedScout");
		} finally {
			readdirSpy.mockRestore();
		}
	});

	it("retries persisted roster scan after a root transcript read failure", async () => {
		using tempDir = TempDir.createSync("@omp-hub-list-vibe-read-retry-");
		const dir = tempDir.path();
		const sessionFile = path.join(dir, "main.jsonl");
		const transcriptFile = path.join(dir, "main", "ParkedScout.jsonl");
		await fs.promises.mkdir(sessionFile);
		await writeParkedTranscript(transcriptFile, "parked", "reviewing classified.diff");

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});

		const first = await executeList(registry, MAIN_AGENT_ID);
		if (!first.details) throw new Error("Expected coordination details");
		expect(first.isError).toBeFalsy();
		expect(first.details.counts).toEqual({
			running: 0,
			idle: 0,
			parked: 0,
			shown: 0,
			truncated: 0,
		});
		expect(registry.get("ParkedScout")).toBeUndefined();

		await fs.promises.rmdir(sessionFile);
		await Bun.write(sessionFile, `${sessionHeader("main")}\n`);

		const second = await executeList(registry, MAIN_AGENT_ID);
		if (!second.details) throw new Error("Expected coordination details");
		expect(second.isError).toBeFalsy();
		expect(second.details.counts).toEqual({
			running: 0,
			idle: 0,
			parked: 1,
			shown: 0,
			truncated: 0,
		});
		expect(registry.get("ParkedScout")?.status).toBe("parked");
		expect(listText(second)).not.toContain("ParkedScout");
	});

	it("retries persisted roster scan after a tombstone access failure", async () => {
		using tempDir = TempDir.createSync("@omp-hub-list-tombstone-retry-");
		const dir = tempDir.path();
		const sessionFile = path.join(dir, "main.jsonl");
		const transcriptFile = path.join(dir, "main", "ParkedScout.jsonl");
		await Bun.write(sessionFile, `${sessionHeader("main")}\n`);
		await writeParkedTranscript(transcriptFile, "parked", "reviewing classified.diff");

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});

		const accessSpy = spyOn(fs.promises, "access").mockImplementationOnce(async target => {
			expect(target).toBe(getAgentTombstonePath(transcriptFile));
			throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		});
		try {
			const first = await executeList(registry, MAIN_AGENT_ID);
			if (!first.details) throw new Error("Expected coordination details");
			expect(first.isError).toBeFalsy();
			expect(first.details.counts).toEqual({
				running: 0,
				idle: 0,
				parked: 0,
				shown: 0,
				truncated: 0,
			});
			expect(registry.get("ParkedScout")).toBeUndefined();

			const second = await executeList(registry, MAIN_AGENT_ID);
			if (!second.details) throw new Error("Expected coordination details");
			expect(second.isError).toBeFalsy();
			expect(second.details.counts).toEqual({
				running: 0,
				idle: 0,
				parked: 1,
				shown: 0,
				truncated: 0,
			});
			expect(registry.get("ParkedScout")?.status).toBe("parked");
			expect(listText(second)).not.toContain("ParkedScout");
		} finally {
			accessSpy.mockRestore();
		}
	});

	it("drops the latch and re-reads after a transient metadata read failure", async () => {
		for (const code of ["EMFILE", "EACCES"] as const) {
			using tempDir = TempDir.createSync(`@omp-hub-list-metadata-${code}-`);
			const dir = tempDir.path();
			const sessionFile = path.join(dir, "main.jsonl");
			await Bun.write(sessionFile, `${sessionHeader("main")}\n`);
			const transcriptFile = path.join(dir, "main", "ParkedScout.jsonl");
			await writeParkedTranscript(transcriptFile, "parked", "reviewing classified.diff");

			const registry = new AgentRegistry();
			registry.register({
				id: MAIN_AGENT_ID,
				displayName: MAIN_AGENT_ID,
				kind: "main",
				session: null,
				sessionFile,
				status: "running",
			});
			registry.register({
				id: "LiveWorker",
				displayName: "task",
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: null,
				status: "idle",
			});

			const statSpy = spyOn(fs.promises, "stat").mockRejectedValueOnce(
				Object.assign(new Error(code === "EMFILE" ? "too many open files" : "permission denied"), { code }),
			);
			try {
				const first = await executeList(registry, MAIN_AGENT_ID);
				if (!first.details) throw new Error("Expected coordination details");
				expect(first.isError).toBeFalsy();
				expect(first.details.peers?.map(peer => peer.id)).toEqual(["LiveWorker"]);
				expect(first.details.counts).toEqual({
					running: 0,
					idle: 1,
					parked: 0,
					shown: 1,
					truncated: 0,
				});
				expect(registry.get("ParkedScout")).toBeUndefined();
				expect(listText(first)).not.toContain("ParkedScout");

				// The failed scan must not latch: the next call re-reads the same
				// transcript and registers it as parked.
				const second = await executeList(registry, MAIN_AGENT_ID);
				if (!second.details) throw new Error("Expected coordination details");
				expect(second.isError).toBeFalsy();
				expect(second.details.peers?.map(peer => peer.id)).toEqual(["LiveWorker"]);
				expect(second.details.counts).toEqual({
					running: 0,
					idle: 1,
					parked: 1,
					shown: 1,
					truncated: 0,
				});
				expect(registry.get("ParkedScout")?.status).toBe("parked");
				expect(listText(second)).not.toContain("ParkedScout");
			} finally {
				statSpy.mockRestore();
			}
		}
	});

	it("tolerates a transcript vanishing between readdir and its metadata read", async () => {
		using tempDir = TempDir.createSync("@omp-hub-list-metadata-enoent-race-");
		const dir = tempDir.path();
		const sessionFile = path.join(dir, "main.jsonl");
		const transcriptFile = path.join(dir, "main", "ParkedScout.jsonl");
		await Bun.write(sessionFile, `${sessionHeader("main")}\n`);
		await writeParkedTranscript(transcriptFile, "parked", "reviewing classified.diff");

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});
		registry.register({
			id: "LiveWorker",
			displayName: "task",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			status: "idle",
		});

		const accessSpy = spyOn(fs.promises, "access").mockImplementationOnce(async () => {
			// The transcript existed when readdir listed it; it is gone by the
			// time the metadata read runs (session switch or compaction).
			await fs.promises.rm(transcriptFile);
			throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
		});
		try {
			const first = await executeList(registry, MAIN_AGENT_ID);
			if (!first.details) throw new Error("Expected coordination details");
			expect(first.isError).toBeFalsy();
			expect(first.details.counts).toEqual({
				running: 0,
				idle: 1,
				parked: 0,
				shown: 1,
				truncated: 0,
			});
			expect(registry.get("ParkedScout")).toBeUndefined();

			// ENOENT is a stable state, not a transient fault: the completed
			// scan latches, so a reappearing transcript is not re-scanned.
			await writeParkedTranscript(transcriptFile, "parked", "reviewing classified.diff");
			const second = await executeList(registry, MAIN_AGENT_ID);
			if (!second.details) throw new Error("Expected coordination details");
			expect(second.isError).toBeFalsy();
			expect(second.details.counts?.parked).toBe(0);
			expect(registry.get("ParkedScout")).toBeUndefined();
		} finally {
			accessSpy.mockRestore();
		}
	});

	it("tolerates a malformed transcript prefix and registers what it can parse", async () => {
		using tempDir = TempDir.createSync("@omp-hub-list-malformed-");
		const dir = tempDir.path();
		const sessionFile = path.join(dir, "main.jsonl");
		const transcriptFile = path.join(dir, "main", "ParkedScout.jsonl");
		await Bun.write(sessionFile, `${sessionHeader("main")}\n`);
		await Bun.write(
			transcriptFile,
			`${[
				"{not json at all",
				sessionHeader("parked"),
				JSON.stringify({
					type: "session_init",
					id: "si-parked",
					parentId: null,
					timestamp: "2026-08-13T17:14:49.000Z",
					systemPrompt: "review",
					task: "reviewing classified.diff",
					tools: ["read"],
				}),
			].join("\n")}\n`,
		);

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});

		const listed = await executeList(registry, MAIN_AGENT_ID, { status: "parked" });
		if (!listed.details) throw new Error("Expected coordination details");
		expect(listed.isError).toBeFalsy();
		expect(registry.get("ParkedScout")?.status).toBe("parked");
		expect(registry.get("ParkedScout")?.activity).toContain("reviewing classified.diff");
		expect(listed.details.peers?.map(peer => peer.id)).toEqual(["ParkedScout"]);
	});

	it("latches an empty persisted roster when the optional subagent directory is missing", async () => {
		using tempDir = TempDir.createSync("@omp-hub-list-enoent-latch-");
		const dir = tempDir.path();
		const sessionFile = path.join(dir, "main.jsonl");
		await Bun.write(sessionFile, `${sessionHeader("main")}\n`);

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});
		registry.register({
			id: "LiveWorker",
			displayName: "task",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			status: "idle",
		});

		const first = await executeList(registry, MAIN_AGENT_ID);
		if (!first.details) throw new Error("Expected coordination details");
		expect(first.isError).toBeFalsy();
		expect(first.details.counts).toEqual({
			running: 0,
			idle: 1,
			parked: 0,
			shown: 1,
			truncated: 0,
		});

		await writeParkedTranscript(path.join(dir, "main", "ParkedScout.jsonl"), "parked", "reviewing classified.diff");
		const second = await executeList(registry, MAIN_AGENT_ID);
		if (!second.details) throw new Error("Expected coordination details");
		expect(second.isError).toBeFalsy();
		expect(second.details.counts?.parked).toBe(0);
		expect(registry.get("ParkedScout")).toBeUndefined();
	});

	it("schema rejects aborted and advisor list filters", () => {
		const tool = new HubTool(makeToolSession(new AgentRegistry(), MAIN_AGENT_ID));
		expect(() => tool.parameters.assert({ op: "list", status: "aborted" })).toThrow();
		expect(() => tool.parameters.assert({ op: "list", status: "advisor" })).toThrow();
		expect(tool.parameters.assert({ op: "list", status: "parked" })).toEqual({ op: "list", status: "parked" });
	});

	it("restores persisted peers after the process registry is lost without leaking them into the default view", async () => {
		using tempDir = TempDir.createSync("@omp-hub-list-persisted-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		await Bun.write(sessionFile, `${sessionHeader("main")}\n`);
		// A settled subagent transcript: header + session_init. A header-only file
		// is a mid-spawn stub and stays unregistered by design.
		await Bun.write(
			workerSessionFile,
			`${[
				sessionHeader("worker"),
				JSON.stringify({
					type: "session_init",
					id: "si",
					parentId: null,
					timestamp: "2026-08-13T17:14:49.000Z",
					systemPrompt: "review",
					task: "review the diff",
					tools: ["read"],
				}),
			].join("\n")}\n`,
		);

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});

		const listed = await executeList(registry, MAIN_AGENT_ID);
		if (!listed.details) throw new Error("Expected coordination details");
		expect(listed.details.peers).toEqual([]);
		expect(listed.details.counts).toEqual({
			running: 0,
			idle: 0,
			parked: 1,
			shown: 0,
			truncated: 0,
		});
		expect(listText(listed)).not.toContain("Worker");
		expect(registry.get("Worker")?.sessionFile).toBe(workerSessionFile);

		const parked = await executeList(registry, MAIN_AGENT_ID, { status: "parked" });
		if (!parked.details) throw new Error("Expected coordination details");
		expect(parked.details.peers).toEqual([
			expect.objectContaining({
				id: "Worker",
				kind: "sub",
				status: "parked",
				parentId: MAIN_AGENT_ID,
			}),
		]);
		expect(listText(parked)).toContain("Worker");
		expect(listText(parked)).toContain("parked");
	});

	it("counts a disk-only parked sibling when a live sibling is already in memory", async () => {
		using tempDir = TempDir.createSync("@omp-hub-list-live-disk-");
		const dir = tempDir.path();
		const sessionFile = path.join(dir, "main.jsonl");
		const liveSessionFile = path.join(dir, "main", "LiveWorker.jsonl");
		const parkedSessionFile = path.join(dir, "main", "ParkedScout.jsonl");
		await Bun.write(sessionFile, `${sessionHeader("main")}\n`);
		await writeParkedTranscript(parkedSessionFile, "parked", "reviewing classified.diff");

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});
		registry.register({
			id: "LiveWorker",
			displayName: "task",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: liveSessionFile,
			status: "idle",
		});

		const listed = await executeList(registry, MAIN_AGENT_ID);
		if (!listed.details) throw new Error("Expected coordination details");
		expect(listed.details.peers?.map(peer => peer.id)).toEqual(["LiveWorker"]);
		expect(listed.details.counts).toEqual({
			running: 0,
			idle: 1,
			parked: 1,
			shown: 1,
			truncated: 0,
		});
		expect(listText(listed)).not.toContain("ParkedScout");
		expect(listText(listed)).not.toContain("reviewing classified.diff");

		const fromChild = await executeList(registry, "LiveWorker");
		if (!fromChild.details) throw new Error("Expected coordination details");
		expect(fromChild.details.counts?.parked).toBe(1);
		expect(fromChild.details.peers?.map(peer => peer.id)).not.toContain("ParkedScout");
	});
	it("rescans and scopes parked peers when one registry switches root sessions", async () => {
		using tempDir = TempDir.createSync("@omp-hub-list-session-switch-");
		const firstSession = path.join(tempDir.path(), "first.jsonl");
		const secondSession = path.join(tempDir.path(), "second.jsonl");
		await Bun.write(firstSession, `${sessionHeader("first")}\n`);
		await Bun.write(secondSession, `${sessionHeader("second")}\n`);
		await writeParkedTranscript(path.join(tempDir.path(), "first", "FirstWorker.jsonl"), "first-worker", "first");
		await writeParkedTranscript(path.join(tempDir.path(), "second", "SecondWorker.jsonl"), "second-worker", "second");

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile: firstSession,
			status: "running",
		});
		const first = await executeList(registry, MAIN_AGENT_ID, { status: "parked" });
		if (!first.details) throw new Error("Expected coordination details");
		expect(first.details.peers?.map(peer => peer.id)).toEqual(["FirstWorker"]);

		const hintedRoster = await renderIrcPeerRoster("HintedChild", registry, secondSession);
		expect(hintedRoster).toContain("1 parked peer(s) omitted");
		expect(registry.get("SecondWorker")).toBeDefined();
		expect(hintedRoster).not.toContain("FirstWorker");
		expect(hintedRoster).not.toContain("SecondWorker");
		registry.unregister(MAIN_AGENT_ID);
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile: secondSession,
			status: "running",
		});
		const second = await executeList(registry, MAIN_AGENT_ID, { status: "parked" });
		if (!second.details) throw new Error("Expected coordination details");
		expect(second.details.peers?.map(peer => peer.id)).toEqual(["SecondWorker"]);
		expect(second.details.counts?.parked).toBe(1);
		expect(registry.get("FirstWorker")).toBeDefined();

		const promptRoster = await renderIrcPeerRoster(MAIN_AGENT_ID, registry, secondSession);
		expect(promptRoster).toContain("1 parked peer(s) omitted");
		expect(promptRoster).not.toContain("FirstWorker");
		expect(promptRoster).not.toContain("SecondWorker");
	});

	it("climbs more than nine nested session levels to count a parked top-level sibling", async () => {
		using tempDir = TempDir.createSync("@omp-hub-list-deep-nest-");
		const dir = tempDir.path();
		const sessionFile = path.join(dir, "main.jsonl");
		await Bun.write(sessionFile, `${sessionHeader("main")}\n`);
		await writeParkedTranscript(path.join(dir, "main", "ParkedScout.jsonl"), "parked", "reviewing classified.diff");

		let nestedDir = path.join(dir, "main");
		let deepSessionFile = sessionFile;
		for (let level = 1; level <= 10; level++) {
			deepSessionFile = path.join(nestedDir, `L${level}.jsonl`);
			await Bun.write(deepSessionFile, `${sessionHeader(`L${level}`)}\n`);
			nestedDir = path.join(nestedDir, `L${level}`);
		}

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});
		registry.register({
			id: "DeepChild",
			displayName: "task",
			kind: "sub",
			parentId: "L9",
			session: null,
			sessionFile: deepSessionFile,
			status: "idle",
		});

		const listed = await executeList(registry, "DeepChild");
		if (!listed.details) throw new Error("Expected coordination details");
		expect(listed.details.counts?.parked).toBe(1);
		expect(listed.details.peers?.map(peer => peer.id)).toEqual([MAIN_AGENT_ID]);
		expect(listText(listed)).not.toContain("ParkedScout");
		expect(registry.get("ParkedScout")?.status).toBe("parked");

		const roster = await renderIrcPeerRoster("DeepChild", registry, deepSessionFile);
		expect(roster).toContain("1 parked peer(s) omitted");
		expect(roster).toContain("`Main`");
		expect(roster).not.toContain("ParkedScout");
		expect(roster).not.toContain("reviewing classified.diff");
	});

	it("clamps a positive fractional limit to at least one row", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			status: "running",
		});
		registry.register({ id: "IdleWorker", displayName: "task", kind: "sub", session: null, status: "idle" });

		const result = await executeList(registry, MAIN_AGENT_ID, { limit: 0.9 });
		if (!result.details) throw new Error("Expected coordination details");
		expect(result.details.peers).toHaveLength(1);
		expect(result.details.counts?.shown).toBe(1);
		expect(result.details.counts?.truncated).toBe(0);
	});

	it("send still revives a known parked id omitted from the default list", async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		try {
			const registry = AgentRegistry.global();
			registry.register({
				id: MAIN_AGENT_ID,
				displayName: MAIN_AGENT_ID,
				kind: "main",
				session: null,
				status: "running",
			});
			registry.register({ id: "Sleeper", displayName: "task", kind: "sub", session: null, status: "parked" });
			const delivered: string[] = [];
			const revived = {
				isStreaming: false,
				deliverIrcMessage: async (msg: { body: string }) => {
					delivered.push(msg.body);
					return "woken";
				},
			} as unknown as AgentSession;
			AgentLifecycleManager.global().adopt("Sleeper", {
				idleTtlMs: 0,
				revive: async () => revived,
			});

			const listed = await executeList(registry, MAIN_AGENT_ID);
			expect(listed.details?.peers?.map(peer => peer.id)).not.toContain("Sleeper");

			const sent = await executeSend(
				{ registry, senderId: MAIN_AGENT_ID, settings: Settings.isolated() },
				{ to: "Sleeper", message: "wake up" },
			);
			expect(sent.isError).toBeFalsy();
			expect(sent.details?.receipts).toEqual([{ to: "Sleeper", outcome: "revived" }]);
			expect(delivered).toEqual(["wake up"]);
			expect(registry.get("Sleeper")?.status).not.toBe("parked");
		} finally {
			AgentRegistry.resetGlobalForTests();
			AgentLifecycleManager.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		}
	});
});

describe("hub list session authority", () => {
	it("uses HubTool getSessionFile when Main's registry ref still points at the old root", async () => {
		using tempDir = TempDir.createSync("@omp-hub-stale-main-");
		const firstSession = path.join(tempDir.path(), "first.jsonl");
		const secondSession = path.join(tempDir.path(), "second.jsonl");
		await Bun.write(firstSession, `${sessionHeader("first")}\n`);
		await Bun.write(secondSession, `${sessionHeader("second")}\n`);
		await writeParkedTranscript(path.join(tempDir.path(), "first", "FirstWorker.jsonl"), "first-worker", "first");
		await writeParkedTranscript(path.join(tempDir.path(), "second", "SecondWorker.jsonl"), "second-worker", "second");

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile: firstSession,
			status: "running",
		});
		const tool = new HubTool(makeToolSession(registry, MAIN_AGENT_ID, secondSession));
		const listed = await tool.execute("list-switch", { op: "list", status: "parked" });
		if (!listed.details || !("peers" in listed.details)) throw new Error("Expected list details");
		expect(listed.details.peers?.map(peer => peer.id)).toEqual(["SecondWorker"]);
		expect(listText(listed)).not.toContain("FirstWorker");
		expect(registry.get(MAIN_AGENT_ID)?.sessionFile).toBe(firstSession);
	});

	it("replaces a detached old-root parked sub so send and history target the current file", async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		try {
			using tempDir = TempDir.createSync("@omp-hub-replace-current-");
			const firstSession = path.join(tempDir.path(), "first.jsonl");
			const secondSession = path.join(tempDir.path(), "second.jsonl");
			const oldWorker = path.join(tempDir.path(), "first", "Worker.jsonl");
			const newWorker = path.join(tempDir.path(), "second", "Worker.jsonl");
			await Bun.write(firstSession, `${sessionHeader("first")}\n`);
			await Bun.write(secondSession, `${sessionHeader("second")}\n`);
			await Bun.write(
				oldWorker,
				`${[
					sessionHeader("old-worker"),
					JSON.stringify({
						type: "session_init",
						id: "si-old",
						parentId: null,
						timestamp: "2026-08-13T17:14:49.000Z",
						systemPrompt: "review",
						task: "old-secret-task-body",
						tools: ["read"],
					}),
					JSON.stringify({
						type: "message",
						id: "old-user",
						parentId: null,
						timestamp: "2026-08-13T17:14:50.000Z",
						message: { role: "user", content: "old-secret-user-line", timestamp: 1 },
					}),
				].join("\n")}\n`,
			);
			await Bun.write(
				newWorker,
				`${[
					sessionHeader("worker"),
					JSON.stringify({
						type: "session_init",
						id: "si-new",
						parentId: null,
						timestamp: "2026-08-13T17:14:49.000Z",
						systemPrompt: "review",
						task: "new-current-task-body",
						tools: ["read"],
					}),
					JSON.stringify({
						type: "message",
						id: "new-user",
						parentId: null,
						timestamp: "2026-08-13T17:14:50.000Z",
						message: { role: "user", content: "new-current-user-line", timestamp: 1 },
					}),
				].join("\n")}\n`,
			);

			const registry = AgentRegistry.global();
			registry.register({
				id: MAIN_AGENT_ID,
				displayName: MAIN_AGENT_ID,
				kind: "main",
				session: null,
				sessionFile: firstSession,
				status: "running",
			});
			registry.register({
				id: "Worker",
				displayName: "task",
				kind: "sub",
				session: null,
				sessionFile: oldWorker,
				status: "parked",
				activity: "old-secret-task-body",
			});

			const tool = new HubTool(makeToolSession(registry, MAIN_AGENT_ID, secondSession));
			const listed = await tool.execute("list-replace", { op: "list", status: "parked" });
			if (!listed.details || !("peers" in listed.details)) throw new Error("Expected list details");
			expect(registry.get("Worker")?.sessionFile).toBe(newWorker);
			expect(listed.details.peers?.map(peer => peer.id)).toEqual(["Worker"]);

			const history = await new HistoryProtocolHandler().resolve(parseInternalUrl("history://Worker"));
			expect(history.sourcePath).toBe(newWorker);
			expect(history.content).toContain("new-current-user-line");
			expect(history.content).not.toContain("old-secret-user-line");

			const delivered: string[] = [];
			const revived = {
				isStreaming: false,
				deliverIrcMessage: async (msg: { body: string }) => {
					delivered.push(msg.body);
					return "woken";
				},
			} as unknown as AgentSession;
			AgentLifecycleManager.global().adopt("Worker", {
				idleTtlMs: 0,
				revive: async () => revived,
			});
			const sent = await executeSend(
				{ registry, senderId: MAIN_AGENT_ID, settings: Settings.isolated() },
				{ to: "Worker", message: "wake current" },
			);
			expect(sent.isError).toBeFalsy();
			expect(sent.details?.receipts).toEqual([{ to: "Worker", outcome: "revived" }]);
			expect(delivered).toEqual(["wake current"]);
		} finally {
			AgentRegistry.resetGlobalForTests();
			AgentLifecycleManager.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
		}
	});

	it("preserves live, aborted, advisor, vibe-owned, and nested same-root collisions", async () => {
		using tempDir = TempDir.createSync("@omp-hub-preserve-collisions-");
		const dir = tempDir.path();
		const currentSession = path.join(dir, "current.jsonl");
		const oldLive = path.join(dir, "old", "LiveTwin.jsonl");
		const oldIdle = path.join(dir, "old", "IdleTwin.jsonl");
		const oldDead = path.join(dir, "old", "DeadTwin.jsonl");
		const oldAdvisor = path.join(dir, "old", "AdvisorTwin.jsonl");
		const oldVibe = path.join(dir, "old", "VibeKid.jsonl");
		await Bun.write(
			currentSession,
			`${[
				sessionHeader("current"),
				JSON.stringify({
					type: "custom",
					customType: "vibe-session-lifecycle",
					data: {
						version: 1,
						id: "VibeKid",
						ownerId: MAIN_AGENT_ID,
						parentSessionId: "current",
						action: "spawn",
						cli: "fast",
						agent: "task",
						childSessionFile: "VibeKid.jsonl",
						createdAt: 1,
					},
				}),
			].join("\n")}\n`,
		);
		await writeParkedTranscript(path.join(dir, "current", "LiveTwin.jsonl"), "live", "steal-live");
		await writeParkedTranscript(path.join(dir, "current", "IdleTwin.jsonl"), "idle", "steal-idle");
		await writeParkedTranscript(path.join(dir, "current", "DeadTwin.jsonl"), "dead", "steal-dead");
		await writeParkedTranscript(path.join(dir, "current", "AdvisorTwin.jsonl"), "advisor", "steal-advisor");
		await writeParkedTranscript(path.join(dir, "current", "VibeKid.jsonl"), "vibe", "steal-vibe");
		await writeParkedTranscript(path.join(dir, "current", "Outer.jsonl"), "outer", "outer-visible-task");
		await writeParkedTranscript(path.join(dir, "current", "Outer", "Outer.jsonl"), "nested", "nested-steal-task");

		const registry = new AgentRegistry();
		const liveSession = {} as AgentSession;
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile: currentSession,
			status: "running",
		});
		registry.register({
			id: "LiveTwin",
			displayName: "task",
			kind: "sub",
			session: liveSession,
			sessionFile: oldLive,
			status: "running",
		});
		registry.register({
			id: "IdleTwin",
			displayName: "task",
			kind: "sub",
			session: liveSession,
			sessionFile: oldIdle,
			status: "idle",
		});
		registry.register({
			id: "DeadTwin",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: oldDead,
			status: "aborted",
		});
		registry.register({
			id: "AdvisorTwin",
			displayName: "advisor",
			kind: "advisor",
			session: null,
			sessionFile: oldAdvisor,
			status: "parked",
		});
		registry.register({
			id: "VibeKid",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: oldVibe,
			status: "parked",
		});

		await executeList(registry, MAIN_AGENT_ID, { status: "parked" }, currentSession);
		expect(registry.get("LiveTwin")?.status).toBe("running");
		expect(registry.get("LiveTwin")?.session).toBe(liveSession);
		expect(registry.get("LiveTwin")?.sessionFile).toBe(oldLive);
		expect(registry.get("IdleTwin")?.status).toBe("idle");
		expect(registry.get("IdleTwin")?.sessionFile).toBe(oldIdle);
		expect(registry.get("DeadTwin")?.status).toBe("aborted");
		expect(registry.get("DeadTwin")?.sessionFile).toBe(oldDead);
		expect(registry.get("AdvisorTwin")?.kind).toBe("advisor");
		expect(registry.get("AdvisorTwin")?.sessionFile).toBe(oldAdvisor);
		expect(registry.get("VibeKid")?.sessionFile).toBe(oldVibe);
		expect(registry.get("Outer")?.sessionFile).toBe(path.join(dir, "current", "Outer.jsonl"));
		expect(registry.get("Outer")?.activity).toContain("outer-visible-task");
		expect(registry.get("Outer")?.activity).not.toContain("nested-steal-task");
	});

	it("does not replace through an incomplete stub or a spawn that claims the id mid-scan", async () => {
		using tempDir = TempDir.createSync("@omp-hub-no-replace-race-");
		const dir = tempDir.path();
		const currentSession = path.join(dir, "current.jsonl");
		const oldIncomplete = path.join(dir, "old", "IncompleteTwin.jsonl");
		const oldRace = path.join(dir, "old", "RaceTwin.jsonl");
		const newRace = path.join(dir, "current", "RaceTwin.jsonl");
		await Bun.write(currentSession, `${sessionHeader("current")}\n`);
		await writeParkedTranscript(oldIncomplete, "old-incomplete", "keep-old-incomplete");
		await writeParkedTranscript(oldRace, "old-race", "keep-old-race");
		await Bun.write(path.join(dir, "current", "IncompleteTwin.jsonl"), `${sessionHeader("incomplete")}\n`);
		await writeParkedTranscript(newRace, "race", "steal-race");

		const registry = new AgentRegistry();
		const liveSession = {} as AgentSession;
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile: currentSession,
			status: "running",
		});
		const incomplete = registry.register({
			id: "IncompleteTwin",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: oldIncomplete,
			status: "parked",
		});
		const parkedRace = registry.register({
			id: "RaceTwin",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: oldRace,
			status: "parked",
		});
		const originalGet = registry.get.bind(registry);
		let injectClaim = true;
		registry.get = id => {
			const current = originalGet(id);
			if (id === "RaceTwin" && injectClaim && current === parkedRace) {
				injectClaim = false;
				queueMicrotask(() => {
					registry.unregister("RaceTwin", parkedRace);
					registry.register({
						id: "RaceTwin",
						displayName: "task",
						kind: "sub",
						session: liveSession,
						sessionFile: newRace,
						status: "running",
					});
				});
			}
			return current;
		};

		await executeList(registry, MAIN_AGENT_ID, { status: "parked" }, currentSession);
		expect(originalGet("IncompleteTwin")).toBe(incomplete);
		expect(originalGet("IncompleteTwin")?.sessionFile).toBe(oldIncomplete);
		expect(originalGet("RaceTwin")?.status).toBe("running");
		expect(originalGet("RaceTwin")?.session).toBe(liveSession);
	});

	it("keeps ensurePersistedRoster metadata-only and hydrates on a later explicit register", async () => {
		using tempDir = TempDir.createSync("@omp-hub-hydrate-later-");
		const dir = tempDir.path();
		const sessionFile = path.join(dir, "main.jsonl");
		const workerFile = path.join(dir, "main", "Worker.jsonl");
		await Bun.write(sessionFile, `${sessionHeader("main")}\n`);
		await Bun.write(
			workerFile,
			`${[
				sessionHeader("worker"),
				JSON.stringify({
					type: "session_init",
					id: "si-worker",
					parentId: null,
					timestamp: "2026-08-13T17:14:49.000Z",
					systemPrompt: "review",
					task: "hydrate later",
					tools: ["read"],
				}),
				JSON.stringify({
					type: "message",
					id: "a1",
					parentId: "si-worker",
					timestamp: "2026-08-13T17:14:50.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						provider: "anthropic",
						model: "claude-sonnet-5",
						stopReason: "stop",
						usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.5 } },
					},
				}),
			].join("\n")}\n`,
		);

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});
		await ensurePersistedRoster(registry, sessionFile);
		expect(registry.get("Worker")?.sessionFile).toBe(workerFile);
		expect(registry.get("Worker")?.history?.metrics).toBeUndefined();

		await registerPersistedSubagents(registry, sessionFile);
		expect(registry.get("Worker")?.history?.metrics?.tokens).toBe(30);
		expect(registry.get("Worker")?.history?.metrics?.requests).toBe(1);
	});
});

describe("child system prompt roster", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	it("enumerates running+idle peers and one parked count, never parked names or task labels", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			status: "running",
		});
		registry.register({
			id: "LiveWorker",
			displayName: "implementer",
			kind: "sub",
			session: null,
			status: "running",
			activity: "editing auth.ts",
		});
		registry.register({
			id: "IdleReviewer",
			displayName: "reviewer",
			kind: "sub",
			session: null,
			status: "idle",
		});
		registry.register({
			id: "ParkedScout",
			displayName: "secret parked label",
			kind: "sub",
			session: null,
			status: "parked",
			activity: "reviewing classified.diff",
		});
		registry.register({
			id: `${MAIN_AGENT_ID}/advisor`,
			displayName: "advisor",
			kind: "advisor",
			session: null,
			status: "parked",
			activity: "advisor-only gist",
		});

		const text = await renderIrcPeerRoster("Child");
		expect(text).toContain("LiveWorker");
		expect(text).toContain("editing auth.ts");
		expect(text).toContain("IdleReviewer");
		expect(text).toContain("1 parked peer(s) omitted");
		expect(text).toContain('status:"parked"');
		expect(text).toContain("history://");
		expect(text).toContain("agent://");
		expect(text).not.toContain("ParkedScout");
		expect(text).not.toContain("secret parked label");
		expect(text).not.toContain("reviewing classified.diff");
		expect(text).not.toContain("advisor-only gist");
	});

	it("counts a disk-only parked sibling from the root tree without naming it", async () => {
		using tempDir = TempDir.createSync("@omp-hub-roster-live-disk-");
		const dir = tempDir.path();
		const sessionFile = path.join(dir, "main.jsonl");
		const liveSessionFile = path.join(dir, "main", "LiveWorker.jsonl");
		const parkedSessionFile = path.join(dir, "main", "ParkedScout.jsonl");
		await Bun.write(sessionFile, `${sessionHeader("main")}\n`);
		await writeParkedTranscript(parkedSessionFile, "parked", "reviewing classified.diff");

		const registry = AgentRegistry.global();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});
		registry.register({
			id: "LiveWorker",
			displayName: "task",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: liveSessionFile,
			status: "idle",
		});

		const text = await renderIrcPeerRoster("LiveWorker", registry);
		expect(text).toContain("1 parked peer(s) omitted");
		expect(text).toContain("`Main`");
		expect(text).not.toContain("ParkedScout");
		expect(text).not.toContain("reviewing classified.diff");
	});

	it("bounds live rows at the default hub list limit, keeping running peers and the newest activity first", async () => {
		const registry = AgentRegistry.global();
		const extra = 5;
		for (let index = 0; index < DEFAULT_HUB_LIST_LIMIT + extra; index++) {
			registry.register({
				id: `Idle${index}`,
				displayName: "task",
				kind: "sub",
				session: null,
				status: "idle",
				lastActivity: index,
			});
		}
		// A running peer sorts above every idle sibling regardless of age (hub
		// list semantics), so it survives the cap despite the oldest activity.
		registry.register({
			id: "Runner",
			displayName: "task",
			kind: "sub",
			session: null,
			status: "running",
			lastActivity: 0,
		});

		const text = await renderIrcPeerRoster("Child", registry);
		// Newest idle activity sorts first, so the cap keeps Idle36..Idle6 and
		// omits the six oldest idle rows (Idle5..Idle0). Row tokens carry the
		// backtick boundary so e.g. Idle1 never matches the retained Idle10..Idle19.
		for (let index = extra + 1; index < DEFAULT_HUB_LIST_LIMIT + extra; index++) {
			expect(text).toContain(`- \`Idle${index}\` —`);
		}
		for (let index = 0; index <= extra; index++) {
			expect(text).not.toContain(`- \`Idle${index}\` —`);
		}
		expect(text).toContain("- `Runner` —");
		expect(text).toContain(`${extra + 1} more live peer(s) omitted`);
		expect(text).not.toContain("parked peer(s) omitted");
	});
});
describe("hub direct addressing refreshes the caller root without a prior list", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	/** Transcript with a distinguishable user line: header + session_init + message. */
	async function writeTranscriptWithLine(sessionFile: string, id: string, secret: string): Promise<void> {
		await Bun.write(
			sessionFile,
			`${[
				sessionHeader(id),
				JSON.stringify({
					type: "session_init",
					id: `si-${id}`,
					parentId: null,
					timestamp: "2026-08-13T17:14:49.000Z",
					systemPrompt: "review",
					task: `task-${secret}`,
					tools: ["read"],
				}),
				JSON.stringify({
					type: "message",
					id: `m-${id}`,
					parentId: null,
					timestamp: "2026-08-13T17:14:50.000Z",
					message: { role: "user", content: `secret-${secret}-line`, timestamp: 1 },
				}),
			].join("\n")}\n`,
		);
	}

	/** Directory a roster scan reads for a root (`<sessionFile>` minus `.jsonl`). */
	function scanDir(sessionFile: string): string {
		return sessionFile.slice(0, -".jsonl".length);
	}

	function countReaddirs(readdirs: string[], dir: string): number {
		return readdirs.filter(target => target === dir).length;
	}

	/** Spy on `fs.promises.readdir`, recording each scanned directory. */
	function spyOnReaddirs(readdirs: string[]): void {
		const realReaddir = fs.promises.readdir;
		spyOn(fs.promises, "readdir").mockImplementation((async (target: fs.PathLike) => {
			readdirs.push(String(target));
			return realReaddir(target, { withFileTypes: true });
		}) as unknown as typeof fs.promises.readdir);
	}

	function fakeRevivedSession(delivered: string[]): AgentSession {
		return {
			isStreaming: false,
			messages: [],
			deliverIrcMessage: async (msg: { body: string }) => {
				delivered.push(msg.body);
				return "woken";
			},
		} as unknown as AgentSession;
	}

	it("direct send, history://, and agent:// target the caller root's parked Worker without a prior list (A→B→A)", async () => {
		using tempDir = TempDir.createSync("@omp-hub-direct-root-");
		const dir = tempDir.path();
		const rootA = path.join(dir, "a", "main.jsonl");
		const rootB = path.join(dir, "b", "main.jsonl");
		const childA = path.join(dir, "a", "main", "Worker.jsonl");
		const childB = path.join(dir, "b", "main", "Worker.jsonl");
		const artifactA = path.join(dir, "a", "main", "Worker.md");
		const artifactB = path.join(dir, "b", "main", "Worker.md");
		await Bun.write(rootA, `${sessionHeader("a")}\n`);
		await Bun.write(rootB, `${sessionHeader("b")}\n`);
		await writeTranscriptWithLine(childA, "worker", "A");
		await writeTranscriptWithLine(childB, "worker", "B");
		await Bun.write(artifactA, "A OUTPUT");
		await Bun.write(artifactB, "B OUTPUT");

		const registry = AgentRegistry.global();
		const readdirs: string[] = [];
		spyOnReaddirs(readdirs);
		try {
			// B's scan runs first and restores the shared id: the process-global
			// Worker ref points at B's transcript (and B's artifacts dir wins the
			// agent:// scan before A's session is even registered).
			await ensurePersistedRoster(registry, rootB);
			expect(registry.get("Worker")?.sessionFile).toBe(childB);
			expect(countReaddirs(readdirs, scanDir(rootB))).toBe(1);
			registry.register({
				id: MAIN_AGENT_ID,
				displayName: MAIN_AGENT_ID,
				kind: "main",
				session: null,
				sessionFile: rootA,
				status: "running",
			});

			// history://Worker without a list refreshes A's root and reads A's
			// transcript — the stale B ref is replaced before the lookup.
			const history = await new HistoryProtocolHandler().resolve(parseInternalUrl("history://Worker"), {
				sessionFile: rootA,
			});
			expect(history.sourcePath).toBe(childA);
			expect(history.content).toContain("secret-A-line");
			expect(history.content).not.toContain("secret-B-line");
			expect(registry.get("Worker")?.sessionFile).toBe(childA);
			expect(countReaddirs(readdirs, scanDir(rootA))).toBe(1);

			// agent://Worker resolves A's output artifact through the same refresh.
			// Its own readdir goes through the `node:fs/promises` binding, which
			// the roster-scan spy does not intercept: the roster count stays put,
			// proving the refresh did not re-scan A's tree.
			const artifact = await new AgentProtocolHandler().resolve(parseInternalUrl("agent://Worker"), {
				sessionFile: rootA,
			});
			expect(artifact.content).toBe("A OUTPUT");
			expect(artifact.sourcePath).toBe(artifactA);
			expect(countReaddirs(readdirs, scanDir(rootA))).toBe(1);

			// A direct send without a prior list revives A's parked Worker: the
			// refreshed ref is what the cold revive (persisted-subagent factory)
			// and the bus delivery are bound to.
			let delivered: string[] = [];
			AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
				async () => async () => fakeRevivedSession(delivered),
				0,
			);
			const sent = await executeSend(
				{ registry, senderId: MAIN_AGENT_ID, settings: Settings.isolated(), sessionFileHint: rootA },
				{ to: "Worker", message: "wake A" },
			);
			expect(sent.isError).toBeFalsy();
			expect(sent.details?.receipts).toEqual([{ to: "Worker", outcome: "revived" }]);
			expect(delivered).toEqual(["wake A"]);
			expect(registry.get("Worker")?.sessionFile).toBe(childA);
			expect(countReaddirs(readdirs, scanDir(rootA))).toBe(1);

			// A repeated direct send stays on the settled latch — no re-scan.
			const again = await executeSend(
				{ registry, senderId: MAIN_AGENT_ID, settings: Settings.isolated(), sessionFileHint: rootA },
				{ to: "Worker", message: "wake A again" },
			);
			expect(again.isError).toBeFalsy();
			expect(again.details?.receipts?.[0]?.to).toBe("Worker");
			expect(delivered).toEqual(["wake A", "wake A again"]);
			expect(registry.get("Worker")?.sessionFile).toBe(childA);
			expect(countReaddirs(readdirs, scanDir(rootA))).toBe(1);

			// A's revived Worker parks again (session detached, ref retained) —
			// the state a real idle-TTL park leaves behind.
			registry.unregister("Worker");
			registry.register({
				id: "Worker",
				displayName: "task",
				kind: "sub",
				session: null,
				sessionFile: childA,
				status: "parked",
			});

			// history://Worker from B refreshes B's superseded root and reads B's
			// transcript while the ref is still parked.
			const historyB = await new HistoryProtocolHandler().resolve(parseInternalUrl("history://Worker"), {
				sessionFile: rootB,
			});
			expect(historyB.sourcePath).toBe(childB);
			expect(historyB.content).toContain("secret-B-line");
			expect(historyB.content).not.toContain("secret-A-line");
			// B's latch was superseded by A's re-scan; the history refresh re-scans
			// B exactly once.
			expect(countReaddirs(readdirs, scanDir(rootB))).toBe(2);
			expect(countReaddirs(readdirs, scanDir(rootA))).toBe(1);

			// Reversed: B's direct send (settled latch — no re-scan) revives B's
			// Worker.
			const deliveredB: string[] = [];
			delivered = deliveredB;
			const sentB = await executeSend(
				{ registry, senderId: MAIN_AGENT_ID, settings: Settings.isolated(), sessionFileHint: rootB },
				{ to: "Worker", message: "wake B" },
			);
			expect(sentB.isError).toBeFalsy();
			expect(sentB.details?.receipts).toEqual([{ to: "Worker", outcome: "revived" }]);
			expect(deliveredB).toEqual(["wake B"]);
			expect(registry.get("Worker")?.sessionFile).toBe(childB);
			expect(countReaddirs(readdirs, scanDir(rootB))).toBe(2);
			expect(countReaddirs(readdirs, scanDir(rootA))).toBe(1);
		} finally {
			spyOn(fs.promises, "readdir").mockRestore();
		}
	}, 15_000);

	it("keeps a live same-id Worker in place when the caller root refreshes", async () => {
		using tempDir = TempDir.createSync("@omp-hub-direct-live-");
		const dir = tempDir.path();
		const rootA = path.join(dir, "a", "main.jsonl");
		const childA = path.join(dir, "a", "main", "Worker.jsonl");
		await Bun.write(rootA, `${sessionHeader("a")}\n`);
		await writeTranscriptWithLine(childA, "worker", "A");

		const registry = AgentRegistry.global();
		const delivered: string[] = [];
		const liveSession = {
			isStreaming: false,
			messages: [{ role: "user", content: "live-worker-line", timestamp: 1 }],
			deliverIrcMessage: async (msg: { body: string }) => {
				delivered.push(msg.body);
				return "woken";
			},
		} as unknown as AgentSession;
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile: rootA,
			status: "running",
		});
		registry.register({
			id: "Worker",
			displayName: "task",
			kind: "sub",
			session: liveSession,
			sessionFile: childA,
			status: "running",
		});

		// The refresh scans A's tree and finds the same-id transcript, but the
		// live session must never be displaced by the disk-derived parked ref.
		const sent = await executeSend(
			{ registry, senderId: MAIN_AGENT_ID, settings: Settings.isolated(), sessionFileHint: rootA },
			{ to: "Worker", message: "live ping" },
		);
		expect(sent.isError).toBeFalsy();
		expect(sent.details?.receipts).toEqual([{ to: "Worker", outcome: "woken" }]);
		expect(delivered).toEqual(["live ping"]);
		expect(registry.get("Worker")?.status).toBe("running");
		expect(registry.get("Worker")?.session).toBe(liveSession);
		expect(registry.get("Worker")?.sessionFile).toBe(childA);

		const history = await new HistoryProtocolHandler().resolve(parseInternalUrl("history://Worker"), {
			sessionFile: rootA,
		});
		expect(history.notes?.join("\n")).toContain("live session");
		expect(history.content).toContain("live-worker-line");
		expect(registry.get("Worker")?.status).toBe("running");
		expect(registry.get("Worker")?.session).toBe(liveSession);
	});

	it("stays graceful when the caller root or target id is unavailable", async () => {
		using tempDir = TempDir.createSync("@omp-hub-direct-missing-");
		const dir = tempDir.path();
		const rootB = path.join(dir, "b", "main.jsonl");
		const childB = path.join(dir, "b", "main", "Worker.jsonl");
		await Bun.write(rootB, `${sessionHeader("b")}\n`);
		await writeTranscriptWithLine(childB, "worker", "B");
		const registry = AgentRegistry.global();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile: rootB,
			status: "running",
		});
		registry.register({
			id: "Worker",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: childB,
			status: "parked",
		});
		// The caller session file points at a root that does not exist on disk.
		const missingRoot = path.join(dir, "missing", "main.jsonl");

		// history:// with an unavailable caller root keeps the in-memory ref.
		const history = await new HistoryProtocolHandler().resolve(parseInternalUrl("history://Worker"), {
			sessionFile: missingRoot,
		});
		expect(history.sourcePath).toBe(childB);
		expect(history.content).toContain("secret-B-line");

		// A send with an unresolvable caller root still delivers (in-memory refs).
		const delivered: string[] = [];
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			async () => async () => fakeRevivedSession(delivered),
			0,
		);
		const sent = await executeSend(
			{ registry, senderId: MAIN_AGENT_ID, settings: Settings.isolated(), sessionFileHint: missingRoot },
			{ to: "Worker", message: "wake in-memory" },
		);
		expect(sent.isError).toBeFalsy();
		expect(sent.details?.receipts).toEqual([{ to: "Worker", outcome: "revived" }]);
		expect(delivered).toEqual(["wake in-memory"]);

		// Unknown ids still fail with the same guided error, and sends to them
		// still produce a failed receipt — never a throw.
		const error = await new HistoryProtocolHandler()
			.resolve(parseInternalUrl("history://Nope"), { sessionFile: missingRoot })
			.then(
				() => null,
				err => err as Error,
			);
		expect(error).toBeInstanceOf(Error);
		expect(error?.message).toContain("Unknown agent: Nope");
		const unknown = await executeSend(
			{ registry, senderId: MAIN_AGENT_ID, settings: Settings.isolated(), sessionFileHint: missingRoot },
			{ to: "Nope", message: "hello?" },
		);
		expect(unknown.isError).toBeTruthy();
		expect(unknown.details?.receipts?.[0]?.outcome).toBe("failed");
	});
});
