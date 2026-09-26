import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { DakeraApi, type DakeraMemory } from "@oh-my-pi/pi-coding-agent/dakera/client";
import { dakeraBackend } from "@oh-my-pi/pi-coding-agent/dakera/backend";
import { loadDakeraConfig } from "@oh-my-pi/pi-coding-agent/dakera/config";
import { DakeraSessionState } from "@oh-my-pi/pi-coding-agent/dakera/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { MemoryEditTool } from "@oh-my-pi/pi-coding-agent/tools/memory-edit";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import { MemoryReflectTool } from "@oh-my-pi/pi-coding-agent/tools/memory-reflect";
import { MemoryRetainTool } from "@oh-my-pi/pi-coding-agent/tools/memory-retain";

const dakeraSession = (settings: Settings, state?: DakeraSessionState): ToolSession =>
	({
		cwd: "/tmp",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionId: () => "sess-1",
		getSessionSpawns: () => null,
		getHindsightSessionState: () => undefined,
		getMnemopiSessionState: () => undefined,
		getDakeraSessionState: () => state,
	}) as unknown as ToolSession;

const configured = Settings.isolated({ "memory.backend": "dakera", "dakera.apiUrl": "http://dakera.local" });
const unconfigured = Settings.isolated({ "memory.backend": "dakera", "dakera.apiUrl": "" });

const stateFor = (settings: Settings): DakeraSessionState => {
	const config = loadDakeraConfig(settings);
	return new DakeraSessionState({
		sessionId: "sess-1",
		client: new DakeraApi({ baseUrl: "http://dakera.local" }),
		agentId: "omp",
		config,
		session: {} as AgentSession,
	});
};

const memory = (id: string, content: string, overrides: Partial<DakeraMemory> = {}): DakeraMemory => ({
	id,
	content,
	...overrides,
});

let storeBatch: Mock<DakeraApi["storeBatch"]>;
let recall: Mock<DakeraApi["recall"]>;

beforeEach(() => {
	resetSettingsForTest();
	storeBatch = vi.spyOn(DakeraApi.prototype, "storeBatch").mockResolvedValue([]);
	vi.spyOn(DakeraApi.prototype, "sessionStart").mockResolvedValue("srv-sess-1");
	recall = vi.spyOn(DakeraApi.prototype, "recall").mockResolvedValue([]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Dakera tool factories", () => {
	// A tool that appears in the catalogue and then throws on call is worse than
	// no tool: the model spends a turn discovering the backend is inert.
	it("expose retain/recall/reflect only when the server is reachable", () => {
		expect(MemoryRetainTool.createIf(dakeraSession(configured))).toBeInstanceOf(MemoryRetainTool);
		expect(MemoryRecallTool.createIf(dakeraSession(configured))).toBeInstanceOf(MemoryRecallTool);
		expect(MemoryReflectTool.createIf(dakeraSession(configured))).toBeInstanceOf(MemoryReflectTool);
		expect(MemoryRetainTool.createIf(dakeraSession(unconfigured))).toBeNull();
		expect(storeBatch).not.toHaveBeenCalled();
	});

	// Dakera memories are not addressable (no get-by-id on the server), so the
	// mnemopi-only editor must stay hidden.
	it("keeps memory_edit off the Dakera backend", () => {
		expect(MemoryEditTool.createIf(dakeraSession(configured))).toBeNull();
	});
});

describe("retain.execute (Dakera backend)", () => {
	it("reports the stored count and keeps context out of the content", async () => {
		storeBatch.mockResolvedValue([memory("m1", "a"), memory("m2", "b")]);
		const state = stateFor(configured);
		const tool = MemoryRetainTool.createIf(dakeraSession(configured, state));
		expect(tool).not.toBeNull();

		const result = await tool?.execute("call-1", {
			items: [{ content: "a", context: "from the deploy log" }, { content: "b" }],
		});

		expect(result?.content).toEqual([{ type: "text", text: "2 memories stored." }]);
		expect(result?.details).toEqual({ count: 2 });
		const inputs = storeBatch.mock.calls[0]?.[1] ?? [];
		expect(inputs.map(input => input.content)).toEqual(["a", "b"]);
		expect(inputs[0]?.metadata).toEqual({ context: "from the deploy log" });
		expect(inputs[1]?.metadata).toBeUndefined();
	});

	// The model must not be told a write succeeded when the server gave back no ids.
	it("reports zero when the server stores nothing", async () => {
		storeBatch.mockResolvedValue([]);
		const tool = MemoryRetainTool.createIf(dakeraSession(configured, stateFor(configured)));
		const result = await tool?.execute("call-2", { items: [{ content: "a" }] });
		expect(result?.content).toEqual([{ type: "text", text: "0 memories stored." }]);
	});
});

describe("recall.execute (Dakera backend)", () => {
	it("renders ranked hits with their type and date", async () => {
		recall.mockResolvedValue([
			{ memory: memory("m1", "weaker", { memory_type: "semantic", created_at: 1_700_000_000 }), smart_score: 0.2 },
			{ memory: memory("m2", "stronger", { memory_type: "episodic", created_at: 1_700_000_000 }), smart_score: 0.8 },
		]);
		const tool = MemoryRecallTool.createIf(dakeraSession(configured, stateFor(configured)));
		const result = await tool?.execute("call-3", { query: "deploy" });

		const text = String((result?.content as { type: string; text: string }[] | undefined)?.[0]?.text ?? "");
		expect(text.startsWith("Found 2 relevant memories (as of ")).toBe(true);
		// Fragments render first (higher signal density); episodic transcripts trail.
		expect(
			text.endsWith(
				"- weaker [semantic] (2023-11-14T22:13:20.000Z)\n\n- stronger [episodic] (2023-11-14T22:13:20.000Z)",
			),
		).toBe(true);
	});

	// `useless` lets the harness drop an empty recall from the transcript instead
	// of paying for it on every turn.
	it("marks an empty recall useless", async () => {
		recall.mockResolvedValue([]);
		const tool = MemoryRecallTool.createIf(dakeraSession(configured, stateFor(configured)));
		const result = await tool?.execute("call-4", { query: "nothing stored" });
		expect(result?.content).toEqual([{ type: "text", text: "No relevant memories found." }]);
		expect(result?.useless).toBe(true);
	});
});

describe("backend.save (Dakera)", () => {
	const saveContext = () =>
		({
			agentDir: "/tmp/agent",
			cwd: "/work/alpha",
			session: { settings: configured, sessionManager: { getCwd: () => "/work/alpha" } },
		}) as unknown as Parameters<NonNullable<typeof dakeraBackend.save>>[0];

	// `learn` mints a skill from the stored count, so a reply the client cannot
	// address must not be reported as a write.
	it("reports nothing stored when the server returns no id", async () => {
		vi.spyOn(DakeraApi.prototype, "store").mockResolvedValue({ content: "a" });

		expect(await dakeraBackend.save?.(saveContext(), { content: "a" })).toEqual({
			backend: "dakera",
			stored: 0,
			message: "Dakera stored the memory but returned no id.",
		});
	});

	// An explicit importance is the caller's judgement (a lesson outranks a
	// transcript); provenance rides in metadata because Dakera has no source column.
	it("carries the caller's importance and provenance into the stored row", async () => {
		const store = vi.spyOn(DakeraApi.prototype, "store").mockResolvedValue({ id: "m1", content: "a" });

		const result = await dakeraBackend.save?.(saveContext(), {
			content: "a",
			context: "from the deploy log",
			source: "coding-agent-learn",
			importance: 0.8,
		});

		expect(result?.stored).toBe(1);
		expect(result?.ids).toEqual(["m1"]);
		expect(store.mock.calls[0]?.[1]).toMatchObject({
			importance: 0.8,
			metadata: { context: "from the deploy log", source: "coding-agent-learn" },
		});
	});
});

// The mode only isolates if the filter survives the whole chain (`dakera.scoping`
// -> `computeAgentScope` -> recall body), so it is asserted end to end: on its
// own the setting is silently inert.
describe("backend.search tag scoping (Dakera)", () => {
	const searchContext = (scoping: string) =>
		({
			session: {
				settings: Settings.isolated({
					"memory.backend": "dakera",
					"dakera.apiUrl": "http://dakera.local",
					"dakera.scoping": scoping,
				}),
				sessionManager: { getCwd: () => "/work/alpha" },
			},
		}) as unknown as Parameters<NonNullable<typeof dakeraBackend.search>>[0];

	it("narrows recall to the project plus the global tier when tagged", async () => {
		await dakeraBackend.search?.(searchContext("per-project-tagged"), "alpha");
		expect(recall.mock.calls.at(-1)?.[0]).toBe("omp");
		expect(recall.mock.calls.at(-1)?.[2]).toMatchObject({ tags: ["project:alpha", "global:shared"] });
	});

	it("leaves recall unfiltered under per-project isolation", async () => {
		await dakeraBackend.search?.(searchContext("per-project"), "alpha");
		expect(recall.mock.calls.at(-1)?.[0]).toBe("omp-alpha");
		expect(recall.mock.calls.at(-1)?.[2]?.tags).toBeUndefined();
	});
});
