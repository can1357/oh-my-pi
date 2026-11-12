import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { hindsightBackend } from "../src/hindsight/backend";
import { HindsightApi } from "../src/hindsight/client";
import { loadHindsightConfig } from "../src/hindsight/config";
import type { OutboxEvent } from "../src/hindsight/outbox";
import { HindsightSessionState } from "../src/hindsight/state";
import type { AgentSession, AgentSessionEventListener } from "../src/session/agent-session";
import type { ToolSession } from "../src/tools";
import { MemoryRetainTool } from "../src/tools/memory-retain";
import * as atomicFile from "../src/utils/atomic-file";

interface WireItem {
	document_id: string;
	content: string;
	tags?: string[];
	timestamp: string;
	update_mode: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

let temp: TempDir;
let requests: WireItem[][];
let accepted: WireItem[];
let status: number | ((items: WireItem[]) => number);
let gate: Promise<void> | undefined;
let onRequest: (() => void) | undefined;
let server: Bun.Server<undefined>;
const states: HindsightSessionState[] = [];

beforeEach(() => {
	temp = TempDir.createSync("@hindsight-outbox-test-");
	requests = [];
	accepted = [];
	status = 202;
	gate = undefined;
	onRequest = undefined;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method === "PUT") return Response.json({});
			const body = (await request.json()) as { items: WireItem[] };
			requests.push(body.items);
			onRequest?.();
			if (gate) await gate;
			const code = typeof status === "function" ? status(body.items) : status;
			if (code < 300) accepted.push(...body.items);
			return Response.json({ operation_id: "op" }, { status: code });
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
		...overrides,
	});
	vi.spyOn(settings, "getAgentDir").mockReturnValue(temp.path());
	const notices: string[] = [];
	let current: HindsightSessionState | undefined;
	const session = {
		sessionId,
		settings,
		sessionManager: { getCwd: () => "/projects/alpha", getEntries: () => [] },
		getHindsightSessionState: () => current,
		setHindsightSessionState: (next: HindsightSessionState | undefined) => {
			const previous = current;
			current = next;
			if (next) states.push(next);
			return previous;
		},
		emitNotice: (_level: string, message: string) => notices.push(message),
		subscribe: (_listener: AgentSessionEventListener) => () => {},
		refreshBaseSystemPrompt: async () => {},
	};
	const config = loadHindsightConfig(settings);
	const state = new HindsightSessionState({
		agentDir: temp.path(),
		sessionId,
		config,
		bankId: "test",
		retainTags: ["project:alpha"],
		client: new HindsightApi({ baseUrl: config.hindsightApiUrl!, timeouts: { retain: 1000 } }),
		banksSet: new Set(),
		session: session as unknown as AgentSession,
	});
	session.setHindsightSessionState(state);
	const toolSession = { settings, getHindsightSessionState: () => state } as ToolSession;
	return { state, settings, session, notices, tool: new MemoryRetainTool(toolSession) };
}

const outboxDir = () => path.join(temp.path(), "hindsight-outbox");
const quarantineDir = () => path.join(outboxDir(), "quarantine");

/** Undelivered event files, across destinations, with their paths. */
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

async function events(): Promise<OutboxEvent[]> {
	return Promise.all((await eventFiles()).map(file => Bun.file(file).json()));
}

async function age(file: string, ms: number): Promise<void> {
	const then = new Date(Date.now() - ms);
	await fs.utimes(file, then, then);
}

function eventWithContent(pending: OutboxEvent[], content: string): OutboxEvent {
	const event = pending.find(candidate => candidate.content === content);
	if (!event) throw new Error(`Expected an outbox event containing ${content}`);
	return event;
}

describe("Hindsight retain outbox", () => {
	it("persists a sanitized private event before acknowledging, without contacting the API", async () => {
		const { tool } = fixture({ "hindsight.apiToken": "test-sensitive-bearer" });
		const result = await tool.execute("call-1", {
			items: [{ content: "A fact\u001b[31m with test-sensitive-bearer", context: "review" }],
		});
		expect(result.content[0]).toEqual({ type: "text", text: "1 memory queued." });
		expect(requests).toHaveLength(0);
		const [file] = await eventFiles();
		const raw = await Bun.file(file).text();
		expect(raw).not.toContain("\u001b");
		expect(raw).not.toContain("test-sensitive-bearer");
		if (process.platform !== "win32") {
			expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
			expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		}
	});

	it("keeps a failed delivery and sends it from the next primary session with its document id and time", async () => {
		const first = fixture();
		await first.tool.execute("call-failure", { items: [{ content: "survives process exit" }] });
		const [original] = await events();
		status = 503;
		await first.state.flushRetainQueue();
		expect(await events()).toHaveLength(1);
		expect(first.notices.join(" ")).toContain("1 memory kept in the Hindsight outbox");
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
		await next.session.getHindsightSessionState()!.flushRetainQueue();
		expect(accepted).toHaveLength(1);
		expect(accepted[0].document_id).toBe(original.id);
		expect(accepted[0].update_mode).toBe("replace");
		expect(Date.parse(accepted[0].timestamp)).toBe(Date.parse(original.timestamp));
		expect(await events()).toHaveLength(0);
	});

	it("deduplicates a retried call, but not a distinct call or a reused call id with new content", async () => {
		const { tool, state } = fixture();
		const args = { items: [{ content: "same fact" }] };
		await tool.execute("call-duplicate", args);
		await tool.execute("call-duplicate", args);
		expect(await events()).toHaveLength(1);
		await state.flushRetainQueue();
		await tool.execute("call-duplicate", args);
		await tool.execute("call-distinct", args);
		// Provider tool call ids are not guaranteed unique: a reused id with new content
		// must neither be dropped nor replace the delivered memory.
		await tool.execute("call-duplicate", { items: [{ content: "different fact" }] });
		await state.flushRetainQueue();
		expect(accepted).toHaveLength(4);
		expect(new Set(accepted.map(item => item.document_id)).size).toBe(3);
	});

	it("sends each captured tag set in its own request, global memories untagged", async () => {
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

	it("rejects a call that would overflow the outbox without writing any of it", async () => {
		const { tool } = fixture();
		await tool.execute("first", { items: [{ content: "kept" }] });
		const dir = path.dirname((await eventFiles())[0]);
		await Promise.all(
			Array.from({ length: 998 }, (_, index) =>
				Bun.write(path.join(dir, `omp-retain-${index.toString(16).padStart(32, "0")}.json`), "{}"),
			),
		);
		await expect(
			tool.execute("overflow", { items: [{ content: "extra" }, { content: "too many" }] }),
		).rejects.toThrow(/outbox full/);
		expect(await eventFiles()).toHaveLength(999);
		await tool.execute("last-slot", { items: [{ content: "fits" }] });
		expect(await eventFiles()).toHaveLength(1000);
	});

	it("quarantines only the item a refused batch was refused for, and never resends it", async () => {
		status = items => (items.some(item => item.content === "invalid server input") ? 422 : 202);
		const { tool, state, notices } = fixture();
		await tool.execute("mixed", { items: [{ content: "valid memory" }, { content: "invalid server input" }] });
		const refused = (await events()).find(event => event.content === "invalid server input")!;
		await state.flushRetainQueue();
		expect(accepted.map(item => item.content)).toEqual(["valid memory"]);
		expect(await events()).toHaveLength(0);
		expect(await fs.readdir(quarantineDir())).toEqual([`${refused.id}.json`]);
		expect(notices.join(" ")).toContain("1 Hindsight memory moved to");
		const sent = requests.length;
		await state.flushRetainQueue();
		expect(requests).toHaveLength(sent);
	});

	it("keeps an auth failure for retry and delivers it once the server accepts", async () => {
		status = 401;
		const { tool, state } = fixture();
		await tool.execute("auth-outage", { items: [{ content: "kept through an expired token" }] });
		await state.flushRetainQueue();
		expect(await events()).toHaveLength(1);
		status = 202;
		await state.flushRetainQueue();
		expect(accepted.map(item => item.content)).toEqual(["kept through an expired token"]);
		expect(await events()).toHaveLength(0);
	});

	it("keeps delivery and quarantine notices when a reviewed file disappears during cleanup", async () => {
		status = 400;
		const { tool, state, notices } = fixture();
		await tool.execute("old-refusals", {
			items: [{ content: "first expired refusal" }, { content: "second expired refusal" }],
		});
		const pending = await events();
		const expired = ["first expired refusal", "second expired refusal"].map(content =>
			eventWithContent(pending, content),
		);
		await state.flushRetainQueue();
		const expiredFiles = expired.map(event => path.join(quarantineDir(), `${event.id}.json`));
		for (const file of expiredFiles) await age(file, 31 * DAY_MS);

		status = items => (items.some(item => item.content === "new refusal") ? 400 : 202);
		await tool.execute("mixed-delivery", { items: [{ content: "valid memory" }, { content: "new refusal" }] });
		const newRefusal = eventWithContent(await events(), "new refusal");
		notices.length = 0;

		const realStat = fs.stat;
		const realRm = fs.rm;
		let vanished = false;
		vi.spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
			if (expiredFiles.includes(String(args[0])) && !vanished) {
				vanished = true;
				await realRm(args[0], { force: true });
			}
			return realStat(...args);
		}) as typeof fs.stat);

		await state.flushRetainQueue();
		expect(vanished).toBe(true);
		expect(accepted.map(item => item.content)).toEqual(["valid memory"]);
		expect(await fs.readdir(quarantineDir())).toEqual([`${newRefusal.id}.json`]);
		expect(notices.filter(notice => notice.includes("Hindsight memory moved to"))).toHaveLength(1);
		expect(notices.join(" ")).not.toContain("Hindsight outbox unavailable");
	});

	it("keeps a successful delivery when quarantine cleanup fails", async () => {
		const { tool, state, notices } = fixture();
		await tool.execute("valid-delivery", { items: [{ content: "valid memory" }] });
		const realReaddir = fs.readdir;
		vi.spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
			if (String(args[0]) === quarantineDir()) throw new Error("simulated quarantine cleanup failure");
			return realReaddir(...args);
		}) as typeof fs.readdir);

		await state.flushRetainQueue();
		expect(accepted.map(item => item.content)).toEqual(["valid memory"]);
		expect(await events()).toEqual([]);
		expect(notices).toEqual([]);
	});

	it("deletes expired quarantined events on an empty drain", async () => {
		status = 400;
		const first = fixture();
		await first.tool.execute("refused", {
			items: [{ content: "expired refused" }, { content: "recent refused" }],
		});
		const pending = await events();
		const expired = eventWithContent(pending, "expired refused");
		const recent = eventWithContent(pending, "recent refused");
		await first.state.flushRetainQueue();
		await age(path.join(quarantineDir(), `${expired.id}.json`), 31 * DAY_MS);
		await age(path.join(quarantineDir(), `${recent.id}.json`), 29 * DAY_MS);
		first.notices.length = 0;
		requests = [];
		status = 202;
		const second = fixture({}, "session-b");

		await second.state.flushRetainQueue();
		expect(await fs.readdir(quarantineDir())).toEqual([`${recent.id}.json`]);
		expect(requests).toHaveLength(0);
		expect([...first.notices, ...second.notices]).toEqual([]);
	});

	it("serializes concurrent quarantine pruning", async () => {
		status = 400;
		const first = fixture();
		const second = fixture({}, "session-b");
		await first.tool.execute("refused", { items: [{ content: "expired refused" }] });
		const expired = eventWithContent(await events(), "expired refused");
		await first.state.flushRetainQueue();
		const expiredFile = path.join(quarantineDir(), `${expired.id}.json`);
		await age(expiredFile, 31 * DAY_MS);
		first.notices.length = 0;
		requests = [];
		status = 202;

		const realStat = fs.stat;
		const realRm = fs.rm;
		const expiredRemoved = Promise.withResolvers<void>();
		let expiredStats = 0;
		vi.spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
			if (String(args[0]) === expiredFile && ++expiredStats > 1) await expiredRemoved.promise;
			return realStat(...args);
		}) as typeof fs.stat);
		vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
			try {
				return await realRm(...args);
			} finally {
				if (String(args[0]) === expiredFile) expiredRemoved.resolve();
			}
		});

		await Promise.all([first.state.flushRetainQueue(), second.state.flushRetainQueue()]);
		expect(await fs.readdir(quarantineDir())).toEqual([]);
		expect(requests).toHaveLength(0);
		expect([...first.notices, ...second.notices]).toEqual([]);
	});

	it("starts a new quarantine review period before a concurrent prune", async () => {
		const first = fixture();
		const second = fixture({}, "session-b");
		await first.tool.execute("stale-undelivered", { items: [{ content: "stale undelivered" }] });
		const stale = eventWithContent(await events(), "stale undelivered");
		const staleFile = (await eventFiles())[0];
		if (!staleFile) throw new Error("Expected the stale event file");
		await age(staleFile, 31 * DAY_MS);

		let inFlightFs = 0;
		let fsIdle = Promise.withResolvers<void>();
		const trackFs = async <T>(op: () => Promise<T>): Promise<T> => {
			inFlightFs++;
			try {
				return await op();
			} finally {
				if (--inFlightFs === 0) {
					fsIdle.resolve();
					fsIdle = Promise.withResolvers<void>();
				}
			}
		};
		const waitForIdleFs = async () => {
			for (let tick = 0; tick < 5; tick++) {
				while (inFlightFs > 0) await fsIdle.promise;
				await Promise.resolve();
			}
		};

		const realReaddir = fs.readdir;
		const realStat = fs.stat;
		const realRm = fs.rm;
		const realUtimes = fs.utimes;
		let concurrentDrain: Promise<void> | undefined;
		vi.spyOn(fs, "readdir").mockImplementation(((...args: Parameters<typeof fs.readdir>) =>
			trackFs(() => realReaddir(...args))) as typeof fs.readdir);
		vi.spyOn(fs, "stat").mockImplementation(((...args: Parameters<typeof fs.stat>) =>
			trackFs(() => realStat(...args))) as typeof fs.stat);
		vi.spyOn(fs, "rm").mockImplementation((...args) => trackFs(() => realRm(...args)));
		vi.spyOn(fs, "utimes").mockImplementation(async (...args) => {
			if (String(args[0]) === path.join(quarantineDir(), `${stale.id}.json`) && !concurrentDrain) {
				concurrentDrain = second.state.flushRetainQueue();
				await waitForIdleFs();
			}
			return realUtimes(...args);
		});

		await first.state.flushRetainQueue();
		if (!concurrentDrain) throw new Error("Expected the concurrent empty drain");
		await concurrentDrain;
		expect(await fs.readdir(quarantineDir())).toEqual([`${stale.id}.json`]);
		expect(requests).toHaveLength(0);
		expect(first.notices).toHaveLength(1);
		expect(first.notices[0]).toContain("1 Hindsight memory moved to");
		expect(second.notices).toEqual([]);
	});

	it("retries a transient failure on its own backoff timer", async () => {
		status = 503;
		vi.useFakeTimers();
		try {
			const { tool, state } = fixture();
			await tool.execute("automatic-retry", { items: [{ content: "deliver after recovery" }] });
			await state.flushRetainQueue();
			const retried = Promise.withResolvers<void>();
			onRequest = retried.resolve;
			status = 202;
			// First backoff: the 5 s debounce interval with at most +20% jitter.
			vi.advanceTimersByTime(6_000);
			await retried.promise;
			await state.flushRetainQueue();
			expect(accepted.map(item => item.content)).toEqual(["deliver after recovery"]);
			expect(await events()).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("lets one drainer send while another holds the destination", async () => {
		const release = Promise.withResolvers<void>();
		const received = Promise.withResolvers<void>();
		gate = release.promise;
		onRequest = received.resolve;
		const first = fixture();
		const second = fixture({}, "other");
		await first.tool.execute("race", { items: [{ content: "one send" }] });
		const firstDrain = first.state.flushRetainQueue();
		await received.promise;
		await second.state.flushRetainQueue();
		release.resolve();
		await firstDrain;
		expect(requests).toHaveLength(1);
		expect(await events()).toHaveLength(0);
	});

	it("delivers nothing from a multi-item call that fails midway, even to a drain running alongside it", async () => {
		const midBatch = Promise.withResolvers<void>();
		const drainerSettled = Promise.withResolvers<void>();
		const write = atomicFile.writeFileAtomically;
		vi.spyOn(atomicFile, "writeFileAtomically").mockImplementation(async (filePath, content, mode) => {
			// Park the second item's publication with the batch half-written; the
			// concurrent drain below runs to completion before the call fails and rolls back.
			if (content.includes("second of the failed batch")) {
				midBatch.resolve();
				await drainerSettled.promise;
				throw new Error("simulated outbox write failure");
			}
			return write(filePath, content, mode);
		});

		const first = fixture();
		const second = fixture({}, "session-b");
		let enqueueError: unknown;
		const enqueue = (async () => {
			try {
				await first.tool.execute("concurrent-drain-race", {
					items: [{ content: "first of the failed batch" }, { content: "second of the failed batch" }],
				});
			} catch (error) {
				enqueueError = error;
			}
		})();
		// The first item is on disk and the enqueue holds the destination's queue lock mid-batch.
		await midBatch.promise;
		const drain = second.state.flushRetainQueue();
		drain.then(
			() => drainerSettled.resolve(),
			() => drainerSettled.resolve(),
		);
		await enqueue;
		await drain;

		expect(enqueueError).toBeInstanceOf(Error);
		expect((enqueueError as Error).message).toMatch(/NOT queued/);
		expect(requests.flat().map(item => item.content)).toEqual([]);
		expect(await events()).toEqual([]);
	});

	it("quarantines malformed events, and other destinations' events only once they are 7 days old", async () => {
		const { tool, state } = fixture();
		await tool.execute("own", { items: [{ content: "moved to another destination" }] });
		const [ownFile] = await eventFiles();
		const foreignDir = path.join(outboxDir(), "0123456789abcdef");
		const foreignFile = path.join(foreignDir, path.basename(ownFile));
		await fs.mkdir(foreignDir);
		await fs.rename(ownFile, foreignFile);
		const malformed = path.join(path.dirname(ownFile), `omp-retain-${"f".repeat(32)}.json`);
		await Bun.write(malformed, "{");

		await state.flushRetainQueue();
		expect(await fs.readdir(quarantineDir())).toEqual([path.basename(malformed)]);
		expect(await eventFiles()).toEqual([foreignFile]);

		await age(foreignFile, 8 * DAY_MS);
		await state.flushRetainQueue();
		expect(await eventFiles()).toEqual([]);
		expect(requests).toHaveLength(0);
	});

	it("fails the tool call before acknowledging when the outbox is unwritable", async () => {
		await Bun.write(outboxDir(), "not a directory");
		const { tool } = fixture();
		await expect(tool.execute("unwritable", { items: [{ content: "must not vanish" }] })).rejects.toThrow();
		expect(requests).toHaveLength(0);
	});
});
