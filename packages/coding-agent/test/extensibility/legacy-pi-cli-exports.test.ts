import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	createReadToolDefinition,
	parseArgs,
} from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { toolReadsSkillUris } from "@oh-my-pi/pi-coding-agent/system-prompt";

describe("legacy shim CLI exports", () => {
	it("re-exports parseArgs and CONFIG_DIR_NAME from the legacy package root", () => {
		expect(CONFIG_DIR_NAME).toBe(".omp");
		expect(parseArgs(["hello"]).messages).toEqual(["hello"]);
	});
});

describe("legacy read tool skill capability", () => {
	it("leaves the sessionless legacy reader unmarked: its skill reads fall back to the process-global snapshot", async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "legacy-read-skill-")));
		try {
			expect(toolReadsSkillUris(createReadToolDefinition(dir))).toBe(false);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
