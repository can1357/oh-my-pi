import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { MOTION_PRESETS, resolveMotion } from "@oh-my-pi/pi-coding-agent/config/motion-presets";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	cfgDisplayShimmer,
	cfgMotionResolved,
	cfgTuiMaxFps,
	cfgTuiMotion,
	cfgTuiSpinnerInterval,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { DEFAULT_MAX_FPS } from "@oh-my-pi/pi-tui/frame-rate";
import { DEFAULT_SPINNER_INTERVAL_MS } from "@oh-my-pi/pi-tui/spinner-clock";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

describe("tui.motion", () => {
	it("full is exactly the historical defaults", () => {
		expect(MOTION_PRESETS.full).toEqual({
			spinnerInterval: DEFAULT_SPINNER_INTERVAL_MS,
			maxFps: DEFAULT_MAX_FPS,
			shimmer: "classic",
			effects: true,
		});
		expect(resolveMotion("full", {})).toEqual(MOTION_PRESETS.full);
	});

	it("an explicitly set knob wins over the preset; unset knobs follow it", () => {
		// `none` would still the spinners, but the user asked for the default cadence explicitly:
		// the spinners animate while the ceiling, shimmer and effects still follow the preset.
		expect(resolveMotion("none", { spinnerInterval: DEFAULT_SPINNER_INTERVAL_MS })).toEqual({
			spinnerInterval: DEFAULT_SPINNER_INTERVAL_MS,
			maxFps: 4,
			shimmer: "disabled",
			effects: false,
		});
		expect(resolveMotion("reduced", { shimmer: "kitt", maxFps: 60 })).toEqual({
			spinnerInterval: 250,
			maxFps: 60,
			shimmer: "kitt",
			effects: false,
		});
	});

	it("resolves through the settings layer: preset first, explicit overrides win, live on change", () => {
		const settings = Settings.isolated();
		expect(cfgMotionResolved.get(settings)).toEqual(MOTION_PRESETS.full);

		cfgTuiMotion.override(settings, "none");
		expect(cfgMotionResolved.get(settings)).toEqual(MOTION_PRESETS.none);

		// Setting the spinner interval explicitly to the default value is still explicit: it beats
		// the preset's 0 while the ceiling keeps the preset's 4.
		cfgTuiSpinnerInterval.override(settings, DEFAULT_SPINNER_INTERVAL_MS);
		expect(cfgMotionResolved.get(settings)).toMatchObject({
			spinnerInterval: DEFAULT_SPINNER_INTERVAL_MS,
			maxFps: 4,
		});

		cfgDisplayShimmer.override(settings, "kitt");
		cfgTuiMaxFps.override(settings, 15);
		expect(cfgMotionResolved.get(settings)).toEqual({
			spinnerInterval: DEFAULT_SPINNER_INTERVAL_MS,
			maxFps: 15,
			shimmer: "kitt",
			effects: false,
		});

		// Back to `full`: the explicit knobs stay, effects return.
		cfgTuiMotion.override(settings, "full");
		expect(cfgMotionResolved.get(settings)).toEqual({
			spinnerInterval: DEFAULT_SPINNER_INTERVAL_MS,
			maxFps: 15,
			shimmer: "kitt",
			effects: true,
		});
	});

	it("notifies listeners when only a knob's provenance changes (explicit default under `none`)", async () => {
		// `Settings` used to notify on value changes alone; `80` set explicitly equals the default, so
		// the resolved spinner interval moved 0 → 80 with no event and the live clocks stayed static.
		const settings = Settings.isolated();
		cfgTuiMotion.override(settings, "none");
		const seen: number[] = [];
		const stop = cfgMotionResolved.listen(settings, motion => {
			seen.push(motion.spinnerInterval);
		});
		cfgTuiSpinnerInterval.override(settings, DEFAULT_SPINNER_INTERVAL_MS);
		await Bun.sleep(0);
		expect(seen).toEqual([DEFAULT_SPINNER_INTERVAL_MS]);
		cfgTuiSpinnerInterval.clearOverride(settings);
		await Bun.sleep(0);
		expect(seen).toEqual([DEFAULT_SPINNER_INTERVAL_MS, 0]);
		stop();
	});

	describe("loaded from disk", () => {
		let tempDir: TempDir;
		let agentDir: string;
		let cwd: string;

		beforeEach(() => {
			tempDir = TempDir.createSync("@pi-motion-");
			agentDir = tempDir.join("agent");
			cwd = tempDir.join("project");
			for (const dir of [agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
		});

		afterEach(() => {
			tempDir.removeSync();
		});

		it("loads an empty config as full motion and a configured preset with its values", async () => {
			expect(cfgMotionResolved.get(await Settings.loadIsolated({ cwd, agentDir }))).toEqual(MOTION_PRESETS.full);
			const configPath = path.join(agentDir, "config.yml");
			await Bun.write(configPath, YAML.stringify({ tui: { motion: "reduced", maxFps: 60 } }));
			expect(cfgMotionResolved.get(await Settings.loadIsolated({ cwd, agentDir }))).toEqual({
				spinnerInterval: 250,
				maxFps: 60,
				shimmer: "disabled",
				effects: false,
			});
			await Bun.write(configPath, YAML.stringify({ tui: { maxFps: 0 } }));
			await expect(Settings.loadIsolated({ cwd, agentDir })).rejects.toThrow("Max frames per second");
		});

		it("rejects quoted numbers instead of reading them as an explicit default", async () => {
			// A number-typed setting reads a string as its default, and the preset would then treat
			// that default as an explicit override: `spinnerInterval: "250"` under `none` animated at 80.
			const configPath = path.join(agentDir, "config.yml");
			await Bun.write(configPath, YAML.stringify({ tui: { motion: "none", spinnerInterval: "250" } }));
			await expect(Settings.loadIsolated({ cwd, agentDir })).rejects.toThrow("tui.spinnerInterval must be a number");
			await Bun.write(configPath, YAML.stringify({ tui: { maxFps: "15" } }));
			await expect(Settings.loadIsolated({ cwd, agentDir })).rejects.toThrow("tui.maxFps must be a number");
		});
	});
});

describe("--motion / --shimmer / --max-fps flags", () => {
	it("parse their modes and values without consuming the prompt", () => {
		const parsed = parseArgs(["--motion", "reduced", "--shimmer", "disabled", "--max-fps", "4", "hello"]);
		expect(parsed.motion).toBe("reduced");
		expect(parsed.shimmer).toBe("disabled");
		expect(parsed.maxFps).toBe(4);
		expect(parsed.messages).toEqual(["hello"]);
		expect(parseArgs(["--motion=NONE"]).motion).toBe("none");
	});

	it("reject unknown modes and out-of-range ceilings", () => {
		expect(() => parseArgs(["--motion", "quiet"])).toThrow("--motion");
		expect(() => parseArgs(["--shimmer", "sparkle"])).toThrow("--shimmer");
		for (const value of ["0", "121", "2.5", "fast"]) {
			expect(() => parseArgs(["--max-fps", value])).toThrow("--max-fps");
		}
	});
});
