import { expect, test } from "bun:test";
import * as path from "node:path";

interface ProbeResult {
	toolCount: number;
	mcpTools: number;
	adapters: number;
}

const probePath = path.join(import.meta.dir, "fixtures", "mcp-refresh-retention-probe.ts");

// A single `Bun.gc(true)` before the heap snapshot may retain one obsolete
// MCPTool generation through JSC's conservative stack scan (issue #11976).
// A real leak (the pre-#11784 bug) retained every refresh generation, so bound
// MCPTool to the current generation plus at most one stale generation. Adapters
// do not show that conservative-GC residue and remain exact.

async function runProbe(): Promise<ProbeResult> {
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
	return JSON.parse(stdout) as ProbeResult;
}

test("MCP refresh releases obsolete tool wrapper generations", async () => {
	const result = await runProbe();
	expect(result.mcpTools).toBeGreaterThanOrEqual(result.toolCount);
	expect(result.mcpTools).toBeLessThanOrEqual(result.toolCount * 2);
	expect(result.adapters).toBe(result.toolCount);
}, 60_000);
