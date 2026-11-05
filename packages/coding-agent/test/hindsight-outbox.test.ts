import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { hindsightBackend } from "../src/hindsight/backend";
import { HindsightApi } from "../src/hindsight/client";
import { loadHindsightConfig } from "../src/hindsight/config";
import { type OutboxEvent, retainEventId } from "../src/hindsight/outbox";
import { HindsightSessionState } from "../src/hindsight/state";
import type { AgentSession, AgentSessionEventListener } from "../src/session/agent-session";
import type { ToolSession } from "../src/tools";
import { MemoryRetainTool } from "../src/tools/memory-retain";

interface WireItem {
	document_id: string;
	content: string;
	tags?: string[];
	timestamp: string;
	update_mode: string;
}
let temp: TempDir;
let requests: WireItem[][];
let status: number;
let delay: Promise<void> | undefined;
let onRequest: (() => void) | undefined;
let server: Bun.Server<undefined>;
const states: HindsightSessionState[] = [];

beforeEach(() => {
	temp = TempDir.createSync("@hindsight-outbox-test-");
	requests = [];
	status = 202;
	delay = undefined;
	onRequest = undefined;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method === "PUT") return Response.json({});
			if (request.method !== "POST") return new Response(null, { status: 404 });
			const body = (await request.json()) as { items: WireItem[] };
			requests.push(body.items);
			onRequest?.();
			if (delay) await delay;
			return Response.json({ operation_id: "accepted" }, { status });
		},
	});
});
afterEach(async () => {
	for (const state of states) state.dispose();
	states.length = 0;
	server.stop(true);
	vi.restoreAllMocks();
	await temp.remove();
});

function fixture(overrides: Record<string, unknown> = {}, sessionId = "session-a") {
	const settings = Settings.isolated({
		"memory.backend": "hindsight",
		"hindsight.apiUrl": server.url.origin,
		"hindsight.bankId": "test",
		"hindsight.globalScope": true,
		"hindsight.autoRecall": false,
		"hindsight.autoRetain": false,
		"hindsight.mentalModelsEnabled": false,
		"hindsight.retainTimeoutMs": 1000,
		...overrides,
	});
	vi.spyOn(settings, "getAgentDir").mockReturnValue(temp.path());
	let state: HindsightSessionState;
	const notices: string[] = [];
	const session = {
		sessionId,
		settings,
		sessionManager: { getCwd: () => "/projects/alpha", getEntries: () => [] },
		getHindsightSessionState: () => state,
		setHindsightSessionState: (next: HindsightSessionState | undefined) => {
			const previous = state;
			state = next!;
			if (next) states.push(next);
			return previous;
		},
		emitNotice: (_level: string, message: string) => {
			notices.push(message);
		},
		subscribe: (_listener: AgentSessionEventListener) => () => {},
		refreshBaseSystemPrompt: async () => {},
	};
	const config = loadHindsightConfig(settings);
	state = new HindsightSessionState({
		agentDir: temp.path(),
		sessionId,
		config,
		bankId: "test",
		retainTags: ["project:alpha"],
		client: new HindsightApi({ baseUrl: config.hindsightApiUrl!, timeouts: { retain: 1000 } }),
		banksSet: new Set(),
		session: session as unknown as AgentSession,
	});
	states.push(state);
	const toolSession = { settings, getHindsightSessionState: () => state } as ToolSession;
	return { state, settings, session, notices, tool: new MemoryRetainTool(toolSession) };
}

async function events(): Promise<OutboxEvent[]> {
	const dir = path.join(temp.path(), "hindsight-outbox");
	const files = await fs.readdir(dir);
	return Promise.all(files.filter(file => file.endsWith(".json")).map(file => Bun.file(path.join(dir, file)).json()));
}

describe("Hindsight durable tool delivery", () => {
	it("persists sanitized private files before acknowledging a retain without contacting the API", async () => {
		const { tool } = fixture({ "hindsight.apiToken": "test-sensitive-bearer" });
		const result = await tool.execute("call-1", {
			items: [{ content: "A fact\u001b[31m with test-sensitive-bearer", context: "review" }],
		});
		expect(requests).toHaveLength(0);
		const [event] = await events();
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("durable") });
		expect(event.eventId).toBe(retainEventId("session-a", "call-1", 0));
		expect(JSON.stringify(event)).not.toContain("test-sensitive-bearer");
		expect(event.content).not.toContain("\u001b");
		if (process.platform !== "win32") {
			expect((await fs.stat(path.join(temp.path(), "hindsight-outbox"))).mode & 0o777).toBe(0o700);
			expect((await fs.stat(path.join(temp.path(), "hindsight-outbox", `${event.eventId}.json`))).mode & 0o777).toBe(
				0o600,
			);
		}
	});

	it("keeps a failed flush and drains it at primary startup with the original document id and timestamp", async () => {
		const first = fixture();
		await first.tool.execute("call-failure", { items: [{ content: "Survives process exit" }] });
		const [original] = await events();
		status = 503;
		await first.state.flushRetainQueue();
		expect(await events()).toHaveLength(1);
		expect(first.notices.join(" ")).toMatch(/1 events kept.*outbox/);
		first.state.dispose();
		status = 202;
		const next = fixture({}, "session-b");
		await hindsightBackend.start({
			session: next.session as unknown as AgentSession,
			settings: next.settings,
			modelRegistry: undefined!,
			agentDir: temp.path(),
			taskDepth: 0,
		});
		await next.session.getHindsightSessionState().flushRetainQueue();
		expect(requests).toHaveLength(2);
		expect(requests[1][0].document_id).toBe(original.eventId);
		expect(requests[1][0].timestamp).toBe(original.timestamp);
		expect(await events()).toHaveLength(0);
	});

	it("deduplicates retried tool identities, but not distinct calls with identical content", async () => {
		const { tool, state } = fixture();
		const args = { items: [{ content: "same fact" }] };
		await tool.execute("call-duplicate", args);
		await tool.execute("call-duplicate", args);
		expect(await events()).toHaveLength(1);
		await state.flushRetainQueue();
		await tool.execute("call-duplicate", args);
		await state.flushRetainQueue();
		expect(new Set(requests.flat().map(item => item.document_id)).size).toBe(1);
		await tool.execute("call-distinct", args);
		await state.flushRetainQueue();
		expect(new Set(requests.flat().map(item => item.document_id)).size).toBe(2);
		expect(requests.flat().every(item => item.update_mode === "replace")).toBe(true);
	});

	it("keeps global and different captured project tag sets in separate requests", async () => {
		const first = fixture();
		await first.tool.execute("mixed", { items: [{ content: "project" }, { content: "global", scope: "global" }] });
		const second = fixture({}, "other");
		second.state.retainTags = ["project:beta"];
		await second.tool.execute("beta", { items: [{ content: "other project" }] });
		await first.state.flushRetainQueue();
		expect(requests).toHaveLength(3);
		const tags = Object.fromEntries(requests.flat().map(item => [item.content, item.tags]));
		expect(tags).toEqual({ project: ["project:alpha"], global: undefined, "other project": ["project:beta"] });
	});

	it("rejects a full outbox without evicting or partially accepting an oversized call", async () => {
		const first = fixture({ "hindsight.outboxMaxEvents": 2 });
		await first.tool.execute("first", { items: [{ content: "kept" }] });
		await expect(
			first.tool.execute("overflow", { items: [{ content: "extra" }, { content: "too many" }] }),
		).rejects.toThrow(/outbox full/);
		expect((await events()).map(event => event.content)).toEqual(["kept"]);
		const second = fixture({ "hindsight.outboxMaxEvents": 2 }, "other");
		const results = await Promise.allSettled([
			first.tool.execute("racer-a", { items: [{ content: "one slot" }] }),
			second.tool.execute("racer-b", { items: [{ content: "one slot" }] }),
		]);
		expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
		expect(await events()).toHaveLength(2);
	});

	it("quarantines permanent HTTP failures instead of losing or repeatedly sending them", async () => {
		status = 400;
		const { tool, state, notices } = fixture();
		await tool.execute("bad", { items: [{ content: "invalid server input" }] });
		await state.flushRetainQueue();
		expect(await events()).toHaveLength(0);
		expect(await fs.readdir(path.join(temp.path(), "hindsight-outbox/quarantine"))).toEqual([
			`${retainEventId("session-a", "bad", 0)}.json`,
		]);
		expect(notices.join(" ")).toContain("quarantine");
		await state.flushRetainQueue();
		expect(requests).toHaveLength(1);
	});

	it.each([408, 429])("keeps HTTP %s retryable and respects persisted backoff", async code => {
		status = code;
		const { tool, state } = fixture();
		await tool.execute("retry", { items: [{ content: "retry later" }] });
		await state.flushRetainQueue();
		const [event] = await events();
		expect(event.nextAttemptAt).toBeGreaterThan(Date.now());
		await state.flushRetainQueue();
		expect(requests).toHaveLength(1);
	});

	it("retries a transient failure in the same process without another tool call", async () => {
		status = 503;
		const { tool, state } = fixture();
		await tool.execute("automatic-retry", { items: [{ content: "deliver after recovery" }] });
		await state.flushRetainQueue();
		const [event] = await events();
		const retried = Promise.withResolvers<void>();
		onRequest = retried.resolve;
		status = 202;
		await retried.promise;
		await state.flushRetainQueue();
		expect(requests).toHaveLength(2);
		expect(requests[1][0].document_id).toBe(event.eventId);
		expect(await events()).toHaveLength(0);
	}, 10_000);

	it("claims once across concurrent drainers while a request is in flight", async () => {
		const pending = Promise.withResolvers<void>();
		const received = Promise.withResolvers<void>();
		onRequest = received.resolve;
		delay = pending.promise;
		const first = fixture();
		const second = fixture({}, "other");
		await first.tool.execute("race", { items: [{ content: "one send" }] });
		const drains = Promise.all([first.state.flushRetainQueue(), second.state.flushRetainQueue()]);
		await received.promise;
		pending.resolve();
		await drains;
		expect(requests).toHaveLength(1);
		expect(await events()).toHaveLength(0);
	});

	it("reclaims a stale in-flight file after a crash without changing its document id", async () => {
		const first = fixture();
		await first.tool.execute("crash", { items: [{ content: "claimed before crash" }] });
		const [event] = await events();
		const dir = path.join(temp.path(), "hindsight-outbox");
		await fs.rename(
			path.join(dir, `${event.eventId}.json`),
			path.join(dir, `${event.eventId}.inflight.999999.${Date.now() - 2000}.json`),
		);
		first.state.dispose();
		await fixture({}, "recovery").state.flushRetainQueue();
		expect(requests[0][0].document_id).toBe(event.eventId);
		expect(await events()).toHaveLength(0);
	});

	it("clears a peer's completed claim instead of repeatedly scheduling an expired lease", async () => {
		const pending = Promise.withResolvers<void>();
		const received = Promise.withResolvers<void>();
		delay = pending.promise;
		onRequest = received.resolve;
		const first = fixture();
		const second = fixture({}, "peer");
		await first.tool.execute("peer-completion", { items: [{ content: "claimed by peer" }] });
		const flush = first.state.flushRetainQueue();
		await received.promise;
		await second.state.flushRetainQueue();
		expect(second.state.retainQueue.depth).toBe(1);
		pending.resolve();
		await flush;
		await second.state.flushRetainQueue();
		expect(second.state.retainQueue.depth).toBe(0);
		expect(requests).toHaveLength(1);
	});

	it("lets only one of two independent processes send a pending event", async () => {
		const first = fixture();
		await first.tool.execute("process-race", { items: [{ content: "one process wins" }] });
		first.state.dispose();
		const command = [
			process.execPath,
			path.join(import.meta.dir, "fixtures/hindsight-outbox-drain.ts"),
			temp.path(),
			server.url.origin,
		];
		const children = [
			Bun.spawn(command, { stdout: "pipe", stderr: "pipe" }),
			Bun.spawn(command, { stdout: "pipe", stderr: "pipe" }),
		];
		const results = await Promise.all(
			children.map(async child => ({
				exit: await child.exited,
				stderr: await new Response(child.stderr).text(),
			})),
		);
		expect(results).toEqual([
			{ exit: 0, stderr: "" },
			{ exit: 0, stderr: "" },
		]);
		expect(requests).toHaveLength(1);
		expect(await events()).toHaveLength(0);
	}, 10_000);

	it("leaves another destination untouched and quarantines events older than seven days", async () => {
		const first = fixture();
		await first.tool.execute("old", { items: [{ content: "old event" }] });
		const [event] = await events();
		await fixture({ "hindsight.apiUrl": "http://127.0.0.1:1" }, "wrong-destination").state.flushRetainQueue();
		expect(requests).toHaveLength(0);
		expect(await events()).toHaveLength(1);
		event.timestamp = new Date(Date.now() - 8 * 86400000).toISOString();
		await Bun.write(path.join(temp.path(), "hindsight-outbox", `${event.eventId}.json`), JSON.stringify(event));
		await first.state.flushRetainQueue();
		expect(await events()).toHaveLength(0);
		expect(requests).toHaveLength(0);
	});

	it("fails visibly before acknowledgement when persistence is unavailable", async () => {
		await Bun.write(path.join(temp.path(), "hindsight-outbox"), "not a directory");
		const { tool } = fixture();
		await expect(tool.execute("unwritable", { items: [{ content: "must not disappear" }] })).rejects.toThrow();
		expect(requests).toHaveLength(0);
	});
});
