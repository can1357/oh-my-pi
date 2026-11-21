import { expect, it } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";

const fixture = path.join(import.meta.dir, "fixtures/cost-gate-skill-description.ts");

async function run(mode: "supplied" | "root" | "metered" | "queued"): Promise<{ calls: number; spent: number }> {
	// The fixture must run outside the test runtime, which the CI runner marks on every child via PI_TEST_RUNTIME.
	const result = await $`${process.execPath} ${fixture} ${mode}`
		.env({ ...process.env, PI_TEST_RUNTIME: undefined })
		.quiet()
		.nothrow();
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return JSON.parse(result.stdout.toString());
}

it("refuses startup skill compression when the supplied session-tree gate is exhausted", async () => {
	expect(await run("supplied")).toEqual({ calls: 0, spent: 1 });
});

it("refuses startup skill compression when the root gate starts at the cap", async () => {
	expect(await run("root")).toEqual({ calls: 0, spent: 1 });
});

it("meters completed background skill compression against the session tree", async () => {
	expect(await run("metered")).toEqual({ calls: 1, spent: 1.25 });
});

it("refuses queued skill compression on a non-fetch provider when another request reaches the cap", async () => {
	expect(await run("queued")).toEqual({ calls: 1, spent: 1 });
});
