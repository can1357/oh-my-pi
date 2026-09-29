import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initTheme, setExtensionThemes, setTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { getBuiltinThemes } from "@oh-my-pi/pi-tui/theme/loader";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Contract: a reload that re-registers an extension theme whose file changed on disk
 * re-applies the active theme from the new contents — whether the user picked it or
 * auto-detection resolved to it. Without this, the old colors stay until a restart.
 */
describe("extension theme refresh on re-registration", () => {
	const owner = {};
	const dirs: string[] = [];

	afterEach(async () => {
		await setExtensionThemes(owner, []);
		await setTheme("dark");
		for (const dir of dirs.splice(0)) removeSyncWithRetries(dir);
	});

	function writeTheme(accent: string): { name: string; path: string } {
		const dir = path.join(os.tmpdir(), `omp-ext-theme-${Snowflake.next()}`);
		dirs.push(dir);
		const name = `ext-refresh-${Snowflake.next()}`;
		const filePath = path.join(dir, `${name}.json`);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(filePath, themeJson(accent));
		return { name, path: filePath };
	}

	function themeJson(accent: string): string {
		const dark = getBuiltinThemes().dark;
		return JSON.stringify({ ...dark, colors: { ...dark.colors, accent } });
	}

	it("reloads a manually selected extension theme whose file changed", async () => {
		const contributed = writeTheme("#ff0000");
		await setExtensionThemes(owner, [contributed]);
		expect((await setTheme(contributed.name)).success).toBe(true);
		const before = theme.fg("accent", "x");

		fs.writeFileSync(contributed.path, themeJson("#00ff00"));
		await setExtensionThemes(owner, [contributed]);

		expect(theme.fg("accent", "x")).not.toBe(before);
	});

	it("reloads an auto-detected extension theme whose file changed", async () => {
		const contributed = writeTheme("#ff0000");
		await setExtensionThemes(owner, [contributed]);
		await initTheme(false, undefined, undefined, contributed.name, contributed.name);
		const before = theme.fg("accent", "x");

		fs.writeFileSync(contributed.path, themeJson("#00ff00"));
		await setExtensionThemes(owner, [contributed]);

		expect(theme.fg("accent", "x")).not.toBe(before);
	});
});
