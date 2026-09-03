import { expect, test } from "bun:test";
import * as path from "node:path";

const preloadPath = path.join(import.meta.dir, "fixtures", "computer-schema-construction-preload.ts");
const probePath = path.join(import.meta.dir, "fixtures", "computer-schema-construction-probe.ts");

test("computer schema is constructed once on first parameters access", async () => {
	const proc = Bun.spawn([process.execPath, "--preload", preloadPath, probePath], {
		cwd: path.join(import.meta.dir, "../../.."),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	expect(exitCode, stderr).toBe(0);
	expect(JSON.parse(stdout)).toEqual({
		counts: {
			afterModuleImport: 0,
			afterDefaultOffFactory: 0,
			afterToolConstruction: 0,
			afterFirstParametersAccess: 1,
			afterRepeatedParametersAccess: 1,
			afterSecondToolParametersAccess: 1,
			afterValidation: 1,
		},
		disabledToolCount: 0,
		schema: {
			callable: true,
			repeatedIdentity: true,
			crossToolIdentity: true,
			validAccepted: true,
			validOutput: {
				code: "const windows = await desktop.windows(); windows.length",
				read_only: true,
				timeout: 10,
			},
			invalidRejected: [true, true, true, true, true, true],
		},
	});
}, 20_000);
