import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	cfgDisplayShimmer,
	cfgMotionResolved,
	cfgTuiMotion,
	cfgTuiSpinnerInterval,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

describe("tui.motion", () => {
	it("fills an unset spinner interval from the preset, keeps one the user set, and silences shimmer below full", () => {
		const settings = Settings.isolated();
		cfgDisplayShimmer.override(settings, "kitt");
		expect(cfgMotionResolved.get(settings)).toEqual({ spinnerInterval: 80, shimmer: "kitt", effects: true });

		cfgTuiMotion.override(settings, "none");
		expect(cfgMotionResolved.get(settings)).toEqual({ spinnerInterval: 0, shimmer: "disabled", effects: false });

		cfgTuiSpinnerInterval.override(settings, 80);
		cfgTuiMotion.override(settings, "reduced");
		expect(cfgMotionResolved.get(settings)).toEqual({ spinnerInterval: 80, shimmer: "disabled", effects: false });
	});

	describe("loaded from a config file", () => {
		let tempDir: TempDir;
		let configPath: string;
		const load = (config: unknown) =>
			Bun.write(configPath, YAML.stringify(config)).then(() =>
				Settings.loadIsolated({ inMemory: true, configFiles: [configPath] }),
			);

		beforeEach(() => {
			tempDir = TempDir.createSync("@pi-motion-");
			configPath = path.join(tempDir.path(), "overlay.yml");
		});

		afterEach(() => {
			tempDir.removeSync();
		});

		it("rejects out-of-range values", async () => {
			await expect(load({ tui: { spinnerInterval: 10 } })).rejects.toThrow("Spinner interval");
			await expect(load({ tui: { maxFps: 0 } })).rejects.toThrow("Max frames per second");
		});
	});
});

describe("--motion / --spinner-interval / --max-fps", () => {
	it("parse their values without consuming the prompt", () => {
		const parsed = parseArgs(["--motion", "NONE", "--spinner-interval", "0", "--max-fps", "4", "hello"]);
		expect(parsed.motion).toBe("none");
		expect(parsed.spinnerInterval).toBe(0);
		expect(parsed.maxFps).toBe(4);
		expect(parsed.messages).toEqual(["hello"]);
	});

	it("reject unknown modes and out-of-range values", () => {
		expect(() => parseArgs(["--motion", "quiet"])).toThrow("--motion");
		for (const value of ["fast", "2.5", "-1", "10"]) {
			expect(() => parseArgs(["--spinner-interval", value])).toThrow("--spinner-interval");
		}
		for (const value of ["0", "121", "2.5", "fast"]) {
			expect(() => parseArgs(["--max-fps", value])).toThrow("--max-fps");
		}
	});
});
