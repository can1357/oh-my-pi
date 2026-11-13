import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MessageChannel } from "node:worker_threads";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { HindsightApi } from "../../src/hindsight/client";
import { loadHindsightConfig } from "../../src/hindsight/config";
import { HindsightSessionState } from "../../src/hindsight/state";
import type { MnemopiBackendConfig } from "../../src/mnemopi/config";
import { loadMnemopi, loadMnemopiCore, MnemopiSessionState } from "../../src/mnemopi/state";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { SupermemoryClient } from "../../src/supermemory/client";
import { SupermemorySessionState } from "../../src/supermemory/state";
import type { MainThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { WorkerPeer } from "../../src/thread/services";
import { memoryThreadService } from "../../src/thread/services/memory";
import type { MemoryProbe, MemoryTestGlobals } from "../fixtures/memory-bridge-worker";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

function mnemopiConfig(dbPath: string): MnemopiBackendConfig {
	return {
		dbPath,
		bank: "bridge-bank",
		autoRecall: false,
		autoRetain: false,
		polyphonicRecall: false,
		enhancedRecall: false,
		proactiveLinking: false,
		retainEveryNTurns: 3,
		recallLimit: 10,
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		injectionTokenLimit: 1024,
		debug: false,
		providerOptions: { noEmbeddings: true, llm: false },
		llmMode: "none",
	};
}

describe("memory thread service", () => {
	let tempDir = "";
	let parentSession: AgentSession;
	let worker: Worker | undefined;
	let link: MainThreadLink | undefined;
	let probe: MemoryProbe;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-memory-thread-"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("bundled anthropic/claude-sonnet-4-5 missing");
		parentSession = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Parent"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			modelRegistry: new ModelRegistry(createInMemoryAuthStorage()),
		});

		const spawned = new Worker(new URL("../fixtures/memory-bridge-worker.ts", import.meta.url).href, {
			type: "module",
		});
		worker = spawned;
		const channel = new MessageChannel();
		const counter = new SharedArrayBuffer(4);
		const { promise: ready, resolve: onReady } = Promise.withResolvers<void>();
		const readyListener = (event: MessageEvent): void => {
			if (event.data?.ready) {
				spawned.removeEventListener("message", readyListener);
				onReady();
			}
		};
		spawned.addEventListener("message", readyListener);
		spawned.postMessage({ sync: channel.port2, counter }, [channel.port2]);
		await ready;
		const mainLink: MainThreadLink = new RpcLink(
			{
				send: frame => spawned.postMessage(frame),
				listen: handler => {
					const listener = (event: MessageEvent<RpcFrame>): void => handler(event.data);
					spawned.addEventListener("message", listener);
					return () => spawned.removeEventListener("message", listener);
				},
			},
			{ name: "main↔memory-fixture", syncReplies: { port: channel.port1, counter: new Int32Array(counter) } },
		);
		link = mainLink;
		mainLink.handle("ping", nonce => nonce);
		const peer: WorkerPeer = { threadId: "w1", link: mainLink };
		memoryThreadService.installMain?.(peer);
		const { promise: probed, resolve: onProbe } = Promise.withResolvers<MemoryProbe>();
		const test: MemoryTestGlobals = { ready: received => onProbe(received) };
		await mainLink.call("boot", { [memoryThreadService.name]: memoryThreadService.globals?.(peer), test });
		probe = await probed;
	}, 30_000);

	afterEach(async () => {
		link?.close("test done");
		link = undefined;
		await worker?.terminate();
		worker = undefined;
		vi.restoreAllMocks();
		await parentSession.dispose();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("routes a worker Hindsight alias's retains, bank confirmation, and recalls through main's client and bank set", async () => {
		const client = new HindsightApi({ baseUrl: "http://hindsight.invalid" });
		const createBank = vi.spyOn(client, "createBank").mockResolvedValue({});
		const retainBatch = vi.spyOn(client, "retainBatch").mockResolvedValue({});
		const recall = vi
			.spyOn(client, "recall")
			.mockResolvedValue({ results: [{ id: "m1", text: "the deploy host is alpha-7" }] });
		const banksSet = new Set<string>();
		const parent = new HindsightSessionState({
			sessionId: "parent-session",
			client,
			bankId: "main-bank",
			retainTags: ["project:alpha"],
			recallTags: ["project:alpha"],
			recallTagsMatch: "any",
			config: loadHindsightConfig(Settings.isolated({ "hindsight.apiUrl": "http://hindsight.invalid" })),
			session: parentSession,
			banksSet,
		});
		parent.lastRecallSnippet = "<memories>parent recall</memories>";

		const report = await probe.hindsightChild(parent, "worker fact", "deploy host");

		expect(report).toMatchObject({
			aliasesRemoteParent: true,
			remoteClient: true,
			remoteBankSet: true,
			bankId: "main-bank",
		});
		// The bank was confirmed once, in main's set, through main's client.
		expect(createBank).toHaveBeenCalledTimes(1);
		expect(createBank.mock.calls[0]?.[0]).toBe("main-bank");
		expect([...banksSet]).toEqual(["main-bank"]);
		// The alias's queued retain landed on main's client, tagged and attributed like an in-process alias.
		expect(retainBatch).toHaveBeenCalledTimes(1);
		const [bankId, items, options] = retainBatch.mock.calls[0] ?? [];
		expect(bankId).toBe("main-bank");
		expect(options).toEqual({ async: true });
		expect(items).toHaveLength(1);
		expect(items?.[0]).toMatchObject({
			content: "worker fact",
			context: "from worker",
			tags: ["project:alpha"],
			metadata: { session_id: report.childSessionId },
		});
		expect(items?.[0]?.timestamp).toBeInstanceOf(Date);
		// Recall ran on main's client with the parent's tag filter.
		expect(recall).toHaveBeenCalledTimes(1);
		expect(recall.mock.calls[0]?.[0]).toBe("main-bank");
		expect(recall.mock.calls[0]?.[1]).toBe("deploy host");
		expect(recall.mock.calls[0]?.[2]).toMatchObject({ tags: ["project:alpha"], tagsMatch: "any" });
		expect(report.recalled).toContain("the deploy host is alpha-7");
		// The child's prompt reads the parent's live recall snippet.
		expect(report.instructions).toContain("<memories>parent recall</memories>");
		// Aliases never auto-recall or auto-retain on the parent's behalf.
		expect(parent.lastRetainedTurn).toBe(0);
		parent.dispose();
	});

	it("lands a worker Mnemopi alias's writes in main's live banks and reads them back", async () => {
		await Promise.all([loadMnemopi(), loadMnemopiCore()]);
		const parent = new MnemopiSessionState({
			sessionId: "parent-session",
			config: mnemopiConfig(path.join(tempDir, "mnemopi.db")),
			session: parentSession,
		});
		try {
			const report = await probe.mnemopiChild(parent, "the staging database lives on beta-9");

			expect(report.aliasesRemoteParent).toBe(true);
			// The write is in main's store, visible to main without any sync step.
			expect(parent.getScopedMemory(report.storedId)?.row.content).toBe("the staging database lives on beta-9");
			expect(report.readBack).toBe("the staging database lives on beta-9");
			expect(report.recalledIds).toContain(report.storedId);
			expect(report.workingCount).toBe(1);

			// An edit from the worker mutates main's row.
			expect(await probe.mnemopiForget(report.storedId)).toBe("deleted");
			expect(parent.getScopedMemory(report.storedId)).toBeNull();
		} finally {
			await parent.dispose({ consolidate: false });
		}
	});

	it("lands a worker Supermemory alias's retain in main's outbox, maps a remote per-id forget error, and previews and reads through main", async () => {
		const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
		using server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const { pathname } = new URL(request.url);
				const body = (request.method === "GET" ? {} : await request.json()) as Record<string, unknown>;
				requests.push({ method: request.method, path: pathname, body });
				// Documents stay undelivered so the write is observable in the outbox; forgets find nothing.
				if (pathname.endsWith("/document")) return Response.json({}, { status: 503 });
				if (pathname.endsWith("/memories/semantic")) {
					return Response.json({ count: 1, matches: [{ id: "mem-9", memory: "old build on 9000" }], errors: [] });
				}
				if (pathname.endsWith("/memories/mem-1")) {
					return Response.json({
						id: "mem-1",
						memory: "build on 9100",
						metadata: {},
						isStatic: false,
						isInference: false,
						isLatest: true,
						isForgotten: false,
						version: 2,
						system: { createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" },
						included: {
							related: { parents: [{ id: "mem-0", memory: "build on 9000" }], children: [], siblings: [] },
						},
					});
				}
				if (pathname.endsWith("/memories/missing"))
					return Response.json({ error: "Memory not found" }, { status: 404 });
				return Response.json({ count: 0, matches: [], errors: [{ id: "missing", error: "Memory not found" }] });
			},
		});
		const notices: string[] = [];
		vi.spyOn(parentSession, "emitNotice").mockImplementation((_level, message) => {
			notices.push(message);
		});
		const apiKey = "sm-synthetic-bridge-key";
		const parent = new SupermemorySessionState({
			session: parentSession,
			client: new SupermemoryClient(server.url.origin, apiKey),
			config: {
				baseUrl: server.url.origin,
				apiKey,
				namespace: undefined,
				scoping: "global",
				autoRecall: false,
				autoRetain: false,
				retainEveryNTurns: 1,
				recallLimit: 5,
				threshold: 0.5,
				searchMode: "hybrid",
			},
			namespace: "omp-global",
			automatic: true,
			agentDir: tempDir,
		});
		try {
			const report = await probe.supermemoryChild(parent, "worker fact");
			await parent.drainOutbox();

			expect(report).toEqual({
				aliasesRemoteParent: true,
				namespace: "omp-global",
				retained: "1 memory queued.",
				editError: "Memory missing was not found in namespace omp-global.",
				previewed: expect.stringContaining("- old build on 9000 (id: mem-9)"),
				updated: expect.stringContaining("HTTP 503"),
				memoryRead: "build on 9100 <- mem-0",
				missingStatus: 404,
			});
			// Delivery runs in the background and the drain retries it, so dedupe and ignore order.
			const sent = new Set(requests.map(request => `${request.method} ${request.path}`));
			expect([...sent].sort()).toEqual([
				"DELETE /ns/omp-global/memories",
				"DELETE /ns/omp-global/memories/semantic",
				"GET /ns/omp-global/memories/mem-1",
				"GET /ns/omp-global/memories/missing",
				"POST /ns/omp-global/document",
			]);
			expect(requests.find(request => request.path.endsWith("/semantic"))?.body).toEqual({
				query: "old build",
				dryRun: true,
			});
			expect(requests.find(request => request.body.content === "worker fact")?.body).toMatchObject({
				content: "worker fact",
				metadata: { source: "coding-agent-retain" },
			});
			// A worker child's correction still asks for instant processing once it reaches main.
			expect(requests.find(request => request.body.content === "build on 9200")?.body).toMatchObject({
				dreaming: "instant",
			});
			// The undelivered write waits in main's outbox, reported on the parent session.
			const files = await fs.readdir(path.join(tempDir, "supermemory-outbox"), { recursive: true });
			expect(files.filter(name => name.endsWith(".json"))).toHaveLength(1);
			expect(notices.join(" ")).toContain("1 memory kept in the Supermemory outbox");
		} finally {
			await parent.dispose();
		}
	});
});
