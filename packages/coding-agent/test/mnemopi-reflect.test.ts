import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveMemoryCompletionInput, resolveMemoryCompletionSignal } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { loadMnemopi, loadMnemopiCore, MnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { MemoryReflectTool } from "@oh-my-pi/pi-coding-agent/tools/memory-reflect";
import type { ReflectMemory } from "@oh-my-pi/pi-mnemopi";
import type { MnemopiLlmCompletion } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { TempDir } from "@oh-my-pi/pi-utils";
import memoryReflectionPrompt from "../src/prompts/system/memory-reflect-system.md" with { type: "text" };

await Promise.all([loadMnemopi(), loadMnemopiCore()]);

interface ReflectionInput {
	query: string;
	memories: ReflectMemory[];
}

const states: MnemopiSessionState[] = [];
const dirs: TempDir[] = [];

function startSession(
	options: {
		complete?: MnemopiLlmCompletion;
		llmMode?: "smol" | "none" | "remote";
		scoped?: boolean;
		recallLimit?: number;
		reflectSynthesis?: boolean;
		enhancedRecall?: boolean;
	} = {},
): { state: MnemopiSessionState; tool: MemoryReflectTool } {
	const dir = TempDir.createSync("@mnemopi-reflect-");
	dirs.push(dir);
	const settings = Settings.isolated({
		"memory.backend": "mnemopi",
		"mnemopi.scoping": "global",
		"mnemopi.dbPath": dir.join("mnemopi.db"),
		"mnemopi.noEmbeddings": true,
		"mnemopi.llmMode": options.llmMode ?? "smol",
		"mnemopi.autoRetain": false,
		"mnemopi.enhancedRecall": options.enhancedRecall ?? false,
		...(options.reflectSynthesis === undefined ? {} : { "mnemopi.reflectSynthesis": options.reflectSynthesis }),
	});
	const config = loadMnemopiConfig(settings, dir.path());
	config.providerOptions = {
		...config.providerOptions,
		llm: options.complete ? { complete: options.complete } : false,
	};
	if (options.recallLimit !== undefined) config.recallLimit = options.recallLimit;
	if (options.scoped) {
		config.scoping = "per-project-tagged";
		config.bank = config.retainBank = "reflect-project";
		config.baseBank = config.globalBank = "reflect-global";
		config.recallBanks = ["reflect-project", "reflect-global"];
	}
	const state = new MnemopiSessionState({
		sessionId: "reflect-session",
		config,
		session: {
			sessionId: "reflect-session",
			settings,
			sessionManager: { getEntries: () => [], getCwd: () => dir.path() },
			emitNotice: () => {},
			subscribe: () => () => {},
		} as never,
	});
	states.push(state);
	const tools = {
		cwd: dir.path(),
		hasUI: false,
		settings,
		getMnemopiSessionState: () => state,
	} as unknown as ToolSession;
	return { state, tool: MemoryReflectTool.createIf(tools)! };
}

function remember(state: MnemopiSessionState, content: string, global = false): string {
	return state.rememberScoped(
		content,
		{ extract: false, extractEntities: false, memoryType: "episode" },
		global ? state.getGlobalRetainTarget() : state.getScopedRetainTarget(),
	);
}

interface RecallUsage {
	recall_count: number;
	last_recalled: string | null;
}

function recallUsage(state: MnemopiSessionState, id: string): RecallUsage {
	for (const target of state.getScopedRecallTargets()) {
		const row = target.memory.db
			.query("SELECT recall_count, last_recalled FROM working_memory WHERE id = ?")
			.get(id) as RecallUsage | null;
		if (row) return row;
	}
	throw new Error(`Memory not found: ${id}`);
}

afterEach(async () => {
	for (const state of states.splice(0)) await state.dispose({ consolidate: false });
	for (const dir of dirs.splice(0)) await dir.remove();
});

describe("Mnemopi reflect", () => {
	it.each([
		{ name: "disabled by default", reflectSynthesis: undefined, llmMode: "smol" as const, hasCompletion: true },
		{ name: "explicitly disabled", reflectSynthesis: false, llmMode: "smol" as const, hasCompletion: true },
		{ name: "LLM disabled", reflectSynthesis: true, llmMode: "none" as const, hasCompletion: true },
		{ name: "completion unavailable", reflectSynthesis: true, llmMode: "remote" as const, hasCompletion: false },
	])("preserves legacy output and recall usage when $name", async options => {
		let calls = 0;
		const { state, tool } = startSession({
			reflectSynthesis: options.reflectSynthesis,
			llmMode: options.llmMode,
			recallLimit: 1,
			complete: options.hasCompletion
				? () => {
						calls++;
						return "This completion must not be used.";
					}
				: undefined,
		});
		const ids = [
			remember(state, "The launch checklist lives in the wiki"),
			remember(state, "Alice owns the launch checklist"),
			remember(state, "The launch checklist is reviewed each Monday"),
		];
		const beforeLegacy = ids.map(id => recallUsage(state, id));
		const oldResults = await state.recallResultsScoped("launch checklist");
		const afterLegacy = ids.map(id => recallUsage(state, id));
		const expected = {
			content: [
				{ type: "text" as const, text: `Based on recalled memories:\n\n${state.formatContextScoped(oldResults)}` },
			],
			details: {},
		};
		const recall = spyOn(state.memory, "recallEnhanced");
		try {
			expect(await tool.execute("reflect", { query: "launch checklist" })).toEqual(expected);
			expect(recall).toHaveBeenCalledTimes(1);
			expect(recall).toHaveBeenCalledWith("launch checklist", 1, {
				includeFacts: true,
				channelId: state.config.bank,
			});
		} finally {
			recall.mockRestore();
		}
		expect(calls).toBe(0);
		for (const [index, id] of ids.entries()) {
			const afterReflect = recallUsage(state, id);
			const legacyIncrement = afterLegacy[index].recall_count - beforeLegacy[index].recall_count;
			expect(afterReflect.recall_count - afterLegacy[index].recall_count).toBe(legacyIncrement);
			if (legacyIncrement === 0) expect(afterReflect.last_recalled).toBe(beforeLegacy[index].last_recalled);
			else expect(afterReflect.last_recalled).not.toBeNull();
		}
	});

	it("synthesizes across scoped banks beyond the normal recall limit and exposes only cited memory links", async () => {
		let input: ReflectionInput | undefined;
		let projectId = "";
		let globalId = "";
		const { state, tool } = startSession({
			scoped: true,
			recallLimit: 1,
			reflectSynthesis: true,
			complete: (_prompt, options) => {
				if (options?.task?.kind !== "memory-reflect") throw new Error("Unexpected memory task");
				input = JSON.parse(options.task.input) as ReflectionInput;
				return `Alice owns the launch checklist in the wiki [${projectId}] [${globalId}].`;
			},
		});
		projectId = remember(state, "Alice owns the launch checklist");
		globalId = remember(state, "The launch checklist lives in the wiki", true);
		const uncitedId = remember(state, "The launch checklist is reviewed each Monday");

		const result = await tool.execute("reflect", {
			query: "launch checklist",
			context: "Who owns it and where is it?",
		});
		const [block] = result.content;
		if (block?.type !== "text") throw new Error("reflect returned no text block");
		expect(input?.query).toContain("Who owns it and where is it?");
		expect(input?.memories.map(memory => memory.id)).toEqual(
			expect.arrayContaining([projectId, globalId, uncitedId]),
		);
		expect(block.text).toContain(`Alice owns the launch checklist in the wiki [${projectId}] [${globalId}].`);
		expect(block.text).toContain(`memory://${projectId}`);
		expect(block.text).toContain(`memory://${globalId}`);
		expect(block.text).not.toContain(`memory://${uncitedId}`);
		expect(block.text).not.toContain("Based on recalled memories:");
		expect(result.details).toEqual({ synthesized: true, citedIds: [projectId, globalId] });
		expect(recallUsage(state, projectId).recall_count).toBe(1);
		expect(recallUsage(state, globalId).recall_count).toBe(1);
		expect(recallUsage(state, uncitedId)).toEqual({ recall_count: 0, last_recalled: null });
	});

	it.each([
		{ name: "synthesis", synthesized: true, cachedRankings: 1 },
		{ name: "fallback", synthesized: false, cachedRankings: 2 },
	])("keeps enhanced recall rankings cached after $name usage accounting", async options => {
		let id = "";
		const { state, tool } = startSession({
			reflectSynthesis: true,
			enhancedRecall: true,
			recallLimit: 1,
			complete: () => (options.synthesized ? `Alice owns the launch checklist [${id}].` : null),
		});
		id = remember(state, "Alice owns the launch checklist");
		for (let call = 0; call < 2; call++) {
			const result = await tool.execute("reflect", { query: "launch checklist" });
			expect(result.details).toEqual(options.synthesized ? { synthesized: true, citedIds: [id] } : {});
			expect(recallUsage(state, id).recall_count).toBe(call + 1);
		}
		expect(state.memory.beam.caches.queryCache?.stats()).toMatchObject({
			hits: options.cachedRankings,
			misses: options.cachedRankings,
		});
	});

	it("answers from evidence past the recall preview boundary rather than only the first 500 characters", async () => {
		let memoryId = "";
		const { state, tool } = startSession({
			reflectSynthesis: true,
			complete: (_prompt, options) => {
				if (options?.task?.kind !== "memory-reflect") throw new Error("Unexpected memory task");
				const input = JSON.parse(options.task.input) as ReflectionInput;
				const evidence = input.memories.find(memory => memory.id === memoryId)?.content ?? "";
				return evidence.includes("The owner is Mina.")
					? `Mina owns the checklist [${memoryId}].`
					: "The owner is unknown.";
			},
		});
		memoryId = remember(state, `Launch checklist background: ${"background notes ".repeat(50)}The owner is Mina.`);
		const result = await tool.execute("reflect", { query: "launch checklist" });
		const [block] = result.content;
		if (block?.type !== "text") throw new Error("reflect returned no text block");
		expect(block.text).toContain(`Mina owns the checklist [${memoryId}]`);
		expect(block.text).toContain(`memory://${memoryId}`);
	});

	it("clips the fallback to the old preview without attributing a second recall to the memory", async () => {
		const { state, tool } = startSession({ reflectSynthesis: true, complete: () => null, recallLimit: 1 });
		const content = `Launch checklist background: ${"background notes ".repeat(50)}Hidden end of checklist.`;
		const id = remember(state, content);
		const oldResults = await state.recallResultsScoped("launch checklist");
		const oldOutput = `Based on recalled memories:\n\n${state.formatContextScoped(oldResults)}`;
		const before = state.memory.db.query("SELECT recall_count FROM working_memory WHERE id = ?").get(id) as {
			recall_count: number;
		};
		const result = await tool.execute("reflect", { query: "launch checklist" });
		const [block] = result.content;
		if (block?.type !== "text") throw new Error("reflect returned no text block");
		expect(block.text).toBe(oldOutput);
		expect(block.text).not.toContain("Hidden end of checklist.");
		const row = state.memory.db.query("SELECT recall_count FROM working_memory WHERE id = ?").get(id) as {
			recall_count: number;
		};
		expect(row.recall_count - before.recall_count).toBe(1);
		expect(result.details).toEqual({});
	});

	it("reranks fallback at the original limit and counts only displayed memories across banks", async () => {
		let input: ReflectionInput | undefined;
		const { state, tool } = startSession({
			scoped: true,
			recallLimit: 1,
			reflectSynthesis: true,
			complete: (_prompt, options) => {
				if (options?.task?.kind !== "memory-reflect") throw new Error("Unexpected memory task");
				input = JSON.parse(options.task.input) as ReflectionInput;
				return null;
			},
		});
		const ids = [
			remember(state, "The launch checklist lives in the wiki"),
			remember(state, "Alice owns the launch checklist"),
			remember(state, "The launch checklist is reviewed each Monday", true),
		];
		const legacy = await state.collectScopedRecallResults("launch checklist", 1, { updateRecallCounts: false });
		const expected = {
			content: [
				{ type: "text" as const, text: `Based on recalled memories:\n\n${state.formatContextScoped(legacy)}` },
			],
			details: {},
		};
		const originalCollect = state.collectScopedRecallResults.bind(state);
		const collect = spyOn(state, "collectScopedRecallResults").mockImplementation(async (query, limit, options) => {
			const results = await originalCollect(query, limit, options);
			// A wider recall can legitimately select a different top result through MMR.
			// Ensure slicing that ranking would return a memory other than the legacy winner.
			if (limit === 12) {
				return [...results.filter(result => result.id !== legacy[0].id), legacy[0]];
			}
			return results;
		});
		try {
			expect(await tool.execute("reflect", { query: "launch checklist" })).toEqual(expected);
			expect(input?.memories.map(memory => memory.id)).toEqual(expect.arrayContaining(ids));
			expect(collect).toHaveBeenCalledWith("launch checklist", 1, { updateRecallCounts: false });
		} finally {
			collect.mockRestore();
		}
		for (const id of ids) {
			const usage = recallUsage(state, id);
			if (id === legacy[0].id) {
				expect(usage.recall_count).toBe(1);
				expect(usage.last_recalled).not.toBeNull();
			} else {
				expect(usage).toEqual({ recall_count: 0, last_recalled: null });
			}
		}
	});

	it("propagates caller cancellation into the completion instead of returning recalled-memory fallback", async () => {
		const started = Promise.withResolvers<void>();
		let completionSignal: AbortSignal | undefined;
		const { state } = startSession({
			reflectSynthesis: true,
			complete: (_prompt, options) => {
				completionSignal = options?.signal;
				const completion = Promise.withResolvers<string | null>();
				completionSignal?.addEventListener("abort", () => completion.reject(completionSignal?.reason), {
					once: true,
				});
				started.resolve();
				return completion.promise;
			},
		});
		remember(state, "The launch checklist lives in the wiki");
		const controller = new AbortController();
		const operation = state.reflectScoped("launch checklist", controller.signal);
		await started.promise;
		controller.abort(new Error("Reflection cancelled"));
		await expect(operation).rejects.toThrow("Reflection cancelled");
		expect(completionSignal?.aborted).toBe(true);
	});

	it("returns recalled memories rather than failing when the LLM throws", async () => {
		let calls = 0;
		const { state, tool } = startSession({
			reflectSynthesis: true,
			complete: () => {
				calls++;
				throw new Error("Memory model unavailable");
			},
		});
		remember(state, "The launch checklist lives in the wiki");
		const summary = state.formatContextScoped(await state.recallResultsScoped("launch checklist"));
		const result = await tool.execute("reflect", { query: "launch checklist" });
		expect(calls).toBe(1);
		expect(result.content).toEqual([{ type: "text", text: `Based on recalled memories:\n\n${summary}` }]);
		expect(result.details).toEqual({});
	});

	it("reports no relevant information without invoking the LLM when recall is empty", async () => {
		let calls = 0;
		const { tool } = startSession({
			reflectSynthesis: true,
			complete: () => {
				calls++;
				return "Unsupported answer";
			},
		});
		const result = await tool.execute("reflect", { query: "launch checklist" });
		expect(result.content).toEqual([{ type: "text", text: "No relevant information found to reflect on." }]);
		expect(result.details).toEqual({});
		expect(calls).toBe(0);
	});

	it("routes reflection data into the user turn and reflection instructions into the system turn", () => {
		const input = JSON.stringify({
			query: "Who owns the checklist?",
			memories: [{ id: "memory-1", content: "Alice owns it" }],
		});
		const request = resolveMemoryCompletionInput("discard this rendered prompt", {
			task: { kind: "memory-reflect", input },
		});
		expect(request).toEqual({ prompt: input, systemPrompt: memoryReflectionPrompt });
	});

	it("converts a 15-second completion deadline to a 15000ms platform timeout instead of 15ms", () => {
		const timeout = spyOn(AbortSignal, "timeout");
		try {
			resolveMemoryCompletionSignal({ timeout: 15 });
			expect(timeout).toHaveBeenCalledWith(15_000);
		} finally {
			timeout.mockRestore();
		}
	});

	it("combines the timeout with caller cancellation so an aborted tool cancels its model request", () => {
		const controller = new AbortController();
		const signal = resolveMemoryCompletionSignal({ timeout: 15, signal: controller.signal });
		const reason = new Error("User cancelled reflection");
		controller.abort(reason);
		expect(signal?.aborted).toBe(true);
		expect(signal?.reason).toBe(reason);
	});
});
