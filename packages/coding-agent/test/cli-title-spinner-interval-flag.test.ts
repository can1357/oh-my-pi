import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgTuiTitleSpinnerInterval } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

describe("--title-spinner-interval", () => {
	it("parses a period in milliseconds without consuming the prompt", () => {
		const parsed = parseArgs(["--title-spinner-interval", "500", "hello"]);
		expect(parsed.titleSpinnerInterval).toBe(500);
		expect(parsed.messages).toEqual(["hello"]);
		expect(parseArgs(["--title-spinner-interval=0"]).titleSpinnerInterval).toBe(0);
	});

	it("rejects non-numeric, fractional, negative, and sub-floor values", () => {
		for (const value of ["fast", "2.5", "-1", "10"]) {
			expect(() => parseArgs(["--title-spinner-interval", value])).toThrow("--title-spinner-interval");
		}
	});

	it("is unset when the flag is absent so the setting layer decides", () => {
		expect(parseArgs(["hello"]).titleSpinnerInterval).toBeUndefined();
	});
});

describe("tui.titleSpinnerInterval", () => {
	it("defaults to 250 ms and accepts an ephemeral override", () => {
		const settings = Settings.isolated();
		expect(cfgTuiTitleSpinnerInterval.get(settings)).toBe(250);
		cfgTuiTitleSpinnerInterval.override(settings, 1000);
		expect(cfgTuiTitleSpinnerInterval.get(settings)).toBe(1000);
	});

	it("rejects a configured value below the floor", () => {
		const settings = Settings.isolated();
		expect(() => cfgTuiTitleSpinnerInterval.override(settings, 10)).toThrow("Title spinner interval");
	});
	describe("loaded from disk", () => {
		let tempDir: TempDir;
		let agentDir: string;
		let cwd: string;

		beforeEach(() => {
			tempDir = TempDir.createSync("@pi-title-spinner-");
			agentDir = tempDir.join("agent");
			cwd = tempDir.join("project");
			for (const dir of [agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
		});

		afterEach(() => {
			tempDir.removeSync();
		});

		it("loads an empty config with the default (validate must tolerate an unconfigured value)", async () => {
			const settings = await Settings.loadIsolated({ cwd, agentDir });
			expect(cfgTuiTitleSpinnerInterval.get(settings)).toBe(250);
		});

		it("loads a configured period and rejects one below the floor", async () => {
			const configPath = path.join(agentDir, "config.yml");
			await Bun.write(configPath, YAML.stringify({ tui: { titleSpinnerInterval: 500 } }));
			expect(cfgTuiTitleSpinnerInterval.get(await Settings.loadIsolated({ cwd, agentDir }))).toBe(500);
			await Bun.write(configPath, YAML.stringify({ tui: { titleSpinnerInterval: 10 } }));
			await expect(Settings.loadIsolated({ cwd, agentDir })).rejects.toThrow("Title spinner interval");
		});
	});
});
