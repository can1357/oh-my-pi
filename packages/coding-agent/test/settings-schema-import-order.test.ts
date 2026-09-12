import { expect, it } from "bun:test";

it("loads the schema first in a fresh module graph", async () => {
	const schemaUrl = new URL("../src/config/settings-schema.ts", import.meta.url).href;
	const script = `import { SETTINGS_SCHEMA } from ${JSON.stringify(schemaUrl)}; process.stdout.write(JSON.stringify({ count: Object.keys(SETTINGS_SCHEMA).length, backend: SETTINGS_SCHEMA["stt.backend"]?.default }));`;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);

	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	expect(JSON.parse(stdout)).toEqual({ count: expect.any(Number), backend: "local" });
}, 15_000);
