import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgTuiSpinnerInterval } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

describe("--spinner-interval", () => {
	it("parses a period in milliseconds without consuming the prompt", () => {
		const parsed = parseArgs(["--spinner-interval", "500", "hello"]);
		expect(parsed.spinnerInterval).toBe(500);
		expect(parsed.messages).toEqual(["hello"]);
		expect(parseArgs(["--spinner-interval=0"]).spinnerInterval).toBe(0);
	});

	it("rejects non-numeric, fractional, negative, and sub-floor values", () => {
		for (const value of ["fast", "2.5", "-1", "10"]) {
			expect(() => parseArgs(["--spinner-interval", value])).toThrow("--spinner-interval");
		}
	});
});

describe("tui.spinnerInterval", () => {
	it("rejects a configured value below the floor", () => {
		const settings = Settings.isolated();
		expect(() => cfgTuiSpinnerInterval.override(settings, 10)).toThrow("Spinner interval");
	});
	describe("loaded from disk", () => {
		let tempDir: TempDir;
		let agentDir: string;
		let cwd: string;

		beforeEach(() => {
			tempDir = TempDir.createSync("@pi-spinner-interval-");
			agentDir = tempDir.join("agent");
			cwd = tempDir.join("project");
			for (const dir of [agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
		});

		afterEach(() => {
			tempDir.removeSync();
		});

		it("loads an empty config with the default (validate must tolerate an unconfigured value)", async () => {
			const settings = await Settings.loadIsolated({ cwd, agentDir });
			expect(cfgTuiSpinnerInterval.get(settings)).toBe(80);
		});

		it("loads a configured period and rejects one below the floor", async () => {
			const configPath = path.join(agentDir, "config.yml");
			await Bun.write(configPath, YAML.stringify({ tui: { spinnerInterval: 500 } }));
			expect(cfgTuiSpinnerInterval.get(await Settings.loadIsolated({ cwd, agentDir }))).toBe(500);
			await Bun.write(configPath, YAML.stringify({ tui: { spinnerInterval: 10 } }));
			await expect(Settings.loadIsolated({ cwd, agentDir })).rejects.toThrow("Spinner interval");
		});
	});
});
