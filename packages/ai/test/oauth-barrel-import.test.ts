import { describe, expect, it } from "bun:test";

const STATIC_IMPORT_FIXTURE = `${import.meta.dir}/fixtures/oauth-barrel-import.ts`;

describe("OAuth barrel imports", () => {
	it("loads with the Anthropic provider and auth storage while preserving public exports", async () => {
		const child = Bun.spawn([process.execPath, STATIC_IMPORT_FIXTURE], {
			cwd: import.meta.dir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

		expect(exitCode, stderr).toBe(0);
	}, 60_000);
});
