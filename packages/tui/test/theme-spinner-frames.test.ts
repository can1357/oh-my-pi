import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_SPINNER_INTERVAL_MS,
	setSpinnerInterval,
	sharedSpinnerFrame,
	SPINNER_INTERVAL_STATIC,
} from "@oh-my-pi/pi-tui/spinner-clock";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { getConfigRootDir, getCustomThemesDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

// Path of the built-in dark theme JSON, used as a known-valid base we can
// extend with custom `symbols.spinnerFrames` shapes.
const DARK_THEME_PATH = path.join(import.meta.dir, "..", "src", "theme", "dark.json");

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

let tmpAgentDir: string;

async function writeCustomTheme(name: string, extraSymbols: Record<string, unknown>): Promise<void> {
	const dark = (await Bun.file(DARK_THEME_PATH).json()) as Record<string, unknown>;
	const base = (dark.symbols ?? {}) as Record<string, unknown>;
	const themeJson = {
		...dark,
		name,
		symbols: { ...base, ...extraSymbols },
	};
	const themesDir = getCustomThemesDir();
	await fs.mkdir(themesDir, { recursive: true });
	await Bun.write(path.join(themesDir, `${name}.json`), JSON.stringify(themeJson, null, 2));
}

describe("theme symbols.spinnerFrames", () => {
	beforeEach(async () => {
		tmpAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spinner-frames-"));
		setAgentDir(tmpAgentDir);
	});

	afterEach(async () => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await removeWithRetries(tmpAgentDir);
	});

	it("flat-array override applies to both status and activity spinners", async () => {
		const frames = ["◐", "◓", "◑", "◒"];
		await writeCustomTheme("custom-flat", { spinnerFrames: frames });

		const theme = await getThemeByName("custom-flat");
		expect(theme).toBeDefined();
		expect(theme!.getSpinnerFrames("status")).toEqual(frames);
		expect(theme!.getSpinnerFrames("activity")).toEqual(frames);
		// Default getter is the status spinner.
		expect(theme!.spinnerFrames).toEqual(frames);
	});

	it("object override sets each spinner type independently and falls back to preset", async () => {
		const statusFrames = ["A", "B", "C"];
		// `unicode` preset's activity frames — the default we expect to surface
		// when only `status` is overridden.
		const presetActivity = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		await writeCustomTheme("custom-status-only", { spinnerFrames: { status: statusFrames } });

		const theme = await getThemeByName("custom-status-only");
		expect(theme).toBeDefined();
		expect(theme!.getSpinnerFrames("status")).toEqual(statusFrames);
		expect(theme!.getSpinnerFrames("activity")).toEqual(presetActivity);
	});

	it("rejects empty arrays and empty objects at validation time", async () => {
		await writeCustomTheme("custom-empty-array", { spinnerFrames: [] });
		await expect(getThemeByName("custom-empty-array")).resolves.toBeUndefined();

		await writeCustomTheme("custom-empty-object", { spinnerFrames: {} });
		await expect(getThemeByName("custom-empty-object")).resolves.toBeUndefined();
	});

	it("derives live tool spinner frames from the shared clock at its live interval", () => {
		const frameCount = 4;
		const now = DEFAULT_SPINNER_INTERVAL_MS * 3 + 12;

		expect(sharedSpinnerFrame(frameCount, now + DEFAULT_SPINNER_INTERVAL_MS)).toBe(
			(sharedSpinnerFrame(frameCount, now) + 1) % frameCount,
		);
		expect(sharedSpinnerFrame(frameCount, DEFAULT_SPINNER_INTERVAL_MS * frameCount)).toBe(0);
		expect(sharedSpinnerFrame(0, now)).toBe(0);

		try {
			// A slower interval advances once per new period; a static one is frame 0 at any time.
			setSpinnerInterval(1000);
			expect(sharedSpinnerFrame(frameCount, 2999)).toBe(2);
			expect(sharedSpinnerFrame(frameCount, 3000)).toBe(3);
			setSpinnerInterval(SPINNER_INTERVAL_STATIC);
			expect(sharedSpinnerFrame(frameCount, 12_345)).toBe(0);
		} finally {
			setSpinnerInterval(DEFAULT_SPINNER_INTERVAL_MS);
		}
	});
});
