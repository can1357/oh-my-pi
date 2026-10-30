import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parseStandaloneStatsArgs } from "../src/index";
import { formatStatsDashboardUrl } from "../src/server";

describe("standalone stats CLI", () => {
	it("keeps the production parser loopback-only by default", () => {
		expect(parseStandaloneStatsArgs([])).toEqual({
			port: 3847,
			host: "127.0.0.1",
			json: false,
			sync: false,
			help: false,
		});
	});

	it("forwards explicit bind hosts and formats IPv6 dashboard URLs", () => {
		expect(parseStandaloneStatsArgs(["--host", "::", "--port", "3850"])).toMatchObject({
			port: 3850,
			host: "::",
		});
		expect(formatStatsDashboardUrl("::", 3850)).toBe("http://[::]:3850");
		expect(formatStatsDashboardUrl("2001:db8::1", 3850)).toBe("http://[2001:db8::1]:3850");
	});

	it("keeps the incompatible upstream stats bundle in English even when Korean is selected", () => {
		const entry = path.resolve(import.meta.dir, "../src/index.ts");
		let english: string | undefined;
		for (const language of [undefined, "ko"]) {
			const child = Bun.spawnSync([process.execPath, entry, "--help"], {
				env: { ...process.env, OMP_LANG: language, OMP_LOCALE_DIR: undefined, PI_COMPILED: undefined },
			});
			expect(child.exitCode, child.stderr.toString()).toBe(0);
			expect(child.stderr.toString()).toBe("");
			const help = child.stdout.toString();
			expect(help).toContain("omp-stats - AI Usage Statistics Dashboard");
			if (language === undefined) english = help;
			else expect(help).toBe(english);
		}
	});

	it("keeps import inert even when Korean selects an unreadable pack", () => {
		const entry = new URL("../src/index.ts", import.meta.url).href;
		const i18n = new URL("../../utils/src/i18n.ts", import.meta.url).href;
		const child = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				`import {parseStandaloneStatsArgs} from ${JSON.stringify(entry)}; import {getLanguage} from ${JSON.stringify(i18n)}; console.log(JSON.stringify({language:getLanguage(),help:parseStandaloneStatsArgs(["--help"]).help}));`,
			],
			{
				env: { ...process.env, OMP_LANG: "ko", OMP_LOCALE_DIR: "UNREAD_STATS_LOCALE_PATH", PI_COMPILED: undefined },
			},
		);
		expect(child.exitCode, child.stderr.toString()).toBe(0);
		expect(child.stderr.toString()).toBe("");
		expect(JSON.parse(child.stdout.toString())).toEqual({ language: "en", help: true });
	});
});
