import { expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

test("model picker opens and dismisses after compatibility plugins initialize", async () => {
	using tempDir = TempDir.createSync("model-picker-compat-");
	const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/model-picker-compat-probe.ts")], {
		cwd: path.join(import.meta.dir, "../../.."),
		env: { ...process.env, PI_CODING_AGENT_DIR: tempDir.path() },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	expect(stdout).toBe("picker opened and dismissed\n");
});
