/**
 * `mnemopi.polyphonicRecall` and `mnemopi.enhancedRecall` must change what the
 * memory tools return, end to end: Settings -> `loadMnemopiConfig` -> per-bank
 * Mnemopi instances -> `recallEnhanced`.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import { MemoryRetainTool } from "@oh-my-pi/pi-coding-agent/tools/memory-retain";
import { TempDir } from "@oh-my-pi/pi-utils";

// Mnemopi is lazy-loaded at runtime; preload it for synchronous state construction.
const [mnemopi] = await Promise.all([loadMnemopi(), loadMnemopiCore()]);

const SESSION_ID = "recall-features-session";
const states: MnemopiSessionState[] = [];
const dirs: TempDir[] = [];

function startSession(overrides: Record<string, unknown>): { state: MnemopiSessionState; tools: ToolSession } {
	const dir = TempDir.createSync("@mnemopi-recall-features-");
	dirs.push(dir);
	const settings = Settings.isolated({
		"memory.backend": "mnemopi",
		"mnemopi.scoping": "global",
		"mnemopi.dbPath": dir.join("mnemopi.db"),
		"mnemopi.rerankApiUrl": "",
		"mnemopi.llmMode": "none",
		...overrides,
	});
	const config = loadMnemopiConfig(settings, dir.path());
	config.rerank!.apiUrl = Object.hasOwn(overrides, "mnemopi.rerankApiUrl")
		? (overrides["mnemopi.rerankApiUrl"] as string)
		: "";
	config.reranker = mnemopi.createReranker(config.rerank);
	const state = new MnemopiSessionState({
		sessionId: SESSION_ID,
		config,
		session: {
			sessionId: SESSION_ID,
			settings,
			modelRegistry: {
				getApiKeyForProvider: async () => undefined,
				resolver: () => async () => undefined,
			} as never,
			sessionManager: { getEntries: () => [], getCwd: () => dir.path() } as never,
			emitNotice: () => {},
			getHindsightSessionState: () => undefined,
			subscribe: () => () => {},
		} as never,
	});
	setMnemopiSessionState(state.session as never, state);
	states.push(state);
	const tools = {
		cwd: dir.path(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionId: () => SESSION_ID,
		getSessionSpawns: () => null,
		getHindsightSessionState: () => undefined,
		getMnemopiSessionState: () => state,
	} as unknown as ToolSession;
	return { state, tools };
}

async function retain(tools: ToolSession, ...contents: string[]): Promise<void> {
	await MemoryRetainTool.createIf(tools)!.execute("retain", { items: contents.map(content => ({ content })) });
}

async function recallText(tools: ToolSession, query: string): Promise<string> {
	const [block] = (await MemoryRecallTool.createIf(tools)!.execute("recall", { query })).content;
	if (block?.type !== "text") throw new Error("memory recall returned no text block");
	return block.text;
}

afterEach(async () => {
	for (const state of states.splice(0)) await state.dispose();
	for (const dir of dirs.splice(0)) await dir.remove();
});

describe("mnemopi.polyphonicRecall", () => {
	it("surfaces a graph-linked memory that the default recall misses", async () => {
		const texts: Record<string, string> = {};
		for (const polyphonicRecall of [false, true]) {
			const { tools } = startSession({
				"mnemopi.polyphonicRecall": polyphonicRecall,
				"mnemopi.proactiveLinking": true,
			});
			await retain(
				tools,
				"Alice owns the durable launch checklist",
				"The durable launch checklist lives in the Notion workspace",
			);
			texts[String(polyphonicRecall)] = await recallText(tools, "Alice");
		}

		expect(texts.false).toContain("Alice owns the durable launch checklist");
		expect(texts.false).not.toContain("Notion workspace");
		expect(texts.true).toContain("Alice owns the durable launch checklist");
		expect(texts.true).toContain("The durable launch checklist lives in the Notion workspace");
	});
});

describe("mnemopi.enhancedRecall", () => {
	it("reaches recallEnhanced per instance: uncached when off, one hit when on", async () => {
		for (const enhancedRecall of [false, true]) {
			const { state, tools } = startSession({ "mnemopi.enhancedRecall": enhancedRecall });
			await retain(tools, "The deploy runbook lives in the ops wiki");
			await recallText(tools, "deploy runbook");
			await recallText(tools, "deploy runbook");

			const cache = state.getScopedRecallTargets()[0].memory.beam.caches.queryCache;
			if (enhancedRecall) expect(cache?.stats()).toMatchObject({ hits: 1, misses: 1 });
			else expect(cache).toBeUndefined();
		}
	});
});

describe("mnemopi cancellation signal", () => {
	it("forwards cancellation signal to scoped recall and aborts immediately", async () => {
		const { state, tools } = startSession({});
		await retain(tools, "deploy guide on cluster A");
		const controller = new AbortController();
		controller.abort();
		const results = await state.collectScopedRecallResults("deploy", controller.signal);
		expect(results).toEqual([]);
	});
});

describe("scoped recall without reranking", () => {
	for (const polyphonic of [false, true]) {
		it(`merges the per-bank ${polyphonic ? "polyphonic" : "linear"} selections by score without global MMR`, async () => {
			const { state } = startSession({
				"mnemopi.scoping": "per-project-tagged",
				"mnemopi.polyphonicRecall": polyphonic,
				"mnemopi.recallLimit": 2,
			});
			const targets = state.getScopedRecallTargets();
			expect(targets).toHaveLength(2);
			const first = {
				id: "first",
				content: "deployment shared alpha common",
				source: null,
				timestamp: null,
				score: 0.9,
			};
			const second = {
				id: "second",
				content: "deployment shared beta common",
				source: null,
				timestamp: null,
				score: 0.89,
				truncated: true,
				full_length: 800,
			};
			const third = { id: "third", content: "unrelated distinct text", source: null, timestamp: null, score: 0.7 };
			const bankResults = polyphonic ? [[first, third], [second]] : [[first, second], [third]];
			const spies = targets.flatMap((target, index) => [
				spyOn(target.memory, "recallEnhanced").mockResolvedValue(bankResults[index]),
				spyOn(target.memory, "gatherCandidates").mockResolvedValue(bankResults[index]),
			]);
			try {
				const results = await state.collectScopedRecallResults("deployment");
				expect(results).toEqual([first, second]);
			} finally {
				for (const spy of spies) spy.mockRestore();
			}
		});

		it(`returns the real per-bank ${polyphonic ? "polyphonic" : "linear"} results in merged order`, async () => {
			const { state } = startSession({
				"mnemopi.scoping": "per-project-tagged",
				"mnemopi.polyphonicRecall": polyphonic,
				"mnemopi.recallLimit": 2,
			});
			const targets = state.getScopedRecallTargets();
			expect(targets).toHaveLength(2);
			targets[0].memory.remember(`deployment primary ${"x".repeat(600)}`, { importance: 0.9, scope: "global" });
			targets[0].memory.remember("deployment secondary checklist", { importance: 0.5, scope: "global" });
			targets[1].memory.remember("deployment other bank notes", { importance: 0.7, scope: "global" });
			const perBank = await Promise.all(
				targets.map(target =>
					target.memory.recallEnhanced("deployment", 2, {
						includeFacts: true,
						channelId: target.bank,
						updateRecallCounts: false,
					}),
				),
			);
			const expected = perBank
				.flat()
				.sort(
					(left, right) =>
						(right.score ?? 0) - (left.score ?? 0) ||
						(right.timestamp ?? "").localeCompare(left.timestamp ?? "") ||
						left.content.localeCompare(right.content),
				)
				.slice(0, 2);
			expect(expected).toHaveLength(2);
			expect((await state.collectScopedRecallResults("deployment")).map(result => result.id)).toEqual(
				expected.map(result => result.id),
			);
		});
	}
});

describe("merged bank reranking", () => {
	for (const polyphonic of [false, true]) {
		it(`scores one complete merged pool in ${polyphonic ? "polyphonic" : "linear"} mode`, async () => {
			const previousKey = process.env.COHERE_API_KEY;
			const previousExplicitKey = process.env.MNEMOPI_RERANK_API_KEY;
			delete process.env.MNEMOPI_RERANK_API_KEY;
			process.env.COHERE_API_KEY = "cohere-test-key";
			const requests: Array<{ documents: string[]; authorization: string | null }> = [];
			const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
				_input: Parameters<typeof fetch>[0],
				init: Parameters<typeof fetch>[1],
			) => {
				const body = JSON.parse(String(init?.body)) as { documents: string[] };
				requests.push({
					documents: body.documents,
					authorization: new Headers(init?.headers).get("authorization"),
				});
				return Response.json({
					results: body.documents.map((document, index) => ({
						index,
						relevance_score: document.includes("promoted") ? 0.99 : 0.1,
					})),
				});
			}) as unknown as typeof fetch);
			try {
				const { state } = startSession({
					"mnemopi.scoping": "per-project-tagged",
					"mnemopi.polyphonicRecall": polyphonic,
					"mnemopi.recallLimit": 1,
					"mnemopi.rerankApiUrl": "https://api.cohere.com/v2",
					"mnemopi.rerankCandidates": 3,
				});
				const targets = state.getScopedRecallTargets();
				expect(targets.length).toBeGreaterThanOrEqual(2);
				const first = targets[0].memory.remember("deploy ordinary primary", { importance: 0.9, scope: "global" });
				const second = targets[0].memory.remember("deploy promoted secondary", {
					importance: 0.1,
					scope: "global",
				});
				const third = targets[1].memory.remember("deploy other bank", { importance: 0.5, scope: "global" });
				const results = await state.collectScopedRecallResults("deploy");
				expect(results.map(result => result.id)).toEqual([second]);
				expect(requests).toHaveLength(1);
				expect(requests[0].authorization).toBe("Bearer cohere-test-key");
				expect(requests[0].documents).toHaveLength(3);
				for (const [target, id, expected] of [
					[targets[0], first, 0],
					[targets[0], second, 1],
					[targets[1], third, 0],
				] as const) {
					const row = target.memory.beam.db
						.query("SELECT recall_count FROM working_memory WHERE id = ?")
						.get(id) as { recall_count: number };
					expect(row.recall_count ?? 0).toBe(expected);
				}
			} finally {
				fetchSpy.mockRestore();
				if (previousKey === undefined) delete process.env.COHERE_API_KEY;
				else process.env.COHERE_API_KEY = previousKey;
				if (previousExplicitKey === undefined) delete process.env.MNEMOPI_RERANK_API_KEY;
				else process.env.MNEMOPI_RERANK_API_KEY = previousExplicitKey;
			}
		});
	}
});
