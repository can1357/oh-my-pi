import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import {
	buildCoordinationSpawnContext,
	formatRequestedModelRoute,
	isReviewAgent,
	loadTaskRoleCoordination,
	partitionSpawnFanIn,
	resolveCoordinationSpawnRoutes,
	resolveEffectiveAgentBlocking,
	resolveSpawnExecutionBlocking,
} from "../src/config/estate-role-runtime";
import { ESTATE_ROLE_COORDINATION_SCHEMA } from "../src/config/estate-role-coordination";
import { ESTATE_IMPLEMENTATION_DEFAULTS, resolveDefaultSpawnAgent, resolveSpawnPolicy } from "../src/task/spawn-policy";
import type { AgentDefinition } from "../src/task/types";

function agent(name: string, blocking?: boolean): AgentDefinition {
	return {
		name,
		description: name,
		systemPrompt: "",
		source: "bundled",
		...(blocking ? { blocking: true } : {}),
	};
}

describe("estate-role-runtime routing", () => {
	test("resolveEffectiveAgentBlocking merges frontmatter and settings overlay", () => {
		expect(resolveEffectiveAgentBlocking(agent("estate-luna", true), {})).toBe(true);
		expect(resolveEffectiveAgentBlocking(agent("task"), { task: true })).toBe(true);
		expect(resolveEffectiveAgentBlocking(agent("scout"), {})).toBe(false);
	});

	test("resolveSpawnExecutionBlocking forces reviewers async for fan-in", () => {
		const blocking = [true, true];
		const routed = resolveSpawnExecutionBlocking(["estate-luna", "reviewer"], blocking);
		expect(routed).toEqual([true, false]);
	});

	test("partitionSpawnFanIn classifies reviewer branches", () => {
		const itemBlocking = resolveSpawnExecutionBlocking(["estate-luna", "reviewer"], [true, true]);
		const partition = partitionSpawnFanIn(["estate-luna", "reviewer"], itemBlocking);
		expect(partition.reviewIndices).toEqual([1]);
		expect(partition.blockingIndices).toEqual([0]);
		expect(partition.asyncIndices).toEqual([1]);
		expect(isReviewAgent("reviewer")).toBe(true);
	});

	test("buildCoordinationSpawnContext injects registry ownership into batch context", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-role-runtime-"));
		const filePath = path.join(tmpDir, "estate-roles.json");
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				schema: ESTATE_ROLE_COORDINATION_SCHEMA,
				roles: [{ role: "Device steward", thread: "thread-abc", cmux: "workspace:15" }],
			}),
		);
		await Settings.init({ inMemory: true, cwd: tmpDir, overrides: { "task.roleCoordinationFile": filePath } });
		const settings = Settings.isolated({ "task.roleCoordinationFile": filePath });
		const registry = loadTaskRoleCoordination(settings, tmpDir);
		const routes = resolveCoordinationSpawnRoutes(registry, ["device-steward"]);
		expect(routes[0]?.thread).toBe("thread-abc");
		const context = buildCoordinationSpawnContext(registry, ["device-steward"]);
		expect(context).toContain("thread=thread-abc");
		expect(context).toContain("# Coordination routing");
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("formatRequestedModelRoute strips role aliases for HUD surfaces", () => {
		expect(formatRequestedModelRoute(["@slow", "opencode-go-cornell/muse"])).toBe("slow>opencode-go-cornell/muse");
	});
});

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
		expect(resolveSpawnPolicy("task, reviewer").defaultAgent).toBe("task");
		expect(resolveSpawnPolicy("estate-luna, reviewer").defaultAgent).toBe("estate-luna");
	});
});
