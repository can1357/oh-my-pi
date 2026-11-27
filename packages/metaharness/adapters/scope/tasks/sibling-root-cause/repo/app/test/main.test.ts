import { expect, test } from "bun:test";
import * as path from "node:path";

const cases: Array<[value: string, expected: number]> = [
	["90s", 90_000],
	["1h", 3_600_000],
	["250ms", 250],
];

test("honours DEPLOY_TIMEOUT", async () => {
	for (const [value, expected] of cases) {
		const proc = Bun.spawn(["bun", "src/main.ts"], {
			cwd: path.join(import.meta.dir, ".."),
			env: { ...process.env, DEPLOY_TIMEOUT: value },
			stdout: "pipe",
		});
		expect(await new Response(proc.stdout).text()).toBe(`deploy timeout: ${expected}ms\n`);
	}
});
