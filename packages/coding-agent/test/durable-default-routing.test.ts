import { describe, expect, test } from "bun:test";
import { ESTATE_IMPLEMENTATION_DEFAULTS, resolveDefaultSpawnAgent, resolveSpawnPolicy } from "../src/task/spawn-policy";

describe("spawn-policy estate DEFAULT spine", () => {
	test("omitted-agent defaults follow spawns frontmatter (Sol→task, Terra→Luna, Luna→Muse)", () => {
		expect(resolveDefaultSpawnAgent("task, reviewer", "estate-sol")).toBe("task");
		expect(resolveDefaultSpawnAgent("estate-luna, reviewer", "estate-terra")).toBe("estate-luna");
		expect(resolveDefaultSpawnAgent("estate-muse", "estate-luna")).toBe("estate-muse");
	});

	test("unrestricted spawns use estate hierarchy fallback", () => {
		expect(resolveDefaultSpawnAgent("*", "estate-sol")).toBe("task");
		expect(resolveDefaultSpawnAgent("*", "task")).toBe("estate-terra");
		expect(resolveDefaultSpawnAgent("*", "estate-terra")).toBe("estate-luna");
		expect(resolveDefaultSpawnAgent("*", "estate-luna")).toBe("estate-muse");
	});

	test("ESTATE_IMPLEMENTATION_DEFAULTS matches documented spine", () => {
		expect(ESTATE_IMPLEMENTATION_DEFAULTS).toEqual({
			"estate-sol": "task",
			task: "estate-terra",
			"estate-terra": "estate-luna",
			"estate-luna": "estate-muse",
		});
	});

	test("resolveSpawnPolicy first allowed agent is default when explicit list", () => {
		const policy = resolveSpawnPolicy("scout, task");
		expect(policy.defaultAgent).toBe("scout");
		expect(policy.allowedAgents).toEqual(["scout", "task"]);
	});
});
