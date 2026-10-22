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
import type { RecallResult } from "@oh-my-pi/pi-mnemopi";
import { TempDir } from "@oh-my-pi/pi-utils";

// Mnemopi is lazy-loaded at runtime; preload it for synchronous state construction.
await Promise.all([loadMnemopi(), loadMnemopiCore()]);

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
		"mnemopi.noEmbeddings": true,
		"mnemopi.llmMode": "none",
		...overrides,
	});
	const state = new MnemopiSessionState({
		sessionId: SESSION_ID,
		config: loadMnemopiConfig(settings, dir.path()),
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
	it("surfaces a graph-linked memory by default that linear recall misses", async () => {
		const texts: Record<string, string> = {};
		for (const polyphonicRecall of [false, true]) {
			const { tools } = startSession({
				// The polyphonic leg leaves the setting unset, so it runs the default.
				...(polyphonicRecall ? {} : { "mnemopi.polyphonicRecall": false }),
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
		// A fused rank score is not confidence; showing a one-voice hit as c:0.2 would misstate its reliability.
		expect(texts.true).not.toContain(" c:");
	});
});

describe("scoped recall ranking", () => {
	it.each([false, true])(
		"merges bank rankings without comparing fused score magnitudes (polyphonic=%s)",
		async polyphonic => {
			const { state } = startSession({
				"mnemopi.scoping": "per-project-tagged",
				"mnemopi.polyphonicRecall": polyphonic,
				"mnemopi.recallLimit": 2,
			});
			const [project, shared] = state.getScopedRecallTargets();
			if (!project || !shared) throw new Error("the fixture requires project and shared banks");
			const row = (id: string, score: number): RecallResult => ({
				id,
				content: `record ${id}`,
				score,
				...(polyphonic ? { combined_score: score / 10 } : {}),
			});
			const projectRecall = spyOn(project.memory, "recallEnhanced").mockResolvedValue([
				row("project-first", 0.2),
				row("project-second", 0.19),
			]);
			const sharedRecall = spyOn(shared.memory, "recallEnhanced").mockResolvedValue([
				row("shared-first", 0.9),
				row("shared-second", 0.89),
			]);
			try {
				const results = await state.collectScopedRecallResults("record lookup");
				expect(results.map(result => result.id)).toEqual(
					polyphonic ? ["project-first", "shared-first"] : ["shared-first", "shared-second"],
				);
			} finally {
				projectRecall.mockRestore();
				sharedRecall.mockRestore();
			}
		},
	);

	it("keeps distinct memory IDs whose clipped previews happen to be identical across banks", async () => {
		const { state } = startSession({
			"mnemopi.scoping": "per-project-tagged",
			"mnemopi.recallLimit": 2,
		});
		const [project, shared] = state.getScopedRecallTargets();
		if (!project || !shared) throw new Error("the fixture requires project and shared banks");
		const preview = "Shared deployment procedure; the distinguishing hostname is beyond this preview.";
		const row = (id: string): RecallResult => ({
			id,
			content: preview,
			score: 0.2,
			combined_score: 1 / 61,
			truncated: true,
			full_length: 900,
		});
		const projectRecall = spyOn(project.memory, "recallEnhanced").mockResolvedValue([row("host-a")]);
		const sharedRecall = spyOn(shared.memory, "recallEnhanced").mockResolvedValue([row("host-b")]);
		try {
			expect((await state.collectScopedRecallResults("deployment procedure")).map(result => result.id)).toEqual([
				"host-a",
				"host-b",
			]);
		} finally {
			projectRecall.mockRestore();
			sharedRecall.mockRestore();
		}
	});

	it.each(["id", "full content"] as const)(
		"deduplicates repeated %s across banks without consuming a result slot",
		async match => {
			const { state } = startSession({ "mnemopi.scoping": "per-project-tagged", "mnemopi.recallLimit": 2 });
			const [project, shared] = state.getScopedRecallTargets();
			if (!project || !shared) throw new Error("the fixture requires project and shared banks");
			const first: RecallResult = {
				id: "first",
				content: "deployment owner",
				score: 0.2,
				combined_score: 1 / 61,
				truncated: match === "id",
			};
			const repeated: RecallResult = {
				...first,
				id: match === "id" ? "first" : "other-id",
				content: match === "id" ? "a different clipped view of the same memory" : first.content,
			};
			const tail: RecallResult = { id: "tail", content: "deployment fallback", score: 0.19, combined_score: 1 / 62 };
			const projectRecall = spyOn(project.memory, "recallEnhanced").mockResolvedValue([first]);
			const sharedRecall = spyOn(shared.memory, "recallEnhanced").mockResolvedValue([repeated, tail]);
			try {
				expect((await state.collectScopedRecallResults("record lookup")).map(result => result.id)).toEqual([
					"first",
					"tail",
				]);
			} finally {
				projectRecall.mockRestore();
				sharedRecall.mockRestore();
			}
		},
	);
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
