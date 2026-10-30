import { expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");

it("renders selected-language command descriptions after the registry was imported before initialization", () => {
	const script = `
import { commands } from "./packages/coding-agent/src/cli-commands.ts";
import { run } from "@oh-my-pi/pi-utils/cli";
import { initializeI18n } from "@oh-my-pi/pi-utils/i18n";
await initializeI18n();
await run({bin: "omp", version: "test", argv: ["--help"], commands: commands.filter(command => command.name !== "launch")});`;
	for (const language of [undefined, "ko"]) {
		const child = Bun.spawnSync([process.execPath, "-e", script], {
			cwd: repoRoot,
			env: { ...process.env, OMP_LANG: language, OMP_LOCALE_DIR: undefined, PI_COMPILED: undefined },
		});
		expect(child.exitCode, child.stderr.toString()).toBe(0);
		expect(child.stderr.toString()).toBe("");
		const help = child.stdout.toString();
		if (language === "ko") {
			expect(help).toContain("기본 제공 작업 에이전트 관리");
			expect(help).toContain("사용량 통계 조회");
			expect(help).not.toContain("Manage bundled task agents");
		} else {
			expect(help).toContain("Manage bundled task agents");
			expect(help).toContain("View usage statistics");
			expect(help).not.toMatch(/[가-힣]/u);
		}
	}
});
