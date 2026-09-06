import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import {
	buildCoordinationRegistryAdvisory,
	buildReviewFanInAdvisory,
	formatRequestedModelRoute,
	isReviewAgent,
	loadTaskRoleCoordination,
	partitionSpawnFanIn,
	resolveEffectiveAgentBlocking,
} from "../src/config/estate-role-runtime";
import { ESTATE_ROLE_COORDINATION_SCHEMA } from "../src/config/estate-role-coordination";
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

describe("estate-role-runtime", () => {
	test("resolveEffectiveAgentBlocking merges frontmatter and settings overlay", () => {
		expect(resolveEffectiveAgentBlocking(agent("estate-luna", true), {})).toBe(true);
		expect(resolveEffectiveAgentBlocking(agent("task"), { task: true })).toBe(true);
		expect(resolveEffectiveAgentBlocking(agent("scout"), {})).toBe(false);
	});

	test("partitionSpawnFanIn classifies reviewer branches", () => {
		const partition = partitionSpawnFanIn(["estate-luna", "reviewer"], [true, false]);
		expect(partition.reviewIndices).toEqual([1]);
		expect(partition.blockingIndices).toEqual([0]);
		expect(partition.asyncIndices).toEqual([1]);
		expect(isReviewAgent("reviewer")).toBe(true);
	});

	test("buildReviewFanInAdvisory nudges parallel review alongside implementation", () => {
		const partition = partitionSpawnFanIn(["estate-terra", "reviewer"], [true, false]);
		const advisory = buildReviewFanInAdvisory(partition, ["estate-terra", "reviewer"]);
		expect(advisory).toContain("Review fan-in");
		expect(advisory).toContain("reviewer");
		expect(advisory).toContain("estate-terra");
	});

		test("loadTaskRoleCoordination reads registry from workspace settings", async () => {
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
		expect(registry?.byThread.get("thread-abc")?.role).toBe("Device steward");
		const advisory = buildCoordinationRegistryAdvisory(registry, ["device-steward"]);
		expect(advisory).toContain("thread-abc");
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("formatRequestedModelRoute strips role aliases for HUD surfaces", () => {
		expect(formatRequestedModelRoute(["@slow", "opencode-go-cornell/muse"])).toBe("slow>opencode-go-cornell/muse");
	});
});
