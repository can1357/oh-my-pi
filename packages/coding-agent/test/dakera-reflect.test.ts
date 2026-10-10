import { describe, expect, it } from "bun:test";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { DakeraMemoryType, DakeraRecallHit } from "@oh-my-pi/pi-coding-agent/dakera/client";
import { budgetRecallHits, formatRecallHits, resolveDakeraModel } from "@oh-my-pi/pi-coding-agent/dakera/reflect";

const registryFor = (models: MockModel[]): ModelRegistry =>
	({ getAll: () => models, getAvailable: () => models }) as unknown as ModelRegistry;

const hit = (id: string, content: string, created_at?: number, memory_type?: DakeraMemoryType): DakeraRecallHit => ({
	memory: { id, content, created_at, memory_type },
});

describe("resolveDakeraModel", () => {
	// Found live: a config that names only `modelRoles.default` — the common case
	// — has no smol role, so a smol-only ladder left reflect erroring on a
	// machine with a perfectly usable model.
	it("takes the default model role when no smol role is configured", async () => {
		const answerer = createMockModel({ provider: "mock", id: "answerer" });
		const settings = Settings.isolated({ modelRoles: { default: "mock/answerer" } });

		expect((await resolveDakeraModel(settings, registryFor([answerer])))?.id).toBe("answerer");
	});

	it("prefers the smol role over the default one", async () => {
		const small = createMockModel({ provider: "mock", id: "small" });
		const answerer = createMockModel({ provider: "mock", id: "answerer" });
		const settings = Settings.isolated({ modelRoles: { default: "mock/answerer", smol: "mock/small" } });

		expect((await resolveDakeraModel(settings, registryFor([small, answerer])))?.id).toBe("small");
	});

	// An explicit selector outranks the role ladder, so reflect can be pinned to a
	// model that is not the one answering the session.
	it("honors dakera.reflectModel over any role", async () => {
		const pinned = createMockModel({ provider: "mock", id: "pinned" });
		const small = createMockModel({ provider: "mock", id: "small" });
		const settings = Settings.isolated({
			"dakera.reflectModel": "mock/pinned",
			modelRoles: { smol: "mock/small" },
		});

		expect((await resolveDakeraModel(settings, registryFor([pinned, small])))?.id).toBe("pinned");
	});

	// `runDakeraReflect` passes `config.reflectModel`, which is
	// DAKERA_REFLECT_MODEL when set — so the env override has to outrank a
	// persisted setting, otherwise an operator pinning reflect by env is ignored.
	it("honors an explicit selector over the persisted setting", async () => {
		const fromEnv = createMockModel({ provider: "mock", id: "from-env" });
		const fromSettings = createMockModel({ provider: "mock", id: "from-settings" });
		const settings = Settings.isolated({ "dakera.reflectModel": "mock/from-settings" });

		expect((await resolveDakeraModel(settings, registryFor([fromEnv, fromSettings]), "mock/from-env"))?.id).toBe(
			"from-env",
		);
	});

	// A selector naming a model that is not in the registry must not make reflect
	// error out — it falls through to the same role ladder as no selector at all.
	it("falls back to the role ladder when an explicit selector does not resolve", async () => {
		const small = createMockModel({ provider: "mock", id: "small" });
		const settings = Settings.isolated({ modelRoles: { smol: "mock/small" } });

		expect((await resolveDakeraModel(settings, registryFor([small]), "mock/missing"))?.id).toBe("small");
	});

	// Without any resolvable model reflect must report the missing model rather
	// than answer from an arbitrary one.
	it("resolves no model when no role and no selector is configured", async () => {
		const settings = Settings.isolated({});

		expect(await resolveDakeraModel(settings, registryFor([createMockModel()]))).toBeUndefined();
	});
});

describe("formatRecallHits", () => {
	// The reflect prompt tells the model to prefer the most recently dated
	// contradiction, which needs the dates to run one way; recall hands the hits
	// over ranked, not chronological.
	it("renders ranked hits oldest-first so dated contradictions resolve", () => {
		const rendered = formatRecallHits([
			hit("newest", "deploy uses blue-green", 1_800_000_000, "semantic"),
			hit("oldest", "deploy uses rolling restarts", 1_700_000_000, "semantic"),
		]);

		expect(rendered).toBe(
			"(2023-11-14T22:13:20.000Z) [semantic] deploy uses rolling restarts\n\n(2027-01-15T08:00:00.000Z) [semantic] deploy uses blue-green",
		);
	});

	// An undated row cannot be newer than anything, so it leads the history.
	it("leads with undated hits rather than trailing with them", () => {
		const rendered = formatRecallHits([
			hit("dated", "deploy uses blue-green", 1_800_000_000),
			hit("undated", "the repo started as a spike"),
		]);

		expect(rendered).toBe("the repo started as a spike\n\n(2027-01-15T08:00:00.000Z) deploy uses blue-green");
	});
});
describe("budgetRecallHits", () => {
	const bigRow = (id: string, size: number) => hit(id, "x".repeat(size), 1_800_000_000, "episodic");
	// Uncapped, topK=8 hits of a 99k-char transcript ceiling could approach
	// ~800k characters and overflow the reflect model's context window.
	it("keeps best-ranked hits whole and clamps the row that crosses the budget", () => {
		const kept = budgetRecallHits([bigRow("a", 30_000), bigRow("b", 20_000), bigRow("c", 20_000)]);

		expect(kept.map(row => row.memory.id)).toEqual(["a", "b", "c"]);
		expect(kept[0].memory.content).toHaveLength(30_000);
		expect(kept[1].memory.content).toHaveLength(20_000);
		// c is cut to the remaining room, ellipsis included, so the whole block is
		// exactly the budget — no overflow reaches the model.
		expect(kept[2].memory.content).toHaveLength(10_000);
		expect(kept[2].memory.content.endsWith("…")).toBe(true);
		expect(kept.reduce((sum, row) => sum + row.memory.content.length, 0)).toBe(60_000);
	});

	// A transcript memory can be 99k chars on its own. Passing it through whole
	// overflows the context window the budget exists to protect, and dropping it
	// would report "nothing to reflect on" while holding evidence.
	it("clamps a single oversized hit instead of passing it through", () => {
		const [kept] = budgetRecallHits([bigRow("huge", 120_000)]);

		expect(kept.memory.id).toBe("huge");
		expect(kept.memory.content).toHaveLength(60_000);
	});

	// The budget must not shorten the session's stored recall results, which the
	// next turn reuses: clamping happens on a copy.
	it("does not mutate the hits it budgets", () => {
		const huge = bigRow("huge", 120_000);
		budgetRecallHits([huge]);

		expect(huge.memory.content).toHaveLength(120_000);
	});

	it("passes an empty list through", () => {
		expect(budgetRecallHits([])).toEqual([]);
	});
});
