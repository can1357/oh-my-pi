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
});
