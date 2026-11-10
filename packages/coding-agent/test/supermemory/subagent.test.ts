import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { supermemoryBackend } from "@oh-my-pi/pi-coding-agent/supermemory/backend";
import type { SupermemorySessionState } from "@oh-my-pi/pi-coding-agent/supermemory/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { MemoryEditTool } from "@oh-my-pi/pi-coding-agent/tools/memory-edit";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import { MemoryRetainTool } from "@oh-my-pi/pi-coding-agent/tools/memory-retain";
import { TempDir } from "@oh-my-pi/pi-utils";

const ENV = ["SUPERMEMORY_API_KEY", "SUPERMEMORY_BASE_URL"] as const;
const savedEnv = new Map(ENV.map(name => [name, Bun.env[name]]));

interface WireRequest {
	method: string;
	path: string;
	body: Record<string, unknown>;
}

let temp: TempDir;
let server: Bun.Server<undefined>;
let requests: WireRequest[];

beforeEach(() => {
	temp = TempDir.createSync("@supermemory-subagent-test-");
	requests = [];
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			const body = (await request.json()) as Record<string, unknown>;
			requests.push({ method: request.method, path: pathname, body });
			if (pathname === "/v3/documents") return Response.json({ error: "unavailable" }, { status: 503 });
			if (pathname === "/v4/search") return Response.json({ results: [{ id: "m1", memory: "uses bun" }] });
			return Response.json({ id: "m1" });
		},
	});
	Bun.env.SUPERMEMORY_API_KEY = "sm-synthetic-subagent-key";
	Bun.env.SUPERMEMORY_BASE_URL = server.url.origin;
});

afterEach(async () => {
	server.stop(true);
	for (const [name, value] of savedEnv) {
		if (value === undefined) delete Bun.env[name];
		else Bun.env[name] = value;
	}
	await temp.remove();
});

/** A session at `cwd` with its own agent dir, notices and listeners. */
async function startSession(name: string, cwd: string, taskDepth: number, parent?: SupermemorySessionState) {
	const notices: string[] = [];
	const entries: SessionEntry[] = [];
	const listeners = new Set<AgentSessionEventListener>();
	const agentDir = path.join(temp.path(), name);
	let state: SupermemorySessionState | undefined;
	const settings = Settings.isolated({ "memory.backend": "supermemory", "supermemory.retainEveryNTurns": 1 });
	const session = {
		sessionId: name,
		settings,
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			appendCustomEntry: () => "",
			getCwd: () => cwd,
			getSessionId: () => `${name}-transcript`,
		},
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emitNotice: (_level: string, message: string) => notices.push(message),
		getXdevToolEntries: () => [],
		getSupermemorySessionState: () => state,
		setSupermemorySessionState(next: SupermemorySessionState | undefined) {
			const previous = state;
			state = next;
			return previous;
		},
	};
	await supermemoryBackend.start({
		session: session as never,
		settings,
		modelRegistry: {} as never,
		agentDir,
		taskDepth,
		parentSupermemorySessionState: parent,
	});
	const started = state;
	if (!started) throw new Error(`${name}: Supermemory state was not installed`);
	const tools = { settings, getSupermemorySessionState: () => state } as unknown as ToolSession;
	return {
		session,
		state: started,
		notices,
		agentDir,
		listeners,
		retain: new MemoryRetainTool(tools),
		recall: new MemoryRecallTool(tools),
		edit: new MemoryEditTool(tools),
	};
}

async function outboxFiles(agentDir: string): Promise<string[]> {
	try {
		const names = await fs.readdir(path.join(agentDir, "supermemory-outbox"), { recursive: true });
		return names.filter(name => name.endsWith(".json"));
	} catch {
		return [];
	}
}

describe("Supermemory subagent alias", () => {
	it("routes a child's recall, retain and memory_edit to the parent's container, outbox and notices", async () => {
		const parent = await startSession("parent", "/tmp", 0);
		parent.state.lastRecallSnippet = "<supermemory>parent recall</supermemory>";
		// A child in another directory would resolve another container on its own.
		const child = await startSession("child", temp.path(), 1, parent.state);
		const tag = parent.state.containerTag;
		expect(child.state.containerTag).toBe(tag);

		const recalled = await child.recall.execute("recall", { query: "bun" });
		expect(recalled.content[0]).toMatchObject({ text: expect.stringContaining("uses bun (id: m1)") });
		await child.edit.execute("edit", { op: "forget", id: "m1" });
		await child.retain.execute("retain", { items: [{ content: "child fact" }] });
		await parent.state.drainOutbox();

		// The drain may retry the undelivered document; each distinct request counts once.
		const sent = new Set(requests.map(request => `${request.method} ${request.path} ${request.body.containerTag}`));
		expect([...sent]).toEqual([`POST /v4/search ${tag}`, `DELETE /v4/memories ${tag}`, `POST /v3/documents ${tag}`]);
		expect(requests[2]?.body).toMatchObject({ content: "child fact", metadata: { source: "coding-agent-retain" } });
		// One destination: the undelivered write waits in the parent's outbox, reported to the parent.
		expect(await outboxFiles(parent.agentDir)).toHaveLength(1);
		expect(await outboxFiles(child.agentDir)).toEqual([]);
		expect(parent.notices.join(" ")).toContain("1 memory kept in the Supermemory outbox");
		expect(child.notices).toEqual([]);
		await parent.state.dispose();
	});

	it("never auto-recalls or auto-retains in a child, and shows the parent's recall snippet", async () => {
		const parent = await startSession("parent", "/tmp", 0);
		parent.state.lastRecallSnippet = "<supermemory>parent recall</supermemory>";
		const child = await startSession("child", "/tmp", 1, parent.state);

		expect(await supermemoryBackend.beforeAgentStartPrompt!(child.session as never, "q", undefined)).toBeUndefined();
		expect(child.listeners.size).toBe(0);
		const instructions = await supermemoryBackend.buildDeveloperInstructions(
			"/tmp",
			"/tmp",
			child.session.settings,
			child.session as never,
		);
		expect(instructions).toContain("<supermemory>parent recall</supermemory>");
		expect(requests).toEqual([]);
		await parent.state.dispose();
	});

	it("clearing or disposing a child leaves the parent's state intact", async () => {
		const parent = await startSession("parent", "/tmp", 0);
		parent.state.lastRecallSnippet = "<supermemory>parent recall</supermemory>";
		const child = await startSession("child", "/tmp", 1, parent.state);

		await supermemoryBackend.clear("/tmp", "/tmp", child.session as never);
		await child.state.dispose();
		expect(parent.state.lastRecallSnippet).toBe("<supermemory>parent recall</supermemory>");
		// The parent's outbox still accepts and reports writes.
		await parent.retain.execute("after-child", { items: [{ content: "parent fact" }] });
		await parent.state.drainOutbox();
		expect(await outboxFiles(parent.agentDir)).toHaveLength(1);
		await parent.state.dispose();
	});
});
