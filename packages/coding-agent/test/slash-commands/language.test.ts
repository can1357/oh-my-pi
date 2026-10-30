import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractiveModeContext } from "../../src/modes/types";
import { executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";

const originalLanguage = process.env.OMP_LANG;
afterEach(() => {
	if (originalLanguage === undefined) delete process.env.OMP_LANG;
	else process.env.OMP_LANG = originalLanguage;
});

describe("/language", () => {
	it("switches both directions through a fresh CLI locale initialization", async () => {
		const directory = mkdtempSync(join(tmpdir(), "omp-language-command-"));
		try {
			writeFileSync(join(directory, "ko.json"), JSON.stringify({ Ready: "준비됨" }));
			const moduleUrl = new URL("../../../utils/src/i18n.ts", import.meta.url).href;
			const labels: string[] = [];
			const runtime = {
				ctx: {
					editor: { setText() {} },
					async restart() {
						const child = Bun.spawnSync(
							[
								process.execPath,
								"-e",
								`import { initializeI18n, t } from ${JSON.stringify(moduleUrl)}; await initializeI18n(); console.log(t("Ready"));`,
							],
							{ env: { ...process.env, OMP_LOCALE_DIR: directory, PI_COMPILED: undefined } },
						);
						expect(child.exitCode).toBe(0);
						labels.push(child.stdout.toString().trim());
					},
				} as unknown as InteractiveModeContext,
			};
			process.env.OMP_LANG = "en";
			expect(await executeBuiltinSlashCommand("/language ko", runtime)).toBe(true);
			expect(await executeBuiltinSlashCommand("/language en", runtime)).toBe(true);
			expect(labels).toEqual(["준비됨", "Ready"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects missing, unsupported and extra arguments without changing language or restarting", async () => {
		process.env.OMP_LANG = "ko";
		let restarts = 0;
		const warnings: string[] = [];
		const runtime = {
			ctx: {
				showWarning: (message: string) => warnings.push(message),
				restart: async () => {
					restarts++;
				},
			} as unknown as InteractiveModeContext,
		};
		for (const text of ["/language", "/language fr", "/language ko extra"]) {
			expect(await executeBuiltinSlashCommand(text, runtime)).toBe(true);
			expect(process.env.OMP_LANG).toBe("ko");
		}
		expect(restarts).toBe(0);
		expect(warnings).toHaveLength(3);
	});
});
