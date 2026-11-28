/**
 * #20158: `-e`/`--extension <path>` disabled the speculative first frame, so the terminal capability
 * queries became the first output and a slow kitty keyboard reply landed after the alternate screen.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scanPrepaintArgv } from "../src/cli/prepaint";
import { overlaysKeepPrepaint } from "../src/modes/startup-composer";

describe("scanPrepaintArgv", () => {
	test("an extension path, in either spelling, keeps the first frame", () => {
		expect(scanPrepaintArgv(["-e", "empty.ts", "--no-session"]).safe).toBe(true);
		expect(scanPrepaintArgv(["--extension", "./ext/index.ts"]).safe).toBe(true);
		expect(scanPrepaintArgv(["--extension=empty.ts"]).safe).toBe(true);
	});

	test("an extension path does not hide an unsafe flag after it", () => {
		expect(scanPrepaintArgv(["-e", "empty.ts", "-p", "hello"]).safe).toBe(false);
		expect(scanPrepaintArgv(["--model", "gpt-5"]).safe).toBe(false);
	});

	test("--config values go to the overlay check instead of skipping the frame", () => {
		expect(scanPrepaintArgv(["--config", "a.yml", "--config=b.yml", "--no-lsp"])).toEqual({
			mode: "on",
			safe: true,
			overlays: ["a.yml", "b.yml"],
		});
	});

	test("--prepaint picks the mode: the last one wins, and a missing or bad value paints nothing", () => {
		expect(scanPrepaintArgv(["--prepaint", "force", "-p", "hi"])).toMatchObject({ mode: "force", safe: false });
		expect(scanPrepaintArgv(["--prepaint=force", "--prepaint=off"]).mode).toBe("off");
		expect(scanPrepaintArgv(["--prepaint=sometimes"]).mode).toBe("off");
		expect(scanPrepaintArgv(["--prepaint"]).mode).toBe("off");
	});
});

describe("overlaysKeepPrepaint", () => {
	const savedConfigFiles = process.env.PI_CONFIG_FILES;
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prepaint-overlay-"));
		delete process.env.PI_CONFIG_FILES;
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
		if (savedConfigFiles === undefined) delete process.env.PI_CONFIG_FILES;
		else process.env.PI_CONFIG_FILES = savedConfigFiles;
	});

	async function overlay(name: string, yaml: string): Promise<string> {
		const file = path.join(dir, name);
		await Bun.write(file, yaml);
		return file;
	}

	test("settings the frame does not draw keep it, even beside prepaint settings of the same group", async () => {
		const file = await overlay("other.yml", "tui:\n  maxFps: 60\nlsp:\n  diagnosticsOnWrite: false\n");
		expect(await overlaysKeepPrepaint([file])).toBe(true);
	});

	test("a prepaint setting skips the frame, nested or as a legacy group scalar", async () => {
		expect(await overlaysKeepPrepaint([await overlay("screen.yml", "tui:\n  screen: fullscreen\n")])).toBe(false);
		expect(await overlaysKeepPrepaint([await overlay("theme.yml", "theme: my-custom-theme\n")])).toBe(false);
	});

	test("PI_CONFIG_FILES overlays count like --config ones", async () => {
		process.env.PI_CONFIG_FILES = await overlay("env.yml", "startup:\n  quiet: true\n");
		expect(await overlaysKeepPrepaint([])).toBe(false);
	});

	test("a missing overlay skips the frame so its error prints on a clean terminal", async () => {
		expect(await overlaysKeepPrepaint([path.join(dir, "missing.yml")])).toBe(false);
	});
});
