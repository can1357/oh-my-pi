import { expect, test } from "bun:test";
import * as path from "node:path";

interface ProbeResult {
	toolCount: number;
	mcpTools: number;
	adapters: number;
}

const probePath = path.join(import.meta.dir, "fixtures", "mcp-refresh-retention-probe.ts");

test("MCP refresh releases obsolete tool wrapper generations", async () => {
	const proc = Bun.spawn([process.execPath, probePath], {
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
	const result = JSON.parse(stdout) as ProbeResult;
	expect(result.mcpTools).toBe(result.toolCount);
	expect(result.adapters).toBe(result.toolCount);
}, 30_000);
