import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, parseArgs } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";

describe("legacy shim CLI exports", () => {
	it("re-exports parseArgs and CONFIG_DIR_NAME from the legacy package root", () => {
		expect(CONFIG_DIR_NAME).toBe(".omp");
		expect(parseArgs(["hello"]).messages).toEqual(["hello"]);
	});
});

describe("legacy read tool skill capability", () => {
	it("declares skill URI readability on the legacy read definition", async () => {
		const { createReadToolDefinition } =
			await import("@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim");
		const { toolReadsSkillUris } = await import("@oh-my-pi/pi-coding-agent/system-prompt");
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "legacy-read-skill-")));
		try {
			expect(toolReadsSkillUris(createReadToolDefinition(dir))).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
