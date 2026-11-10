import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { supermemoryBackend } from "@oh-my-pi/pi-coding-agent/supermemory/backend";
import type { SupermemorySessionState } from "@oh-my-pi/pi-coding-agent/supermemory/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { MemoryRetainTool } from "@oh-my-pi/pi-coding-agent/tools/memory-retain";
import { TempDir } from "@oh-my-pi/pi-utils";

const API_KEY = "sm-synthetic-outbox-key";

interface WireDocument {
	content: string;
	customId: string;
	containerTag: string;
	metadata: Record<string, string>;
}

const ENV = ["SUPERMEMORY_API_KEY", "SUPERMEMORY_BASE_URL"] as const;
const savedEnv = new Map(ENV.map(name => [name, Bun.env[name]]));

let temp: TempDir;
let server: Bun.Server<undefined>;
let requests: WireDocument[];
let status: number;
const states: SupermemorySessionState[] = [];

beforeEach(() => {
	temp = TempDir.createSync("@supermemory-outbox-test-");
	requests = [];
	status = 200;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push((await request.json()) as WireDocument);
			return Response.json({ id: "doc", status: "queued" }, { status });
		},
	});
	Bun.env.SUPERMEMORY_API_KEY = API_KEY;
	Bun.env.SUPERMEMORY_BASE_URL = server.url.origin;
});

afterEach(async () => {
	await Promise.all(states.map(state => state.dispose()));
	states.length = 0;
	server.stop(true);
	for (const [name, value] of savedEnv) {
		if (value === undefined) delete Bun.env[name];
		else Bun.env[name] = value;
	}
	await temp.remove();
});

/** A fresh process: a new primary state on the same agent dir and transcript id. */
async function startSession() {
	const notices: string[] = [];
	const entries: SessionEntry[] = [];
	let state: SupermemorySessionState | undefined;
	const session = {
		settings: Settings.isolated({ "memory.backend": "supermemory", "supermemory.autoRetain": false }),
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			appendCustomEntry: () => "",
			getCwd: () => "/tmp",
			getSessionId: () => "transcript-1",
		},
		subscribe: () => () => {},
		emitNotice: (_level: string, message: string) => notices.push(message),
		getSupermemorySessionState: () => state,
		setSupermemorySessionState(next: SupermemorySessionState | undefined) {
			const previous = state;
			state = next;
			return previous;
		},
	};
	await supermemoryBackend.start({
		session: session as never,
		settings: session.settings,
		modelRegistry: {} as never,
		agentDir: temp.path(),
		taskDepth: 0,
	});
	const started = state!;
	states.push(started);
	const tool = new MemoryRetainTool({
		settings: session.settings,
		getSupermemorySessionState: () => started,
	} as unknown as ToolSession);
	return { state: started, notices, tool };
}

const outboxDir = () => path.join(temp.path(), "supermemory-outbox");

/** Undelivered event files across destinations. */
async function eventFiles(): Promise<string[]> {
	try {
		const names = await fs.readdir(outboxDir(), { recursive: true });
		return names
			.filter(name => /omp-retain-[a-f0-9]{32}\.json$/.test(name) && !name.startsWith("quarantine"))
			.map(name => path.join(outboxDir(), name));
	} catch {
		return [];
	}
}

describe("Supermemory retain outbox", () => {
	it("keeps a memory through a failing server and delivers it once, under one customId, from a later session", async () => {
		status = 503;
		const first = await startSession();
		const args = { items: [{ content: `durable fact with ${API_KEY}`, context: "review" }] };
		const result = await first.tool.execute("call-1", args);
		expect(result.content[0]).toEqual({ type: "text", text: "1 memory queued." });
		await first.state.drainOutbox();
		const [file] = await eventFiles();
		expect(await Bun.file(file).text()).not.toContain(API_KEY);
		// A retried tool call queues nothing new.
		await first.tool.execute("call-1", args);
		expect(await eventFiles()).toHaveLength(1);
		expect(first.notices.join(" ")).toContain("1 memory kept in the Supermemory outbox");
		await first.state.dispose();

		status = 200;
		const next = await startSession();
		await next.state.drainOutbox();
		expect(await eventFiles()).toEqual([]);
		const delivered = requests.at(-1)!;
		expect(new Set(requests.map(request => request.customId))).toEqual(new Set([delivered.customId]));
		expect(delivered.customId).toBe(path.basename(file, ".json"));
		expect(delivered.content).not.toContain(API_KEY);
		expect(delivered.metadata).toMatchObject({ source: "coding-agent-retain", context: "review" });
		const sent = requests.length;
		await next.state.drainOutbox();
		expect(requests).toHaveLength(sent);
	});

	it("quarantines a memory the server refuses and never resends it", async () => {
		status = 422;
		const { tool, state, notices } = await startSession();
		await tool.execute("refused", { items: [{ content: "invalid server input" }] });
		await state.drainOutbox();
		expect(await eventFiles()).toEqual([]);
		expect(await fs.readdir(path.join(outboxDir(), "quarantine"))).toHaveLength(1);
		expect(notices.join(" ")).toContain("1 Supermemory memory moved to");
		const sent = requests.length;
		await state.drainOutbox();
		expect(requests).toHaveLength(sent);
	});

	it("delivers a queued memory only with the API key it was queued under", async () => {
		status = 503;
		const first = await startSession();
		await first.tool.execute("call-1", { items: [{ content: "account A fact" }] });
		await first.state.drainOutbox();
		await first.state.dispose();

		status = 200;
		const sent = requests.length;
		Bun.env.SUPERMEMORY_API_KEY = "sm-synthetic-other-account";
		const other = await startSession();
		await other.state.drainOutbox();
		await other.state.dispose();
		expect(requests).toHaveLength(sent);
		expect(await eventFiles()).toHaveLength(1);

		Bun.env.SUPERMEMORY_API_KEY = API_KEY;
		const again = await startSession();
		await again.state.drainOutbox();
		expect(requests.at(-1)?.content).toBe("account A fact");
		expect(await eventFiles()).toEqual([]);
	});
});
